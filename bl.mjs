// The Bailian CLI's sign-in (bl login): ~/.bailian/config.json, or
// $BAILIAN_CONFIG_DIR, read only — the plugin never writes it and never
// spends what only bl can renew. Its top level is the default profile;
// active_config names another profile kept as a nested object.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function blConfigPath(env = process.env) {
  const d = String(env.BAILIAN_CONFIG_DIR ?? "").trim()
  return join(d || join(homedir(), ".bailian"), "config.json")
}

// readBailianCLIProfile is the active profile's values, or null when bl is
// signed out (no console token and no AccessKey).
export function readBailianCLIProfile(env = process.env) {
  let raw
  try {
    const p = blConfigPath(env)
    const st = statSync(p)
    if (!st.isFile() || st.size <= 0 || st.size > 256 * 1024) return null
    raw = JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  let profile = raw
  const active = String(raw.active_config ?? "").trim()
  if (active && raw[active] && typeof raw[active] === "object" && !Array.isArray(raw[active])) {
    profile = raw[active]
  }
  const token = String(profile.access_token ?? "").trim()
  const apiKey = String(profile.api_key ?? "").trim()
  const accessKeyId = String(profile.access_key_id ?? "").trim()
  if (!token && !accessKeyId) return null
  const site = ["international", "intl"].includes(String(profile.console_site ?? "")) ? "international" : ""
  return { token, site, region: String(profile.console_region ?? "").trim(), apiKey }
}
