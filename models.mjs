// What the plugin offers before the grants are read, and how a grant
// becomes a model and a quota window. The live list always wins: it is
// exactly the models whose free quota still has room.

const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const NPM = "@ai-sdk/openai-compatible"

// Context and output limits of the models Bailian's new users are granted,
// from Bailian's docs; anything the grants list beyond this gets a
// conservative default rather than a wrong number.
const KNOWN_LIMITS = {
  "qwen-flash": [1_048_576, 8_192],
  "qwen-turbo": [1_000_000, 8_192],
  "qwen-plus": [131_072, 8_192],
  "qwen-max": [32_768, 8_192],
  "qwen3-max": [131_072, 8_192],
  "deepseek-v3": [65_536, 8_192],
  "deepseek-r1": [65_536, 8_192],
  "kimi-k3": [131_072, 8_192],
}
const DEFAULT_LIMITS = [131_072, 8_192]

export const FALLBACK_MODELS = Object.keys(KNOWN_LIMITS).map((id) => ({
  id,
  name: id,
  ...Object.fromEntries(["context", "output"].map((k, i) => [k, KNOWN_LIMITS[id][i]])),
  images: false,
  reasoning: true,
}))

function limitsOf(id) {
  const known = KNOWN_LIMITS[id]
  if (known) return known
  const bare = id.replace(/-latest$|-thinking$|-chat$/, "")
  return KNOWN_LIMITS[bare] ?? DEFAULT_LIMITS
}

export function isReasoning(id) {
  return /r1|qwq|thinking|qwen3/.test(id)
}

// configModels is the provider's bootstrap list, in OpenCode's config
// shape.
export function configModels() {
  return Object.fromEntries(
    FALLBACK_MODELS.map((m) => [
      m.id,
      {
        name: m.name,
        limit: { context: m.context, output: m.output },
        tool_call: true,
        reasoning: true,
        attachment: false,
        modalities: { input: ["text"], output: ["text"] },
        free: true,
        rate: 0,
      },
    ]),
  )
}

// runtimeModel is one live model in the shape OpenCode's provider.models
// hook returns. Free grants cost nothing while they last.
export function runtimeModel(provider, id) {
  const [context, output] = limitsOf(id)
  return {
    id,
    providerID: provider.id,
    name: id,
    api: { id, url: DASHSCOPE_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output },
    capabilities: {
      temperature: true,
      reasoning: isReasoning(id),
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
    free: true,
    rate: 0,
  }
}

// fmtAmount reads the way the console's own pages do: 万 and 亿.
export function fmtAmount(n) {
  if (!Number.isFinite(n)) return String(n)
  const abs = Math.abs(n)
  const trim = (x) => String(Math.round(x * 100) / 100)
  if (abs >= 1e8) return `${trim(n / 1e8)}亿`
  if (abs >= 1e4) return `${trim(n / 1e4)}万`
  return trim(n)
}

// grantWindow is one model's grant as a quota window: its own meter,
// scoped to that model, ending when the grant does. Text grants drive the
// allowance; the rest are shown aside.
export function grantWindow(grant) {
  const unit = grant.unit || "units"
  const used = grant.limit > 0 ? ((grant.limit - grant.left) / grant.limit) * 100 : 0
  const text = grant.media === "text"
  return {
    name: grant.model,
    model: grant.model,
    ...(text ? { models: [grant.model] } : { aside: true }),
    used,
    display: `${fmtAmount(grant.left)} / ${fmtAmount(grant.limit)} ${unit}`,
    amount: grant.limit - grant.left,
    limit: grant.limit,
    unit,
    ...(grant.ends > 0
      ? { runsOutAt: new Date(grant.ends).toISOString(), runsOut: grant.left }
      : {}),
  }
}

export function freeQuotaNote(live, gone) {
  if (live <= 0) return "没有模型还有免费额度"
  const models = `${live} 个模型有免费额度`
  return gone > 0 ? `${models} · ${gone} 个已用完或过期` : models
}
