// Bailian's public model catalog: the console's own model list, paged,
// flat (a group's items stand alone; the group's own id is not a model).
// It needs no sign-in — the gateway lists models for any token — and it
// carries what a proper model entry needs: real context and output
// limits, request and response modalities, and features such as
// function calling. Everything the plugin offers as a model is built
// from this; nothing is guessed.

import { API_LIST_MODELS, callConsoleApi, changedError } from "./console.mjs"

const CATALOG_TTL_MS = 10 * 60 * 1000
const MAX_PAGES = 40

// pageModels is one page's models as the plugin shapes them: a group's
// items stand alone, the group's own id is not a model.
export function pageModels(payload) {
  const total = Number(payload?.total)
  if (!Number.isFinite(total)) throw changedError()
  const out = []
  for (const m of Array.isArray(payload?.list) ? payload.list : []) {
    const items = Array.isArray(m?.items) && m.items.length ? m.items : [m]
    for (const it of items) {
      const e = modelEntry(it)
      if (e && !out.some((x) => x.id === e.id)) out.push(e)
    }
  }
  return { total, models: out }
}

// modelEntry is one catalog model as the plugin shapes it, or null for
// what has no id.
export function modelEntry(m) {
  const id = String(m?.model ?? "").trim()
  if (!id) return null
  const info = m?.modelInfo ?? {}
  const inference = m?.inferenceMetadata ?? {}
  const request = Array.isArray(inference.request_modality) ? inference.request_modality.map(String) : []
  const response = Array.isArray(inference.response_modality) ? inference.response_modality.map(String) : []
  const caps = Array.isArray(m?.capabilities) ? m.capabilities.map(String) : []
  const features = Array.isArray(m?.features) ? m.features.map(String) : []
  return {
    id,
    provider: String(m?.provider ?? "").trim(),
    categories: (Array.isArray(m?.categories) ? m.categories : []).map(String),
    // the model's own numbers; a grouped entry may only carry its window
    context: Number(info.contextWindow ?? m?.maxContextWindow ?? 0) || 0,
    output: Number(info.maxOutputTokens ?? 0) || 0,
    request,
    response,
    caps,
    tools: features.includes("function-calling"),
    reasoning: caps.includes("Reasoning") || Number(info.maxReasoningTokens ?? 0) > 0,
  }
}

// servable is whether a catalog model is a chat model this provider can
// forward: text in, text out, text generation — not a realtime or
// transcription endpoint, not an image or speech maker.
export function servable(e) {
  if (!e.caps.includes("TG")) return false
  if (!e.request.includes("Text") || !e.response.includes("Text")) return false
  return !/(?:^|-)(?:realtime|streaming|filetrans|message)(?:-[0-9-]+)?$/.test(e.id)
}

let catalogCache = { site: "", at: 0, entries: null }

export function resetCatalogCache() {
  catalogCache = { site: "", at: 0, entries: null }
}

// fetchModelCatalog is every model's entry, id-keyed, from the public
// list — servable or not (the grants decide which are free, and the
// usage card names what the non-text ones are). It throws only when the
// console can't be read at all.
export async function fetchModelCatalog({ token = "public", site = "", region = "", fetch: doFetch = fetch, env = process.env } = {}) {
  if (catalogCache.entries && catalogCache.site === site && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.entries
  }
  const call = (api, data) => callConsoleApi({ api, data, token, site, region, fetch: doFetch, env })
  const byId = new Map()
  for (let page = 1, pages = 1; page <= pages && page <= MAX_PAGES; page++) {
    const inner = await call(API_LIST_MODELS, {
      input: {
        pageNo: page, pageSize: 50, name: "", providers: [], inferenceProviders: [],
        features: [], group: true, capabilities: [], contextWindows: [],
      },
    })
    const { total, models } = pageModels(inner)
    pages = Math.ceil(total / 50) || 1
    for (const e of models) byId.set(e.id, e)
  }
  catalogCache = { site, at: Date.now(), entries: byId }
  return byId
}
