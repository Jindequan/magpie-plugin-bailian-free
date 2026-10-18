import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import {
  BailianFreeAuthPlugin,
  _internal,
} from "./index.mjs"
import {
  unwrapCliReply,
  parseAmount,
  parseFreeQuota,
  parseModelList,
  readFreeQuota,
  changedError,
} from "./console.mjs"
import { readBailianCLIProfile } from "./bl.mjs"
import { startConsoleLogin } from "./login.mjs"
import { fmtAmount, grantWindow, freeQuotaNote, configModels } from "./models.mjs"

const fixture = (name) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")

let server = null
let tempDir = null

afterEach(() => {
  server?.stop?.(true)
  server = null
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  delete process.env.BAILIAN_CONSOLE_GATEWAY
  delete process.env.BAILIAN_DASHSCOPE_NATIVE
  delete process.env.BAILIAN_CONFIG_DIR
  _internal.resetGrantsCache()
  _internal.resetKeyAttempt()
  resetCatalogCache()
})

// A fake console gateway that serves the wire fixtures the way the real
// one answers the CLI.
function startConsole(calls) {
  const seen = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname !== "/cli/api.json") return new Response("not found", { status: 404 })
      const form = new URLSearchParams(await req.text())
      const params = JSON.parse(form.get("params"))
      seen.push({
        api: u.searchParams.get("api"),
        apiField: params.Api,
        region: form.get("region"),
        bearer: req.headers.get("authorization"),
        cornerstone: params.Data?.cornerstoneParam?.consoleSite,
        pageNo: params.Data?.input?.pageNo,
        reqDTO: params.Data?.reqDTO,
      })
      const reply = calls[params.Api]?.(params, u)
      if (reply === undefined) return new Response("no fixture", { status: 500 })
      return new Response(reply, { headers: { "Content-Type": "application/json" } })
    },
  })
  return { url: server.url, seen }
}

// ---- CLI gateway reply unwrapping -------------------------------------------

test("unwrapCliReply unwraps the call's own data", () => {
  const inner = unwrapCliReply(fixture("free-quota.json"))
  expect(inner.freeTierQuotas.length).toBe(4)
})

test("unwrapCliReply refuses a signed-out token", () => {
  try {
    unwrapCliReply(fixture("not-logged-in.json"))
    throw new Error("should have thrown")
  } catch (e) {
    expect(e.signIn).toBe("expired")
  }
})

test("unwrapCliReply carries the gateway's own error", () => {
  try {
    unwrapCliReply(JSON.stringify({ data: { success: false, errorCode: "Boom", errorMsg: "it broke" } }))
    throw new Error("should have thrown")
  } catch (e) {
    expect(e.message).toContain("it broke")
  }
})

test("unwrapCliReply rejects a reply that isn't the gateway's", () => {
  expect(() => unwrapCliReply("not json")).toThrow()
  try {
    unwrapCliReply(JSON.stringify({ data: { success: true, DataV2: { data: { success: false, errorMsg: "inner" } } } }))
    throw new Error("should have thrown")
  } catch (e) {
    expect(e.message).toContain("inner")
  }
})

// ---- amounts ----------------------------------------------------------------

test("parseAmount takes numbers, strings and commas; refuses garbage", () => {
  expect(parseAmount(820000)).toBe(820000)
  expect(parseAmount("1,234.50")).toBe(1234.5)
  expect(parseAmount(undefined)).toBe(0)
  expect(parseAmount(null)).toBe(0)
  expect(() => parseAmount("abc")).toThrow()
  expect(changedError().changed).toBe(true)
})

// ---- model list and free quota ----------------------------------------------

test("parseModelList flattens parents and items", () => {
  const inner = unwrapCliReply(fixture("models-page1.json"))
  const { total, models } = parseModelList(inner)
  expect(total).toBe(51)
  expect(models.map((m) => m.model)).toEqual(["kimi-k3", "qwen-image", "qwen-image-2.1-pro"])
})

test("parseFreeQuota keeps room-left grants soonest-ending first", () => {
  const caps = { "kimi-k3": ["TG"], "qwen-image-2.1-pro": ["IG"], "old-model": ["TG"], "qwen-image": ["IG"] }
  const { grants, gone } = parseFreeQuota(
    unwrapCliReply(fixture("free-quota.json")),
    (m) => caps[m] ?? [],
    1_790_000_000_000,
  )
  expect(gone).toBe(1) // old-model is expired; qwen-image's limit is 0, not a grant
  expect(grants.length).toBe(2)
  expect(grants[0]).toEqual({
    model: "kimi-k3",
    media: "text",
    unit: "tokens",
    left: 820000,
    limit: 1000000,
    ends: 1794873600000,
  })
  expect(grants[1]).toEqual({
    model: "qwen-image-2.1-pro",
    media: "image",
    unit: "images",
    left: 10,
    limit: 10,
    ends: 1798732800000,
  })
})

test("readFreeQuota pages the model list and asks each model's quota", async () => {
  const { url, seen } = startConsole({
    "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels": (params) =>
      params.Data.input.pageNo === 1 ? fixture("models-page1.json") : fixture("models-page2.json"),
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("free-quota.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const { grants, gone } = await readFreeQuota({ token: "tok" })
  expect(gone).toBe(1)
  expect(grants.map((g) => g.model)).toEqual(["kimi-k3", "qwen-image-2.1-pro"])
  expect(seen.length).toBe(3) // two pages, then the quota
  for (const c of seen) {
    expect(c.bearer).toBe("Bearer tok")
    expect(c.region).toBe("cn-beijing")
    expect(c.cornerstone).toBe("BAILIAN_ALIYUN")
    expect(c.api).toBe(c.apiField)
  }
  expect(seen[0].pageNo).toBe(1)
  expect(seen[1].pageNo).toBe(2)
})

test("readFreeQuota surfaces a refused token", async () => {
  const { url } = startConsole({
    "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels": () => fixture("not-logged-in.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  try {
    await readFreeQuota({ token: "tok" })
    throw new Error("should have thrown")
  } catch (e) {
    expect(e.signIn).toBe("expired")
  }
})

// ---- bl profile --------------------------------------------------------------

test("readBailianCLIProfile reads the default profile and the active one", () => {
  tempDir = mkdtempSync(join(tmpdir(), "bl-"))
  process.env.BAILIAN_CONFIG_DIR = tempDir
  writeFileSync(
    join(tempDir, "config.json"),
    JSON.stringify({ access_token: "top", console_region: "cn-hangzhou", api_key: "sk-1" }),
  )
  expect(readBailianCLIProfile()).toEqual({ token: "top", site: "", region: "cn-hangzhou", apiKey: "sk-1" })

  writeFileSync(
    join(tempDir, "config.json"),
    JSON.stringify({
      access_token: "top",
      active_config: "intl",
      intl: { access_token: "tip", console_site: "international" },
    }),
  )
  expect(readBailianCLIProfile()).toEqual({ token: "tip", site: "international", region: "", apiKey: "" })

  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ active_config: "gone" }))
  expect(readBailianCLIProfile()).toBe(null)
})

// ---- loopback console-login ---------------------------------------------------

test("startConsoleLogin takes the page's hand-back on the right state only", async () => {
  const login = await startConsoleLogin()
  login.done.catch(() => {})
  expect(login.url).toMatch(/^https:\/\/bailian\.console\.aliyun\.com\/console-login\?notice=127\.0\.0\.1:\d+\?state=[0-9a-f]{32}$/)

  const base = `http://127.0.0.1:${login.port}`
  const wrong = await fetch(`${base}/?state=wrong&access_token=nope`)
  expect(wrong.status).toBe(400)

  const preflight = await fetch(base, { method: "OPTIONS" })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
  expect(preflight.headers.get("access-control-allow-private-network")).toBe("true")

  const ok = await fetch(`${base}/?state=${login.url.split("state=")[1]}&access_token=abc&console_region=cn-beijing`)
  expect(ok.status).toBe(200)
  await expect(login.done).resolves.toEqual({ token: "abc", region: "cn-beijing" })

  const json = await startConsoleLogin()
  json.done.catch(() => {})
  const posted = await fetch(`http://127.0.0.1:${json.port}/?state=${json.url.split("state=")[1]}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "xyz", data: { console_site: "international" } }),
  })
  expect(posted.status).toBe(200)
  await expect(json.done).resolves.toEqual({ token: "xyz", site: "international" })

  await login.close()
  await json.close()
})

// ---- windows and notes ---------------------------------------------------------

test("grantWindow scopes a text grant to its model and marks the rest aside", () => {
  const text = grantWindow({ model: "kimi-k3", media: "text", unit: "tokens", left: 820000, limit: 1000000, ends: 1794873600000 })
  expect(text.models).toEqual(["kimi-k3"])
  expect(text.aside).toBeUndefined()
  expect(text.used).toBeCloseTo(18)
  expect(text.display).toBe("82万 / 100万 tokens")
  expect(text.amount).toBe(180000)
  expect(text.runsOutAt).toBe(new Date(1794873600000).toISOString())
  expect(text.runsOut).toBe(820000)

  const image = grantWindow({ model: "qwen-image-2.1-pro", media: "image", unit: "images", left: 10, limit: 10, ends: 0 })
  expect(image.models).toEqual(["qwen-image-2.1-pro"]) // the images API serves it
  expect(image.aside).toBeUndefined()
  const speech = grantWindow({ model: "sambert-beth-v1", media: "speech", unit: "units", left: 3, limit: 3, ends: 0 })
  expect(speech.aside).toBe(true) // no channel for speech
  expect(image.display).toBe("10 / 10 images")
  expect(image.runsOutAt).toBeUndefined()
})

test("fmtAmount and freeQuotaNote read the way the console does", () => {
  expect(fmtAmount(820000)).toBe("82万")
  expect(fmtAmount(120000000)).toBe("1.2亿")
  expect(fmtAmount(1234.5)).toBe("1234.5")
  expect(freeQuotaNote(0, 0)).toBe("没有模型还有免费额度")
  expect(freeQuotaNote(2, 0)).toBe("2 个模型有免费额度")
  expect(freeQuotaNote(2, 3)).toBe("2 个模型有免费额度 · 3 个已用完或过期")
})

// ---- the plugin ----------------------------------------------------------------

const stubClient = { auth: { set: async () => {} } }

async function hooks() {
  return BailianFreeAuthPlugin({ client: stubClient })
}

test("config declares the provider with models; auth has two sign-ins", async () => {
  const h = await hooks()
  const cfg = { provider: {} }
  await h.config(cfg)
  const p = cfg.provider["bailian-free"]
  expect(p.name).toBe("百炼免费额度")
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.api).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")
  expect(Object.keys(p.models).length).toBeGreaterThan(0)
  expect(configModels()["kimi-k3"].free).toBe(true)

  expect(h.auth.provider).toBe("bailian-free")
  expect(h.auth.methods.length).toBe(2)
  expect(h.auth.methods.map((m) => m.type)).toEqual(["oauth", "oauth"])
  expect(h.auth.methods[0].prompts[0].key).toBe("apiKey")
})

test("usage lists the grants as windows from the console", async () => {
  const { url } = startConsole({
    "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels": (params) =>
      params.Data.input.pageNo === 1 ? fixture("models-page1.json") : fixture("models-page2.json"),
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("free-quota.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const usage = await h.auth.usage(async () => ({ type: "oauth", token: "tok", source: "browser", accountId: "测试账号" }))
  expect(usage.plan).toBe("新用户免费额度")
  expect(usage.user).toBe("测试账号")
  expect(usage.balance).toBe("2 项免费额度：对话 1 · 画图 1 · 另有 1 项已用完或过期")
  expect(usage.windows.length).toBe(2)
  expect(usage.windows[0].name).toBe("kimi-k3")
  expect(usage.windows[0].display).toBe("82万 / 100万 tokens")
})

test("usage without a sign-in says so; provider.models stands in when the console can't be read", async () => {
  const h = await hooks()
  const none = await h.auth.usage(async () => ({ type: "oauth" }))
  expect(none.error).toBe("not signed in")

  // no gateway override and no cached catalog: the bootstrap config list stands in
  const models = await h.provider.models(
    { id: "bailian-free", models: configModels() },
    { auth: { type: "oauth" } },
  )
  expect(Object.keys(models)).toContain("kimi-k3")
})

test("loader sends with the DashScope key and says what is missing", async () => {
  const refuse = startConsole({
    "zeldaEasy.bailian-dash-workspace.api-key.createApiKeyV4": () => fixture("not-logged-in.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = refuse.url
  let dashscope = null
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      dashscope = { auth: req.headers.get("authorization"), path: new URL(req.url).pathname }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    },
  })
  const h = await hooks()

  const missing = await h.auth.loader(async () => ({ type: "oauth", token: "tok", apiKey: "" }))
  const refused = await missing.fetch("http://127.0.0.1:1/v1/chat/completions", { method: "POST" })
  expect(refused.status).toBe(401)
  expect(refused.headers.get("x-magpie-sign-in")).toBe("expired")

  const withKey = await h.auth.loader(async () => ({ type: "oauth", token: "tok", apiKey: "sk-live" }))
  expect(withKey.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")
  const res = await withKey.fetch(`${server.url}/chat/completions`, { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(dashscope.auth).toBe("Bearer sk-live")
})

test("currentCreds re-reads bl's file each time", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "bl-"))
  process.env.BAILIAN_CONFIG_DIR = tempDir
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ access_token: "one" }))
  const first = await _internal.currentCreds({ source: "bl" })
  expect(first.token).toBe("one")

  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ access_token: "two" }))
  const second = await _internal.currentCreds({ source: "bl" })
  expect(second.token).toBe("two")

  rmSync(join(tempDir, "config.json"))
  try {
    await _internal.currentCreds({ source: "bl" })
    throw new Error("should have thrown")
  } catch (e) {
    expect(e.signIn).toBe("expired")
    expect(e.message).toContain("bl login")
  }
})

// ---- sign-in verifies the token against the free-quota API --------------------
// The model list is read without a sign-in, so a stale token would sign in
// "successfully" and then quietly fall back to the bootstrap models.

function writeBLProfile(token) {
  tempDir ??= mkdtempSync(join(tmpdir(), "bl-"))
  process.env.BAILIAN_CONFIG_DIR = tempDir
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ access_token: token }))
}

test("bl sign-in refuses a token the free-quota API rejects", async () => {
  const { url } = startConsole({
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("not-logged-in.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  writeBLProfile("stale-tok")
  const h = await hooks()
  const flow = await h.auth.methods[1].authorize()
  const r = await flow.callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("bl login")
})

test("bl sign-in succeeds when the console accepts the token", async () => {
  const { url } = startConsole({
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("free-quota.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  writeBLProfile("live-tok")
  const h = await hooks()
  const flow = await h.auth.methods[1].authorize()
  const r = await flow.callback()
  expect(r.type).toBe("success")
  expect(r.token).toBe("live-tok")
  expect(r.source).toBe("bl")
})

test("browser sign-in verifies the minted token before it counts", async () => {
  const { url } = startConsole({
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("not-logged-in.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const flow = await h.auth.methods[0].authorize({ apiKey: "sk-x" })
  const ok = await fetch(`http://127.0.0.1:${flow.url.match(/127\.0\.0\.1:(\d+)/)[1]}/?state=${flow.url.split("state=")[1]}&access_token=minted`, { method: "POST", body: "" })
  expect(ok.status).toBe(200)
  const r = await flow.callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("无法读取免费额度")
})

test("usage says how each source's refused token is renewed", async () => {
  const { url } = startConsole({
    "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels": () => fixture("not-logged-in.json"),
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("not-logged-in.json"),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const bl = await h.auth.usage(async () => ({ type: "oauth", token: "tok", source: "bl" }))
  expect(bl.signIn).toBe("expired")
  expect(bl.error).toContain("bl login")
  const browser = await h.auth.usage(async () => ({ type: "oauth", token: "tok", source: "browser" }))
  expect(browser.signIn).toBe("expired")
  expect(browser.error).not.toContain("bl login")
  expect(browser.error).toContain("重新登录")
})

// ---- the public catalog drives the model list ---------------------------------

import { pageModels, servable, resetCatalogCache } from "./catalog.mjs"
import { runtimeModel } from "./models.mjs"

test("pageModels takes a group's items, never the group id, and keeps the metadata", () => {
  const inner = unwrapCliReply(fixture("models-rich.json"))
  const { total, models } = pageModels(inner)
  expect(total).toBe(6)
  const ids = models.map((m) => m.id)
  expect(ids).toContain("qwen3.8-max")
  expect(ids).not.toContain("group-qwen3.8-max")
  expect(ids).toContain("kimi-k3")

  const byId = Object.fromEntries(models.map((m) => [m.id, m]))
  const max = byId["qwen3.8-max"]
  expect(max.context).toBe(1_000_000)
  expect(max.output).toBe(131_072)
  expect(max.tools).toBe(true)
  expect(max.reasoning).toBe(true)
  expect(max.request).toEqual(["Image", "Text", "Video"])

  // servable: chat only — no transcription, no image maker, no realtime
  expect(servable(max)).toBe(true)
  expect(servable(byId["kimi-k3"])).toBe(true)
  expect(servable(byId["qwen-audio-3.1-asr-flash"])).toBe(false)
  expect(servable(byId["z-image-turbo"])).toBe(false)
  expect(servable(byId["qwen3.8-omni-flash-realtime"])).toBe(false)
  expect(servable(byId["old-model"])).toBe(true)
})

test("runtimeModel carries the catalog's own limits, abilities and free mark", () => {
  const inner = unwrapCliReply(fixture("models-rich.json"))
  const kimi = pageModels(inner).models.find((m) => m.id === "kimi-k3")
  const m = runtimeModel({ id: "bailian-free" }, kimi, true)
  expect(m.limit).toEqual({ context: 1_000_000, output: 1_048_576 })
  expect(m.capabilities.attachment).toBe(true) // Image in the request
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.free).toBe(true)
  expect(m.rate).toBe(0)
  const paid = runtimeModel({ id: "bailian-free" }, kimi, false)
  expect(paid.free).toBe(false)
  expect(paid.rate).toBeUndefined()
})

function startRichConsole(extra = {}) {
  return startConsole({
    "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels": (params) =>
      params.Data.input.pageNo === 1 ? fixture("models-rich.json") : JSON.stringify({ code: "200", data: { DataV2: { data: { success: true, data: { total: 6, list: [] } } }, success: true } }),
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("free-quota.json"),
    ...extra,
  })
}

test("provider.models without a sign-in offers the catalog's own bootstrap models", async () => {
  resetCatalogCache()
  const { url } = startRichConsole()
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const models = await h.provider.models({ id: "bailian-free", models: configModels() }, { auth: { type: "oauth" } })
  const ids = Object.keys(models)
  expect(ids).toEqual(["qwen3.8-max", "kimi-k3"]) // the bootstrap ids the rich catalog has
  expect(models["kimi-k3"].limit.output).toBe(1_048_576) // the catalog's number, not a guess
  expect(models["kimi-k3"].free).toBe(false) // not signed in: nothing is promised free
})

test("provider.models signed in is exactly the grants with room, at catalog limits", async () => {
  resetCatalogCache()
  _internal.resetGrantsCache()
  const { url } = startRichConsole()
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const models = await h.provider.models(
    { id: "bailian-free", models: configModels() },
    { auth: { type: "oauth", token: "tok", source: "browser" } },
  )
  // the chat grant at its catalog limits, the image grant as a drawer
  expect(Object.keys(models)).toEqual(["kimi-k3", "qwen-image-2.1-pro"])
  expect(models["kimi-k3"].free).toBe(true)
  expect(models["kimi-k3"].limit.output).toBe(1_048_576)
  expect(models["qwen-image-2.1-pro"].capabilities.output).toEqual({ text: false, image: true, audio: false, video: false, pdf: false })
  expect(models["qwen-image-2.1-pro"].capabilities.output.image).toBe(true)
})

test("callConsoleApi retries a network failure twice before giving up", async () => {
  const { callConsoleApi } = await import("./console.mjs")
  let failures = 0
  const flaky = async () => {
    failures++
    if (failures <= 2) throw new Error("connection dropped")
    return new Response(fixture("not-logged-in.json"), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    await callConsoleApi({ api: "x", token: "t", fetch: flaky })
    throw new Error("should have thrown the vendor's refusal")
  } catch (e) {
    expect(failures).toBe(3) // two drops retried, the third reached the console
    expect(e.signIn).toBe("expired") // a vendor answer is never retried into something else
  }
  failures = 0
  const dead = async () => {
    failures++
    throw new Error("connection dropped")
  }
  try {
    await callConsoleApi({ api: "x", token: "t", fetch: dead })
    throw new Error("should have thrown")
  } catch (e) {
    expect(failures).toBe(3)
    expect(e.message).toContain("连不上百炼")
  }
})

// ---- the key that spends the quota --------------------------------------------

test("usableApiKey takes the keys the free quota spends", async () => {
  const { usableApiKey } = await import("./console.mjs")
  expect(usableApiKey("sk-ws-H.PYLMMDE.83NG.x")).toBe(true)
  expect(usableApiKey("sk-abc123")).toBe(true)
  expect(usableApiKey("sk-sp-tok")).toBe(false) // a Token Plan key
  expect(usableApiKey("")).toBe(false)
  expect(usableApiKey(undefined)).toBe(false)
})

test("createPluginKey sends the console's own shape and returns the full key", async () => {
  const { createPluginKey, PLUGIN_KEY_DESCRIPTION } = await import("./console.mjs")
  const { url, seen } = startConsole({
    "zeldaEasy.bailian-dash-workspace.api-key.createApiKeyV4": (params) =>
      JSON.stringify({ code: "200", data: { DataV2: { data: { success: true, data: { key: "sk-ws-made", description: params.Data.reqDTO.description } } }, success: true } }),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const key = await createPluginKey({ token: "tok" })
  expect(key).toBe("sk-ws-made")
  expect(seen[0].api).toContain("createApiKeyV4")
  expect(seen[0].reqDTO).toEqual({ description: PLUGIN_KEY_DESCRIPTION })
})

test("browser sign-in makes a key when none was pasted", async () => {
  const made = []
  const { url } = startConsole({
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () => fixture("free-quota.json"),
    "zeldaEasy.bailian-dash-workspace.api-key.createApiKeyV4": (params) => {
      made.push(params.Data.reqDTO.description)
      return JSON.stringify({ code: "200", data: { DataV2: { data: { success: true, data: { key: "sk-ws-auto" } } }, success: true } })
    },
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const flow = await h.auth.methods[0].authorize({ apiKey: "" })
  const ok = await fetch(`http://127.0.0.1:${flow.url.match(/127\.0\.0\.1:(\d+)/)[1]}/?state=${flow.url.split("state=")[1]}&access_token=minted`, { method: "POST", body: "" })
  expect(ok.status).toBe(200)
  const r = await flow.callback()
  expect(r.type).toBe("success")
  expect(r.apiKey).toBe("sk-ws-auto")
  expect(made).toEqual(["magpie-plugin-bailian-free"])
})

test("loader makes and keeps a key when the sign-in has none", async () => {
  const { url } = startConsole({
    "zeldaEasy.bailian-dash-workspace.api-key.createApiKeyV4": () =>
      JSON.stringify({ code: "200", data: { DataV2: { data: { success: true, data: { key: "sk-ws-lazy" } } }, success: true } }),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const saved = []
  const client = { auth: { set: async ({ body }) => saved.push(body) } }
  const h = await BailianFreeAuthPlugin({ client })
  let dashscopeAuth = null
  const sink = Bun.serve({
    port: 0,
    async fetch(req) {
      dashscopeAuth = req.headers.get("authorization")
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    },
  })
  server = sink
  const loader = await h.auth.loader(async () => ({ type: "oauth", token: "tok", apiKey: "sk-sp-notusable", source: "browser" }))
  const res = await loader.fetch(`${sink.url}/chat/completions`, { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(dashscopeAuth).toBe("Bearer sk-ws-lazy")
  expect(saved.length).toBe(1)
  expect(saved[0].apiKey).toBe("sk-ws-lazy")
})

// ---- the card stays readable ----------------------------------------------------

test("usage folds non-chat grants into one aside line", async () => {
  const { url } = startConsole({
    "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels": () =>
      JSON.stringify({ code: "200", data: { DataV2: { data: { success: true, data: { total: 6, list: [
        { model: "kimi-k3", capabilities: ["Reasoning", "TG"] },
        { model: "qwen3.7-text-embedding-flash", capabilities: ["TG"] },
        { model: "qwen-image", capabilities: ["IG"], items: [{ model: "qwen-image-2.1-pro", capabilities: ["IG"] }] },
        { model: "sambert-beth-v1", capabilities: ["TTS"] },
        { model: "sambert-hanna-v1", capabilities: ["TTS"] },
        { model: "qwen3.8-omni-flash-realtime", capabilities: ["TG"] },
      ] } } }, success: true } }),
    "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota": () =>
      JSON.stringify({ code: "200", data: { DataV2: { data: { success: true, data: { freeTierQuotas: [
        { model: "kimi-k3", quotaTotal: 820000, quotaInitTotal: 1000000, quotaValidityPeriod: 1794873600000, quotaStatus: "VALID" },
        { model: "qwen3.7-text-embedding-flash", quotaTotal: 100000, quotaInitTotal: 1000000, quotaValidityPeriod: 1794873600000, quotaStatus: "VALID" },
        { model: "qwen-image-2.1-pro", quotaTotal: "10", quotaInitTotal: "10", quotaValidityPeriod: 1798732800000, quotaStatus: "VALID" },
        { model: "sambert-beth-v1", quotaTotal: 30000, quotaInitTotal: 30000, quotaStatus: "VALID" },
        { model: "sambert-hanna-v1", quotaTotal: 30000, quotaInitTotal: 30000, quotaStatus: "VALID" },
        { model: "qwen3.8-omni-flash-realtime", quotaTotal: 100000, quotaInitTotal: 100000, quotaStatus: "VALID" },
      ] } } }, success: true } }),
  })
  process.env.BAILIAN_CONSOLE_GATEWAY = url
  const h = await hooks()
  const usage = await h.auth.usage(async () => ({ type: "oauth", token: "tok", source: "browser" }))
  expect(usage.balance).toBe("6 项免费额度：对话 1 · 画图 1 · 其余 4 项为语音 2、向量/翻译/实时 2，暂无网关通道")
  expect(usage.windows.length).toBe(3)
  expect(usage.windows[0].name).toBe("kimi-k3")
  expect(usage.windows[1].name).toBe("qwen-image-2.1-pro") // a drawer's own window now
  const aside = usage.windows[2]
  expect(aside.aside).toBe(true)
  expect(aside.display).toContain("语音 2")
  expect(aside.display).toContain("向量/翻译/实时 2")
})

test("chatLikeId and servable keep endpoints and specialists out", async () => {
  const { chatLikeId } = await import("./catalog.mjs")
  for (const id of ["qwen3.7-text-embedding-flash", "qwen3.7-text-rerank", "qwen-mt-uni", "qwen3.8-omni-flash-realtime", "qwen-audio-3.1-realtime-plus", "sambert-beth-v1"]) {
    expect(chatLikeId(id)).toBe(false)
  }
  for (const id of ["kimi-k3", "qwen3.8-omni-flash", "qwen3.8-max", "deepseek-v4.1-flash"]) {
    expect(chatLikeId(id)).toBe(true)
  }
})

// ---- the media APIs behind the OpenAI shapes -----------------------------------

import { mediaRequest, drawImages, startVideo, videoState, dashscopeSize } from "./media.mjs"

test("mediaRequest takes the OpenAI-shaped paths", () => {
  expect(mediaRequest("POST", "/compatible-mode/v1/images/generations")).toEqual({ kind: "images" })
  expect(mediaRequest("POST", "/v1/videos")).toEqual({ kind: "video-start" })
  expect(mediaRequest("GET", "/v1/videos/task-9")).toEqual({ kind: "video-state", id: "task-9" })
  expect(mediaRequest("GET", "/v1/videos/task-9/content")).toEqual({ kind: "video-content", id: "task-9" })
  expect(mediaRequest("POST", "/v1/chat/completions")).toBeNull()
  expect(mediaRequest("GET", "/v1/models")).toBeNull()
  expect(dashscopeSize("1024x1024")).toBe("1024*1024")
  expect(dashscopeSize("16:9")).toBe("16:9")
})

test("drawImages translates to the native chat-shaped prompt and back", async () => {
  const seen = []
  const fake = Bun.serve({
    port: 0,
    async fetch(r) {
      const u = new URL(r.url)
      seen.push({ path: u.pathname, body: await r.json().catch(() => null), auth: r.headers.get("authorization") })
      if (u.pathname.includes("multimodal-generation")) {
        return Response.json({ output: { choices: [{ message: { content: [{ image: "https://img/1.png" }, { image: "https://img/2.png" }] } }] } })
      }
      return new Response("nf", { status: 404 })
    },
  })
  server = fake
  process.env.BAILIAN_DASHSCOPE_NATIVE = fake.url + "/api/v1"
  const out = await drawImages({ key: "sk-k", model: "qwen-image-3.0", prompt: "an apple", n: 2, size: "1024x1024" })
  expect(out.status).toBe(200)
  expect(out.body.data).toEqual([{ url: "https://img/1.png" }, { url: "https://img/2.png" }])
  expect(seen[0].auth).toBe("Bearer sk-k")
  expect(seen[0].body.parameters).toEqual({ n: 2, size: "1024*1024" })
  expect(seen[0].body.input.messages[0].content[0].text).toBe("an apple")
})

test("videos submit, poll and carry the vendor's own error words", async () => {
  const calls = []
  const fake = Bun.serve({
    port: 0,
    async fetch(r) {
      const u = new URL(r.url)
      calls.push({ method: r.method, path: u.pathname, async: r.headers.get("x-dashscope-async") })
      if (u.pathname.includes("video-synthesis")) {
        return Response.json({ output: { task_id: "t-1", task_status: "PENDING" } })
      }
      if (u.pathname.endsWith("/tasks/t-1")) {
        return Response.json({ output: { task_id: "t-1", task_status: "SUCCEEDED", video_url: "https://v/1.mp4" }, usage: { video_duration: 5 } })
      }
      if (u.pathname.endsWith("/tasks/t-2")) {
        return Response.json({ output: { task_status: "FAILED" }, code: "VideoFailed", message: "quota exceeded" })
      }
      return new Response("nf", { status: 404 })
    },
  })
  server = fake
  process.env.BAILIAN_DASHSCOPE_NATIVE = fake.url + "/api/v1"
  const start = await startVideo({ key: "sk-k", model: "wan3.0-video", prompt: "a dance" })
  expect(start.status).toBe(200)
  expect(start.body).toEqual({ id: "t-1", status: "queued", progress: 0 })
  expect(calls[0].async).toBe("enable")
  const st = await videoState({ key: "sk-k", id: "t-1" })
  expect(st.body).toEqual({ status: "succeeded", video: { url: "https://v/1.mp4", duration: 5 } })
  const failed = await videoState({ key: "sk-k", id: "t-2" })
  expect(failed.body.status).toBe("failed")
  expect(failed.body.error.message).toContain("quota exceeded")
})

test("the loader's fetch answers media paths through the translation", async () => {
  const fake = Bun.serve({
    port: 0,
    async fetch(r) {
      const u = new URL(r.url)
      if (u.pathname.includes("multimodal-generation")) {
        return Response.json({ output: { choices: [{ message: { content: [{ image: "https://img/x.png" }] } }] } })
      }
      return new Response("{}", { status: 200 })
    },
  })
  server = fake
  process.env.BAILIAN_DASHSCOPE_NATIVE = fake.url + "/api/v1"
  const h = await hooks()
  const loader = await h.auth.loader(async () => ({ type: "oauth", token: "tok", apiKey: "sk-live", source: "browser" }))
  const res = await loader.fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "qwen-image-3.0", prompt: "an apple", n: 1 }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.data[0].url).toBe("https://img/x.png")
})
