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
  delete process.env.BAILIAN_CONFIG_DIR
  _internal.resetGrantsCache()
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
  expect(image.aside).toBe(true)
  expect(image.models).toBeUndefined()
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
  expect(configModels()["qwen-flash"].free).toBe(true)

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
  expect(usage.balance).toBe("1 个模型有免费额度 · 1 个已用完或过期")
  expect(usage.windows.length).toBe(2)
  expect(usage.windows[0].name).toBe("kimi-k3")
  expect(usage.windows[0].display).toBe("82万 / 100万 tokens")
})

test("usage without a sign-in says so; provider.models falls back", async () => {
  const h = await hooks()
  const none = await h.auth.usage(async () => ({ type: "oauth" }))
  expect(none.error).toBe("not signed in")

  const models = await h.provider.models(
    { id: "bailian-free", models: configModels() },
    { auth: { type: "oauth" } },
  )
  expect(Object.keys(models)).toContain("qwen-flash")
})

test("loader sends with the DashScope key and says what is missing", async () => {
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
