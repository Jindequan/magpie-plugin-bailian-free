// Alibaba Cloud's own sign-in for programs, the way the official Bailian
// CLI (bl auth login --console) and magpie's built-ins do it: listen once
// on 127.0.0.1, open Bailian's console-login page in the user's own
// browser, and the page hands the console access token back to that port
// once the user has signed in. A random state ties the answer to this
// request. magpie opens the page for the authorize URL this returns; the
// sign-in finishes on its own, nothing is pasted.

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

export function consoleLoginPage(env = process.env) {
  return String(env.BAILIAN_CONSOLE_LOGIN_PAGE ?? "https://bailian.console.aliyun.com/console-login").replace(/\/+$/, "")
}

// startConsoleLogin begins the handshake: it returns the page to open and
// the promise of the values the page hands back (token, site, region).
// The listener gives up after timeoutMs.
export function startConsoleLogin({ timeoutMs = 9 * 60 * 1000, env = process.env } = {}) {
  const state = randomBytes(16).toString("hex")
  let settle
  let settled = false
  const done = new Promise((resolve, reject) => {
    settle = (ok, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
      ok ? resolve(value) : reject(value)
    }
  })
  let timer

  // the console page calls this port from its own origin
  const server = createServer((req, res) => {
    const finish = (status, text) => {
      res.statusCode = status
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      res.end(text)
    }
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.setHeader("Access-Control-Allow-Private-Network", "true")
    if (req.method === "OPTIONS") {
      res.statusCode = 204
      return res.end()
    }
    const u = new URL(req.url, "http://127.0.0.1")
    if (u.searchParams.get("state") !== state) return finish(400, "bad state")
    const values = {}
    const take = (get) => {
      for (const [key, names] of [
        ["token", ["access_token", "accessToken"]],
        ["site", ["console_site", "consoleSite"]],
        ["region", ["console_region", "consoleRegion"]],
      ]) {
        for (const n of names) {
          const s = String(get(n) ?? "").trim()
          if (s && !values[key]) values[key] = s
        }
      }
    }
    take((k) => u.searchParams.get(k))
    const handBack = () => {
      if (!values.token) return finish(400, "no token")
      finish(200, "OK — 已登录，可以关闭这个标签页。")
      settle(true, values)
    }
    if (req.method === "GET" || req.method === "HEAD") return handBack()
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > 64 * 1024) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("error", () => {})
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      try {
        const m = JSON.parse(body)
        if (m && typeof m === "object") {
          take((k) => m[k])
          if (m.data && typeof m.data === "object") take((k) => m.data[k])
        }
      } catch {
        if (body) take((k) => new URLSearchParams(body).get(k))
      }
      handBack()
    })
  })
  server.on("error", (e) => settle(false, Object.assign(new Error(`无法监听本机端口：${e?.message ?? e}`), {})))

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      timer = setTimeout(() => settle(false, new Error("登录超时，请重新发起")), timeoutMs)
      resolve({
        port,
        url: `${consoleLoginPage(env)}?notice=127.0.0.1:${port}?state=${encodeURIComponent(state)}`,
        done,
        async close() {
          settle(false, new Error("登录已取消"))
        },
      })
    })
  })
}
