// Bailian's console gateway: the endpoint the official CLI (bl) reads with
// a console access token — /cli/api.json on the console gateway host, a
// bearer token, no browser cookies. Calls and replies are the console's
// own. The new-user free quota can only be read this way: the browser
// console guards the model list behind its anti-bot check.

export const API_LIST_MODELS = "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels"
export const API_FREE_QUOTA = "zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota"

const CORNERSTONE = {
  protocol: "V2", console: "ONE_CONSOLE", productCode: "p_efm", switchUserType: 3, consoleSite: "BAILIAN_ALIYUN",
}

export function gatewayHost(site, env = process.env) {
  const fallback = site === "international"
    ? "https://bailian-cs.console.alibabacloud.com"
    : "https://bailian-cs.console.aliyun.com"
  return String(env.BAILIAN_CONSOLE_GATEWAY ?? fallback).replace(/\/+$/, "")
}

// A reply the plugin doesn't understand is never shown as wrong numbers.
export function changedError() {
  return Object.assign(new Error("百炼控制台的返回变了，插件需要更新才能读取"), { changed: true })
}

export function signedOutError(why) {
  return Object.assign(new Error(why), { signIn: "expired" })
}

// callConsoleApi is one console call through the CLI gateway. It returns
// the call's own data, or null when the gateway says none. A refused
// token throws with .signIn = "expired". The gateway now and then drops
// a connection for no reason it explains — a network failure is retried
// twice before it becomes an error; a vendor's answer never is.
export async function callConsoleApi({ api, data = {}, token, site, region, fetch: doFetch = fetch, env = process.env }) {
  const params = JSON.stringify({ Api: api, V: "1.0", Data: { ...data, cornerstoneParam: CORNERSTONE } })
  const form = new URLSearchParams({ params, region: region || "cn-beijing" })
  const url = `${gatewayHost(site, env)}/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(api)}`
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" }
  const body = form.toString()
  let res
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await doFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) })
      lastError = null
      break
    } catch (e) {
      lastError = e
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  if (lastError) throw new Error(`连不上百炼：${lastError?.message ?? lastError}`)
  if (res.status === 401 || res.status === 403) {
    throw signedOutError("阿里云登录已结束，请重新登录")
  }
  if (!res.ok) throw new Error(`百炼返回了 ${res.status}`)
  return unwrapCliReply(await res.text())
}

// unwrapCliReply is the call's own data in a CLI gateway reply:
// data.DataV2.data.data, else data.DataV2.data, else data.data.
export function unwrapCliReply(text) {
  let env
  try {
    env = JSON.parse(text)
  } catch {
    throw changedError()
  }
  const gw = env?.data
  if (!gw || typeof gw !== "object" || Array.isArray(gw)) throw changedError()
  if (gw.success === false) {
    const code = String(gw.errorCode ?? "")
    if (code.includes("NotLogin")) throw signedOutError("阿里云登录已结束，请重新登录")
    throw new Error(`百炼：${`${code} ${gw.errorMsg ?? ""}`.trim()}`)
  }
  let inner = gw.data ?? null
  if (gw.DataV2 != null) {
    const d2 = gw.DataV2.data
    if (d2 && typeof d2 === "object" && !Array.isArray(d2)) {
      if (d2.success === false) throw new Error(`百炼：${String(d2.errorMsg ?? "").trim()}`)
      inner = d2.data ?? null
    } else {
      inner = d2 ?? null
    }
  }
  if (inner === null || inner === "null" || inner === undefined) return null
  return inner
}

// parseAmount is a billing amount as the console sends it: a JSON number
// or a string, maybe with thousands separators. Missing is 0; anything
// that isn't a number is a changed reply.
export function parseAmount(v) {
  if (v == null) return 0
  const s = String(v).replace(/,/g, "").replace(/"/g, "").trim()
  if (s === "" || s === "null") return 0
  const n = Number(s)
  if (!Number.isFinite(n)) throw changedError()
  return n
}

// parseModelList is every model of the paged model list with the
// capabilities it is listed under, parents and their items flattened.
export function parseModelList(payload) {
  const total = Number(payload?.total)
  if (!Number.isFinite(total)) throw changedError()
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(payload?.list) ? payload.list : []) {
    for (const it of [m, ...(Array.isArray(m?.items) ? m.items : [])]) {
      const id = String(it?.model ?? "").trim()
      const capabilities = (Array.isArray(it?.capabilities) ? it.capabilities : []).map((c) => String(c ?? "").trim()).filter(Boolean)
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push({ model: id, capabilities })
      }
    }
  }
  return { total, models: out }
}

// unitOf is what a model's grant is counted in, by what the model does:
// text in tokens, the rest as Bailian counts them.
export function unitOf(capabilities, model) {
  for (const c of capabilities) {
    if (["TG", "VU", "Reasoning", "ME", "TR", "Multimodal-Omni", "Realtime-Omni"].includes(c)) return "tokens"
    if (c === "IG") return "images"
  }
  if (/image|wanx|seedream|kolors/i.test(model)) return "images"
  return ""
}

// mediaOf is what a Bailian model makes, from its capabilities, else its
// name; text is what a chat gateway can serve.
export function mediaOf(capabilities, model) {
  for (const c of capabilities) {
    if (c === "IG" || c === "IE") return "image"
    if (c === "VG" || c === "VE") return "video"
    if (c === "TTS" || c === "SS") return "speech"
    if (c === "ASR" || c === "SR") return "audio"
  }
  if (/image|wanx|seedream|kolors|flux/i.test(model)) return "image"
  if (/video|wan2|t2v|i2v/i.test(model)) return "video"
  if (/tts|cosyvoice|sambert/i.test(model)) return "speech"
  if (/asr|paraformer|sensevoice/i.test(model)) return "audio"
  return "text"
}

// parseFreeQuota is the grants with room left, soonest-ending first, and
// how many more are used up or expired.
export function parseFreeQuota(payload, capabilitiesOf, nowMs = Date.now()) {
  const rows = Array.isArray(payload?.freeTierQuotas) ? payload.freeTierQuotas : null
  if (!rows) throw changedError()
  const grants = []
  let gone = 0
  for (const row of rows) {
    const model = String(row?.model ?? "").trim()
    const left = parseAmount(row?.quotaTotal)
    const limit = parseAmount(row?.quotaInitTotal)
    const ends = parseAmount(row?.quotaValidityPeriod)
    if (!model || limit <= 0) continue
    if (String(row?.quotaStatus ?? "") !== "VALID" || left <= 0 || (ends > 0 && ends <= nowMs)) {
      gone++
      continue
    }
    const caps = capabilitiesOf(model)
    grants.push({ model, media: mediaOf(caps, model), unit: unitOf(caps, model), left, limit, ends })
  }
  grants.sort((a, b) => {
    if ((a.ends === 0) !== (b.ends === 0)) return a.ends === 0 ? 1 : -1
    if (a.ends !== b.ends) return a.ends - b.ends
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0
  })
  return { grants, gone }
}

// readFreeQuota lists the models, then asks each one's free quota.
export async function readFreeQuota({ token, site, region, fetch: doFetch = fetch, env = process.env }) {
  const call = (api, data) => callConsoleApi({ api, data, token, site, region, fetch: doFetch, env })
  const caps = new Map()
  const names = []
  for (let page = 1, pages = 1; page <= pages && page <= 40; page++) {
    const inner = await call(API_LIST_MODELS, {
      input: {
        pageNo: page, pageSize: 50, name: "", providers: [], inferenceProviders: [],
        features: [], group: true, capabilities: [], contextWindows: [],
      },
    })
    const { total, models } = parseModelList(inner)
    pages = Math.ceil(total / 50) || 1
    for (const m of models) {
      names.push(m.model)
      if (!caps.has(m.model)) caps.set(m.model, m.capabilities)
    }
  }
  const inner = await call(API_FREE_QUOTA, { queryFreeTierQuotaRequest: { models: names } })
  return parseFreeQuota(inner ?? {}, (model) => caps.get(model) ?? [], Date.now())
}

// verifyConsoleToken says a token can read the free quota: the model list
// is read without a sign-in (a garbage token lists models fine), so the
// free-quota query is what a token must survive before a sign-in counts.
// It throws with .signIn = "expired" when the console refuses the token.
export async function verifyConsoleToken({ token, site, region, fetch: doFetch = fetch, env = process.env }) {
  await callConsoleApi({
    api: API_FREE_QUOTA,
    data: { queryFreeTierQuotaRequest: { models: ["qwen-plus"] } },
    token, site, region, fetch: doFetch, env,
  })
  return true
}
