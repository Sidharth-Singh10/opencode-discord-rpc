import { CLIENT_ID } from "../discord/presence.js"
import type { ActivityKind } from "./state.js"

export { CLIENT_ID }

// Only literal, reviewed labels may be derived from host metadata. Unknown
// identities still publish; they simply do not get a model label.
const MODEL_LABELS = new Map([
  ["openai/gpt-6.1-sol", "GPT-6.1 Sol"],
  ["opencode/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["opencode/deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash"],
  ["opencode-go/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["opencode-go/deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash"],
])

const STATE_LABELS: Record<ActivityKind, string> = {
  working: "Working", thinking: "Thinking", typing: "Writing",
  asking: "Waiting for input", compacting: "Compacting context",
  retrying: "Retrying", idle: "Idle", error: "Task failed",
}

export function publicModelLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const { id, providerID } = value as Record<string, unknown>
  if (typeof id !== "string" || typeof providerID !== "string") return null
  return MODEL_LABELS.get(`${providerID}/${id}`) ?? null
}

/** Strip control characters, collapse whitespace and cap the label length. */
function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return text ? text.slice(0, max) : null
}

function compactCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return String(Math.round(value))
}

export interface PresenceMetrics {
  /** Cumulative input + output tokens for the session. */
  tokens?: number | null
  /** Percentage of the model's context window in use. */
  contextPercent?: number | null
  /** Reported cost in USD. */
  cost?: number | null
}

export interface BuiltActivity {
  details: string
  state: string
  assets: {
    large_image: string
    large_text: string
    small_image?: string
    small_text?: string
  }
  timestamps: { start: number }
}

export function buildPresenceActivity(input: {
  running: boolean
  startSeconds: number
  model?: unknown
  agent?: unknown
  project?: unknown
  metrics?: PresenceMetrics
  state?: ActivityKind
  shareModel?: boolean
  shareAgent?: boolean
  shareProject?: boolean
  shareMetrics?: boolean
}): BuiltActivity {
  if (!Number.isSafeInteger(input.startSeconds) || input.startSeconds < 1_000_000_000) {
    throw new Error("Invalid presence timestamp")
  }
  const model = input.shareModel ? publicModelLabel(input.model) : null
  const agent = input.shareAgent ? cleanLabel(input.agent, 24) : null
  const project = input.shareProject ? cleanLabel(input.project, 80) : null

  const segments = [model, agent, input.state ? STATE_LABELS[input.state] : input.running ? "Working" : "Idle"]
  if (input.shareMetrics) {
    const metrics = input.metrics
    if (metrics?.contextPercent !== null && metrics?.contextPercent !== undefined && Number.isFinite(metrics.contextPercent)) {
      segments.push(`${Math.max(0, Math.min(100, Math.round(metrics.contextPercent)))}% ctx`)
    }
    if (metrics?.tokens !== null && metrics?.tokens !== undefined && metrics.tokens > 0) {
      segments.push(`${compactCount(metrics.tokens)} tok`)
    }
    if (metrics?.cost !== null && metrics?.cost !== undefined && metrics.cost > 0) {
      segments.push(`$${metrics.cost.toFixed(2)}`)
    }
  }

  return {
    details: (project ? `Working on ${project}` : "Using OpenCode").slice(0, 128),
    state: segments.filter(Boolean).join(" · ").slice(0, 128),
    assets: {
      large_image: "state-working",
      large_text: "OpenCode",
      ...(model ? { small_image: "badge-model", small_text: `Model: ${model}` } : {}),
    },
    timestamps: { start: input.startSeconds },
  }
}
