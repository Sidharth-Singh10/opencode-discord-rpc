import { describe, expect, test } from "bun:test"
import { buildPresenceActivity, publicModelLabel } from "../src/core/activity.js"

const startSeconds = 1_790_000_000

describe("release presence model policy", () => {
  test("all providers and missing metadata can publish a generic card", () => {
    for (const model of [
      { providerID: "openai", id: "gpt-6.1-sol" },
      { providerID: "anthropic", id: "claude-custom" },
      { providerID: "private-provider", id: "private-model" },
      { providerID: "sk_live_private", id: "/home/private/project" },
      null, undefined, {},
    ]) {
      expect(buildPresenceActivity({ running: true, startSeconds, model })).toEqual({
        details: "Using OpenCode",
        state: "Working",
        assets: { large_image: "state-working", large_text: "OpenCode" },
        timestamps: { start: startSeconds },
      })
    }
  })

  test("model disclosure is opt-in and outputs only literal reviewed labels", () => {
    const model = { providerID: "openai", id: "gpt-6.1-sol", secret: "PRIVATE" }
    expect(publicModelLabel(model)).toBe("GPT-6.1 Sol")
    const activity = buildPresenceActivity({ running: false, startSeconds, model, shareModel: true })
    expect(activity.state).toBe("GPT-6.1 Sol · Idle")
    expect(activity.assets).toEqual({
      large_image: "state-working", large_text: "OpenCode",
      small_image: "badge-model", small_text: "Model: GPT-6.1 Sol",
    })
    expect(JSON.stringify(activity)).not.toContain("PRIVATE")
  })

  test("opt-in does not copy arbitrary identifiers or coerce malformed metadata", () => {
    for (const model of [
      { id: "ghp_secret", providerID: "custom" },
      { id: "gpt-6.1-sol\nPRIVATE", providerID: "openai" },
      { id: "gpt-6.1-sol", providerID: "private" },
      { id: { toString: () => { throw new Error("must not coerce") } }, providerID: "openai" },
      "PRIVATE", 1, null,
    ]) {
      expect(publicModelLabel(model)).toBeNull()
      expect(buildPresenceActivity({ running: true, startSeconds, model, shareModel: true }).assets)
        .toEqual({ large_image: "state-working", large_text: "OpenCode" })
    }
  })

  test("rejects invalid timestamps instead of inventing a start time", () => {
    for (const value of [NaN, Infinity, 1, startSeconds + 0.5]) {
      expect(() => buildPresenceActivity({ running: true, startSeconds: value })).toThrow()
    }
  })
})

describe("enriched activity", () => {
  const full = {
    running: true,
    startSeconds,
    model: { providerID: "openai", id: "gpt-6.1-sol" },
    agent: "build",
    project: "opencode-discord-rpc",
    metrics: { tokens: 1500, contextPercent: 40, cost: 0.42 },
    shareModel: true,
    shareAgent: true,
    shareProject: true,
    shareMetrics: true,
  }

  test("composes project, model, agent and metrics", () => {
    const activity = buildPresenceActivity(full)
    expect(activity.details).toBe("Working on opencode-discord-rpc")
    expect(activity.state).toBe("GPT-6.1 Sol · build · Working · 40% ctx · 1.5K tok · $0.42")
    expect(activity.assets).toHaveProperty("small_text", "Model: GPT-6.1 Sol")
  })

  test("caps label lengths and removes control characters", () => {
    const activity = buildPresenceActivity({
      running: true, startSeconds, agent: "a\nb\u0000c", project: "p".repeat(300), shareAgent: true, shareProject: true,
    })
    expect(activity.details.length).toBeLessThanOrEqual(128)
    expect(activity.state).toBe("a b c · Working")
    expect(JSON.stringify(activity)).not.toContain("\\u0000")
  })

  test("unknown or absent metrics are omitted, never rendered as zero", () => {
    const activity = buildPresenceActivity({ running: false, startSeconds, metrics: { tokens: null, contextPercent: null, cost: null }, shareMetrics: true })
    expect(activity.state).toBe("Idle")
    expect(buildPresenceActivity({ running: true, startSeconds, metrics: { tokens: 0, cost: 0 }, shareMetrics: true }).state).toBe("Working")
  })

  test("large counts use compact units and percentages clamp to 100", () => {
    const activity = buildPresenceActivity({
      running: true, startSeconds,
      metrics: { tokens: 5_700_000_000, contextPercent: 140, cost: 12.5 },
      shareMetrics: true,
    })
    expect(activity.state).toBe("Working · 100% ctx · 5.7B tok · $12.50")
  })
})
