// OpenCode & Magpie provider plugin for Alibaba Cloud Bailian's (阿里云
// 百炼) new-user free quota: each model's own grant, valid 90 days from
// activation, spent at DashScope's OpenAI-compatible endpoint with the
// account's own API key. The grants can only be read with a console token,
// so the plugin signs in the way Bailian's CLI does (a loopback
// console-login page, or bl's own sign-in, read only).

import { readFreeQuota, verifyConsoleToken, signedOutError, usableApiKey, createPluginKey } from "./console.mjs"
import { fetchModelCatalog, servable, chatLikeId } from "./catalog.mjs"
import { readBailianCLIProfile } from "./bl.mjs"
import { startConsoleLogin } from "./login.mjs"
import { configModels, runtimeModel, grantWindow, freeQuotaNote, BOOTSTRAP_IDS } from "./models.mjs"

const PROVIDER_ID = "bailian-free"
const PROVIDER_NAME = "百炼免费额度"
const NPM = "@ai-sdk/openai-compatible"
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const GRANTS_TTL_MS = 5 * 60 * 1000

// ---- Credentials ------------------------------------------------------------

// currentCreds is what a signed-in account reads with now. A bl sign-in
// is re-read from bl's own file each time: only bl renews it.
async function currentCreds(auth) {
  if (auth?.source === "bl") {
    const p = readBailianCLIProfile()
    if (!p?.token) throw signedOutError("百炼 CLI 的登录已结束，请运行 bl login")
    return { ...p, source: "bl" }
  }
  const token = String(auth?.token ?? auth?.access ?? "").trim()
  if (!token) return null
  return {
    token,
    site: String(auth.site ?? ""),
    region: String(auth.region ?? ""),
    apiKey: String(auth.apiKey ?? "").trim(),
    source: "browser",
  }
}

// renewHint is how a refused console token is renewed, by where it came
// from: bl's own sign-in, or the plugin's browser login.
function renewHint(auth) {
  return auth?.source === "bl"
    ? "百炼 CLI 的登录已结束：请重新运行 bl login，然后在本插件里重新登录；或改用浏览器登录"
    : "阿里云登录已结束，请重新登录"
}

// grantsCache keeps one read per token, so the console isn't asked again
// on every card refresh.
let grantsCache = { token: "", at: 0, value: null }

async function readGrants(creds) {
  if (grantsCache.token === creds.token && Date.now() - grantsCache.at < GRANTS_TTL_MS) {
    return grantsCache.value
  }
  const value = await readFreeQuota({ token: creds.token, site: creds.site, region: creds.region })
  grantsCache = { token: creds.token, at: Date.now(), value }
  return value
}

function jsonError(status, message, signIn) {
  return new Response(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "api_error" } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })
}

// ensurePluginKey gives creds a key that spends the free quota: the one
// kept with the sign-in when it is usable, else one created through the
// console, labelled as this plugin's, kept for next time. At most one
// attempt a while, so a console that can't create keys doesn't pile them.
let keyAttempt = { at: 0 }
async function ensurePluginKey(creds, auth, save) {
  if (!creds?.token || usableApiKey(creds.apiKey)) return creds
  if (Date.now() - keyAttempt.at < 10 * 60 * 1000) return creds
  keyAttempt = { at: Date.now() }
  try {
    const key = await createPluginKey({ token: creds.token, site: creds.site, region: creds.region })
    creds = { ...creds, apiKey: key }
    await save?.({ ...auth, apiKey: key })
  } catch {}
  return creds
}

// ---- Plugin -----------------------------------------------------------------

export const BailianFreeAuthPlugin = async ({ client }) => {
  const saveAuth = async (next) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: next })
    } catch {}
  }
  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: NPM,
        api: DASHSCOPE_BASE,
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        // a grant the catalog doesn't know (a model too new for the
        // list, or removed from it) is still offered, at fallback limits
        const synthetic = (id) => ({
          id, context: 0, output: 0, request: ["Text"], response: ["Text"], caps: ["TG"],
          provider: "", categories: [], tools: undefined, reasoning: false,
        })
        try {
          let creds = null
          try {
            creds = await currentCreds(auth)
          } catch {}
          // the catalog is public: real ids, real limits and abilities,
          // with no sign-in at all
          const catalog = await fetchModelCatalog({ token: creds?.token || "public", site: creds?.site, region: creds?.region })
          let grants = null
          if (creds?.token) {
            try {
              grants = (await readGrants(creds)).grants
            } catch {}
          }
          if (grants) {
            const live = {}
            for (const g of grants) {
              if (g.media !== "text" || !chatLikeId(g.model)) continue
              live[g.model] = runtimeModel(provider, catalog.get(g.model) ?? synthetic(g.model), true)
            }
            if (Object.keys(live).length) return live
            // the grants read fine but nothing has room left: what the
            // bootstrap covers stays offerable, no longer marked free
          }
          // not signed in, or nothing left: the catalog's own view of
          // what a fresh account gets, numbers and all
          const out = {}
          for (const id of BOOTSTRAP_IDS) {
            const e = catalog.get(id)
            if (e && servable(e)) out[id] = runtimeModel(provider, e, false)
          }
          return Object.keys(out).length ? out : provider.models
        } catch {
          // the console can't be read at all: the bootstrap list stands in
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth) {
        return {
          baseURL: DASHSCOPE_BASE,
          apiKey: "bailian-free",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            let auth
            let creds
            try {
              auth = await getAuth()
              creds = await currentCreds(auth)
            } catch (e) {
              return jsonError(401, e?.message ?? String(e), "expired")
            }
            if (!creds) return jsonError(401, "未登录：请先完成百炼登录", "expired")
            creds = await ensurePluginKey(creds, auth, saveAuth)
            if (!usableApiKey(creds.apiKey)) {
              return jsonError(
                401,
                "没有可用的 DashScope API Key（自动创建失败）：请在百炼控制台 › API-KEY 页创建 sk- 密钥后重新登录填写",
                "expired",
              )
            }
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("x-api-key")
            headers.delete("content-length")
            headers.set("Authorization", "Bearer " + creds.apiKey)
            let res
            try {
              res = await fetch(req ? req.url : input, {
                ...init,
                method: init?.method ?? req?.method ?? "POST",
                headers,
                body: init?.body ?? (req ? await req.clone().text() : undefined),
                signal: init?.signal,
              })
            } catch (e) {
              return jsonError(502, `连不上百炼：${e?.message ?? e}`, "kept")
            }
            // a refused key is fixed by signing in again with a right one
            const state = res.status === 401 || res.status === 403 ? "expired" : "kept"
            const out = new Headers(res.headers)
            out.set("X-Magpie-Sign-In", state)
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return { error: "not signed in", signIn: "kept" }
        try {
          const creds = await currentCreds(auth)
          if (!creds?.token) return { error: "not signed in", signIn: "kept" }
          const { grants, gone } = await readGrants(creds)
          // chat grants get their own window; the rest — embeddings,
          // reranking, translation, images, video, speech — are one line,
          // not forty sambert voices each with a meter
          const chat = grants.filter((g) => g.media === "text" && chatLikeId(g.model))
          const other = grants.filter((g) => !chat.includes(g))
          const byMedia = {}
          for (const g of other) byMedia[g.media] = (byMedia[g.media] ?? 0) + 1
          const mediaNames = { image: "图像", video: "视频", speech: "语音", audio: "音频", text: "向量/翻译/实时" }
          return {
            plan: "新用户免费额度",
            balance:
              `${chat.length + other.length} 项免费额度：对话模型 ${chat.length} 个可选用 · 其余 ${other.length} 项为${Object.entries(byMedia).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => `${mediaNames[m] ?? m} ${n}`).join("、")}，不能走对话接口${gone ? ` · 另有 ${gone} 项已用完或过期` : ""}`,
            windows: [
              ...chat.map(grantWindow),
              ...(other.length
                ? [{
                    name: "非对话类免费额度",
                    aside: true,
                    used: 0,
                    display: Object.entries(byMedia).map(([m, n]) => `${mediaNames[m] ?? m} ${n}`).join(" · "),
                    amount: 0,
                    limit: other.length,
                    unit: "项",
                  }]
                : []),
            ],
            user: auth.accountId || "阿里云账号",
            signIn: "kept",
          }
        } catch (e) {
          // the model list is read without a sign-in, so a refused token
          // shows up here first; say how this account's token is renewed
          const error =
            e?.signIn === "expired" ? signedOutError(renewHint(auth)).message : e?.message ?? String(e)
          return { error, signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "阿里云百炼账号（浏览器登录）",
              prompts: [
                {
                  type: "text",
                  key: "apiKey",
                  message:
                    "DashScope API Key（sk-…）：可留空，插件会用登录态自动创建一个专用 Key；填了就用你的（sk-sp- 的 Token Plan Key 不能用于免费额度）。",
                  placeholder: "sk-…（可留空）",
                },
              ],
          authorize: async (inputs) => {
            const login = await startConsoleLogin()
            return {
              url: login.url,
              instructions: "在打开的页面完成阿里云登录；插件在本机 127.0.0.1 接收登录结果，无需粘贴。",
              method: "auto",
              async callback() {
                try {
                  const v = await login.done
                  try {
                    await verifyConsoleToken({ token: v.token, site: v.site, region: v.region })
                  } catch (e) {
                    return { type: "failed", error: `登录态无法读取免费额度（${e?.message ?? e}），请重新发起登录` }
                  }
                  let apiKey = String(inputs?.apiKey ?? "").trim()
                  if (!usableApiKey(apiKey)) {
                    // the key that spends the quota is made with the token
                    // itself; a pasted one (when it works) is kept instead
                    try {
                      apiKey = await createPluginKey({ token: v.token, site: v.site, region: v.region })
                    } catch {}
                  }
                  return {
                    type: "success",
                    access: "",
                    refresh: "",
                    expires: 0,
                    token: v.token,
                    site: v.site ?? "",
                    region: v.region ?? "",
                    apiKey,
                    source: "browser",
                    accountId: "阿里云账号",
                  }
                } catch (e) {
                  return { type: "failed", error: e?.message ?? String(e) }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "百炼 CLI 登录态（~/.bailian/config.json，只读）",
          authorize: async () => ({
            url: "",
            instructions: "读取本机百炼 CLI（bl login）的登录态；插件只读，不改不续。",
            method: "auto",
            async callback() {
              const p = readBailianCLIProfile()
              if (!p?.token) {
                return { type: "failed", error: "未检测到百炼 CLI 登录态（~/.bailian/config.json）。请先运行 bl login。" }
              }
              // the model list is read without a sign-in, so a stale bl
              // token still "works" there; only the free-quota query tells
              // the truth, and a sign-in with it would quietly fall back
              // to the bootstrap models
              try {
                await verifyConsoleToken({ token: p.token, site: p.site, region: p.region })
              } catch (e) {
                const why = e?.signIn === "expired"
                  ? "百炼 CLI 的登录态已无法读取免费额度（可能已过期）。请重新运行 bl login 后再登录；或改用浏览器登录。"
                  : `无法验证百炼 CLI 的登录态（${e?.message ?? e}）`
                return { type: "failed", error: why }
              }
              let apiKey = p.apiKey ?? ""
              if (!usableApiKey(apiKey)) {
                // bl's own key may be a Token Plan key (sk-sp-…), which the
                // free quota doesn't take; make one that it does
                try {
                  apiKey = await createPluginKey({ token: p.token, site: p.site, region: p.region })
                } catch {}
              }
              return {
                type: "success",
                access: "",
                refresh: "",
                expires: 0,
                token: p.token,
                site: p.site ?? "",
                region: p.region ?? "",
                apiKey,
                source: "bl",
                accountId: "阿里云账号（百炼 CLI）",
              }
            },
          }),
        },
      ],
    },
  }
}

export const _internal = {
  currentCreds,
  readGrants,
  renewHint,
  ensurePluginKey,
  resetGrantsCache: () => {
    grantsCache = { token: "", at: 0, value: null }
  },
  resetKeyAttempt: () => {
    keyAttempt = { at: 0 }
  },
}
