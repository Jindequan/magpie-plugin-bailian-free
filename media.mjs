// The vendor's own media APIs, behind the OpenAI shapes magpie speaks.
// DashScope's compatible mode has no images or videos endpoint: images
// are drawn synchronously at the native multimodal-generation API with a
// chat-shaped prompt, and videos are async tasks (submit, poll, fetch).
// The plugin's fetch translates between the two, so a model whose grant
// it lists as image- or video-only draws and films through magpie.

// nativeBase is where DashScope's own APIs live; BAILIAN_DASHSCOPE_NATIVE
// moves them (a proxy, a test).
const nativeBase = (env = process.env) =>
  String(env.BAILIAN_DASHSCOPE_NATIVE ?? "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, "")
const imageAPI = (env) => `${nativeBase(env)}/services/aigc/multimodal-generation/generation`
const videoAPI = (env) => `${nativeBase(env)}/services/aigc/video-generation/video-synthesis`
const taskAPI = (env) => `${nativeBase(env)}/tasks`

const IMAGE_TIMEOUT_MS = 4 * 60 * 1000 // a draw takes up to a minute or two
const POLL_INTERVAL_MS = 5 * 1000

// dashscopeSize is an OpenAI size ("1024x1024") as DashScope spells it
// ("1024*1024"); aspect-only asks (16:9) pass as they are.
export function dashscopeSize(size) {
  const s = String(size ?? "").trim()
  return /^\d+x\d+$/.test(s) ? s.replace("x", "*") : s
}

// drawImages answers an OpenAI images request with the native API's
// image URLs.
export async function drawImages({ key, model, prompt, n = 1, size, fetch: doFetch = fetch, env = process.env }) {
  const parameters = { n: Math.max(1, Math.min(4, Number(n) || 1)) }
  const s = dashscopeSize(size)
  if (s) parameters.size = s
  let res
  try {
    res = await doFetch(imageAPI(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: "user", content: [{ type: "text", text: String(prompt ?? "") }] }] },
        parameters,
      }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    })
  } catch (e) {
    return { status: 502, error: `连不上百炼画图：${e?.message ?? e}` }
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok || payload.code) {
    return { status: res.ok ? 502 : res.status, error: dashscopeError(payload, `HTTP ${res.status}`) }
  }
  const data = []
  for (const choice of payload?.output?.choices ?? []) {
    for (const part of choice?.message?.content ?? []) {
      if (part?.image) data.push({ url: part.image })
    }
  }
  if (!data.length) return { status: 502, error: "百炼画图没有返回图片" }
  return { status: 200, body: { created: Math.floor(Date.now() / 1000), data } }
}

// dashscopeError is the vendor's own words for a refusal.
export function dashscopeError(payload, fallback) {
  const msg = [payload?.code, payload?.message].filter(Boolean).join(" ")
  return msg || fallback
}

// startVideo submits an async video task and answers OpenAI's video
// object with the vendor's task id in it.
export async function startVideo({ key, model, prompt, size, fetch: doFetch = fetch, env = process.env }) {
  const parameters = {}
  const s = dashscopeSize(size)
  if (s) parameters.size = s
  let res
  try {
    res = await doFetch(videoAPI(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
      body: JSON.stringify({ model, input: { prompt: String(prompt ?? "") }, parameters }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    return { status: 502, error: `连不上百炼视频：${e?.message ?? e}` }
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok || payload.code) {
    return { status: res.ok ? 502 : res.status, error: dashscopeError(payload, `HTTP ${res.status}`) }
  }
  const id = String(payload?.output?.task_id ?? "")
  if (!id) return { status: 502, error: "百炼没有返回视频任务" }
  return { status: 200, body: { id, status: "queued", progress: 0 } }
}

// videoState is a task as OpenAI's status reply has it, once: the status
// names magpie maps (video.go), the video's url and duration when done.
export async function videoState({ key, id, fetch: doFetch = fetch, env = process.env }) {
  let res
  try {
    res = await doFetch(`${taskAPI(env)}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    return { status: 502, error: `查不到视频任务：${e?.message ?? e}` }
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok || (res.ok && payload.code && payload.output?.task_status === undefined)) {
    return { status: res.ok ? 502 : res.status, error: dashscopeError(payload, `HTTP ${res.status}`) }
  }
  const st = String(payload?.output?.task_status ?? "")
  const out = { status: st === "SUCCEEDED" ? "succeeded" : st === "FAILED" || st === "CANCELED" || st === "UNKNOWN" ? "failed" : "running" }
  const videoUrl = payload?.output?.video_url
  if (st === "SUCCEEDED" && videoUrl) {
    out.video = { url: videoUrl, duration: Number(payload?.usage?.video_duration) || 0 }
  }
  if (st === "FAILED") {
    out.error = { code: String(payload?.code ?? "failed"), message: dashscopeError(payload, "the video failed") }
  }
  return { status: 200, body: out }
}

// videoContent streams the finished video's bytes.
export async function videoContent({ key, id, fetch: doFetch = fetch, env = process.env }) {
  const state = await videoState({ key, id, fetch: doFetch, env })
  if (state.status !== 200) return state
  const url = state.body?.video?.url
  if (!url) return { status: 400, error: "视频还没有完成" }
  let res
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  } catch (e) {
    return { status: 502, error: `取不到视频内容：${e?.message ?? e}` }
  }
  if (!res.ok) return { status: 502, error: `取视频内容失败：HTTP ${res.status}` }
  return { status: 200, body: res.body, contentType: res.headers.get("content-type") || "video/mp4" }
}

// mediaRequest is whether the OpenAI-shaped request at path is one this
// module answers, and its parts.
export function mediaRequest(method, path) {
  if (method !== "POST" && method !== "GET") return null
  const m = path.match(/\/images\/generations\/?$/)
  if (m && method === "POST") return { kind: "images" }
  const v = path.match(/\/videos\/([^/]+)(\/content)?\/?$/)
  if (v && method === "POST" && !v[1]) return null
  if (path.match(/\/videos\/?$/) && method === "POST") return { kind: "video-start" }
  if (v && !v[2] && method === "GET") return { kind: "video-state", id: decodeURIComponent(v[1]) }
  if (v?.[2] && method === "GET") return { kind: "video-content", id: decodeURIComponent(v[1]) }
  return null
}
