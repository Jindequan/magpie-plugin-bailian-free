// What the plugin offers as models, and how a grant becomes a model and
// a quota window. The bootstrap list is only what shows before the live
// catalog has been read; its numbers are the catalog's own (2026-10),
// and the live list always replaces it.

const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const NPM = "@ai-sdk/openai-compatible"

// What a fresh account is most likely granted, from Bailian's own
// catalog — id, context, output, image input. Only the ids are a choice;
// every number comes from the catalog.
const BOOTSTRAP = [
  ["qwen3.8-max", 1_000_000, 131_072, true],
  ["qwen3.8-flash", 1_000_000, 131_072, true],
  ["qwen3.7-max", 1_000_000, 131_072, false],
  ["qwen3.7-flash", 1_000_000, 131_072, true],
  ["qwen3.6-flash", 1_000_000, 65_536, true],
  ["deepseek-v4.1-flash", 1_000_000, 393_216, true],
  ["deepseek-v4-pro", 1_000_000, 393_216, false],
  ["kimi-k3", 1_000_000, 1_048_576, true],
  ["kimi-k2.7-code", 262_144, 16_384, true],
]
export const BOOTSTRAP_IDS = BOOTSTRAP.map(([id]) => id)

// FALLBACK_LIMITS is what an unknown id shows until the catalog says
// better: the smallest context Bailian's chat models have.
const FALLBACK_LIMITS = [32_768, 8_192]

function limitsOf(e) {
  return [e.context > 0 ? e.context : FALLBACK_LIMITS[0], e.output > 0 ? e.output : FALLBACK_LIMITS[1]]
}

// configModels is the provider's bootstrap list, in OpenCode's config
// shape. Marked free — a fresh account's grants cover most of them.
export function configModels() {
  return Object.fromEntries(
    BOOTSTRAP.map(([id, context, output, images]) => [
      id,
      {
        name: id,
        limit: { context, output },
        tool_call: true,
        reasoning: true,
        attachment: images,
        modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
        free: true,
        rate: 0,
      },
    ]),
  )
}

// runtimeModel is one live model in the shape OpenCode's provider.models
// hook returns: the catalog's own limits and abilities, free while a
// grant has room.
export function runtimeModel(provider, e, free) {
  const [context, output] = limitsOf(e)
  const images = e.request.includes("Image")
  const audio = e.request.includes("Audio")
  return {
    id: e.id,
    providerID: provider.id,
    name: e.id,
    api: { id: e.id, url: DASHSCOPE_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output },
    capabilities: {
      temperature: true,
      reasoning: !!e.reasoning,
      attachment: images,
      toolcall: e.tools !== false,
      input: { text: true, image: images, audio, video: e.request.includes("Video"), pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
    free: !!free,
    ...(free ? { rate: 0 } : {}),
  }
}

// mediaModel is a model that only makes images or videos: no chat entry,
// but the modality magpie's images and videos APIs ask for. What it makes
// comes from the grant, so a new magpie kind reading the same field is
// served the day it ships.
export function mediaModel(provider, id, media, free) {
  const kind = media === "video" ? "video" : "image"
  return {
    id,
    providerID: provider.id,
    name: id,
    api: { id, url: DASHSCOPE_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: false, image: kind === "image", audio: false, video: kind === "video", pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
    free: !!free,
    ...(free ? { rate: 0 } : {}),
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
// scoped to that model, ending when the grant does. A window the gateway
// serves drives the allowance; what has no channel is shown aside.
export function grantWindow(grant, aside = grant.media !== "text" && grant.media !== "image" && grant.media !== "video") {
  const unit = grant.unit || "units"
  const used = grant.limit > 0 ? ((grant.limit - grant.left) / grant.limit) * 100 : 0
  return {
    name: grant.model,
    model: grant.model,
    ...(aside ? { aside: true } : { models: [grant.model] }),
    used,
    display: `${fmtAmount(grant.left)} / ${fmtAmount(grant.limit)} ${unit}`,
    amount: grant.limit - grant.left,
    limit: grant.limit,
    unit,
    ...(grant.ends > 0 ? { runsOutAt: new Date(grant.ends).toISOString(), runsOut: grant.left } : {}),
  }
}

export function freeQuotaNote(live, gone) {
  if (live <= 0) return "没有模型还有免费额度"
  const models = `${live} 个模型有免费额度`
  return gone > 0 ? `${models} · ${gone} 个已用完或过期` : models
}
