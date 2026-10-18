// OpenCode & Magpie provider plugin for Alibaba Cloud Bailian's (阿里云
// 百炼) new-user free quota: each model's own grant, valid 90 days from
// activation, spent at DashScope's OpenAI-compatible endpoint with the
// account's own API key. The grants can only be read with a console token,
// so the plugin signs in the way Bailian's CLI does (a loopback
// console-login page, or bl's own sign-in, read only).

import { readFreeQuota, verifyConsoleToken, signedOutError } from "./console.mjs"
import { readBailianCLIProfile } from "./bl.mjs"
import { startConsoleLogin } from "./login.mjs"
import { configModels, runtimeModel, grantWindow, freeQuotaNote } from "./models.mjs"

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

// ---- Plugin -----------------------------------------------------------------

export const BailianFreeAuthPlugin = async () => {
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
        try {
          const creds = await currentCreds(auth)
          if (!creds?.token) return provider.models
          const { grants } = await readGrants(creds)
          const live = {}
          for (const grant of grants) {
            if (grant.media !== "text") continue
            live[grant.model] = runtimeModel(provider, grant.model)
          }
          return Object.keys(live).length ? live : provider.models
        } catch {
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
            let creds
            try {
              creds = await currentCreds(await getAuth())
            } catch (e) {
              return jsonError(401, e?.message ?? String(e), "expired")
            }
            if (!creds) return jsonError(401, "未登录：请先完成百炼登录", "expired")
            if (!creds.apiKey) {
              return jsonError(
                401,
                "未设置 DashScope API Key：重新登录并在提示里填写 sk- 开头的密钥（百炼控制台 › API-KEY 页创建）",
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
          return {
            plan: "新用户免费额度",
            balance: freeQuotaNote(grants.filter((g) => g.media === "text").length, gone),
            windows: grants.map(grantWindow),
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
                "DashScope API Key（sk-…，百炼控制台 › API-KEY 页创建）：发请求用。只看免费额度可留空，之后重新登录补上。",
              placeholder: "sk-…",
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
                  return {
                    type: "success",
                    access: "",
                    refresh: "",
                    expires: 0,
                    token: v.token,
                    site: v.site ?? "",
                    region: v.region ?? "",
                    apiKey: String(inputs?.apiKey ?? "").trim(),
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
              return {
                type: "success",
                access: "",
                refresh: "",
                expires: 0,
                token: p.token,
                site: p.site ?? "",
                region: p.region ?? "",
                apiKey: p.apiKey ?? "",
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
  resetGrantsCache: () => {
    grantsCache = { token: "", at: 0, value: null }
  },
}
