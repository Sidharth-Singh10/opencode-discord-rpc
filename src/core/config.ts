import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { CLIENT_ID } from "../discord/presence.js"

export interface PresenceOptions {
  enabled: boolean
  automatic: boolean
  shareModel: boolean
  shareAgent: boolean
  shareProject: boolean
  shareMetrics: boolean
  clientId: string
  runtimeDir: string
  warnings: string[]
}

export function resolvePresenceOptions(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): PresenceOptions {
  const warnings: string[] = []
  const boolean = (key: string, fallback: boolean) => {
    if (raw[key] === undefined) return fallback
    if (typeof raw[key] === "boolean") return raw[key]
    warnings.push(`Invalid ${key}; using default.`)
    return fallback
  }
  let clientId = CLIENT_ID
  for (const [name, value] of [["clientId", raw.clientId], ["DISCORD_CLIENT_ID", env.DISCORD_CLIENT_ID]] as const) {
    if (value === undefined) continue
    if (typeof value === "string" && /^[0-9]{17,20}$/.test(value)) clientId = value
    else warnings.push(`Invalid ${name}; using configured/default application.`)
  }
  let runtimeDir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "opencode-presence-discord")
    : join(tmpdir(), `opencode-presence-discord-${process.getuid?.() ?? "local"}`)
  if (raw.runtimeDir !== undefined) {
    if (typeof raw.runtimeDir === "string" && isAbsolute(raw.runtimeDir) && !raw.runtimeDir.includes("\0")) runtimeDir = raw.runtimeDir
    else warnings.push("Invalid runtimeDir; using default.")
  }
  const enabled = boolean("enabled", true)
  return {
    enabled: enabled && !["1", "true"].includes(env.OPENCODE_PRESENCE_DISABLED ?? ""),
    automatic: boolean("automatic", true),
    shareModel: boolean("shareModel", false),
    shareAgent: boolean("shareAgent", false),
    shareProject: boolean("shareProject", false),
    shareMetrics: boolean("shareMetrics", false),
    clientId,
    runtimeDir,
    warnings,
  }
}
