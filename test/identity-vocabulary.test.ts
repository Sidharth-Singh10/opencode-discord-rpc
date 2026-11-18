import { describe, expect, test } from "bun:test"

import { readModel, safeAgent, sanitizeInspection, sanitizeModel, sanitizeModelProvenance } from "../src/m0/sanitize.js"

const model = { id: "deepseek-v4.1-flash", providerID: "opencode-go" }

describe("host variant vocabulary", () => {
  for (const variant of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]) {
    test(`accepts the host variant ${variant} and preserves it`, () => {
      expect(readModel({ ...model, variant })).toEqual({ ok: true, model: { ...model, variant } })
      expect(sanitizeModel({ ...model, variant })).toEqual({ ...model, variant })
    })
  }

  test("null means no variant and does not nullify the identity", () => {
    expect(readModel({ ...model, variant: null })).toEqual({ ok: true, model })
    expect(sanitizeModel({ ...model, variant: null })).toEqual(model)
    expect("variant" in (sanitizeModel({ ...model, variant: null }) as object)).toBe(false)
  })

  test("an unreviewed variant refuses with the variant code", () => {
    expect(readModel({ ...model, variant: "ultra" })).toEqual({ ok: false, code: "executed-variant-unknown" })
    expect(readModel({ ...model, variant: "" })).toEqual({ ok: false, code: "executed-variant-unknown" })
    expect(readModel({ ...model, variant: { reasoning: "max" } })).toEqual({ ok: false, code: "executed-variant-unknown" })
  })
})

describe("model, provider and agent vocabularies", () => {
  test("model and provider failures name their own field", () => {
    expect(readModel({ ...model, id: "unknown-model" })).toEqual({ ok: false, code: "executed-model-unknown" })
    expect(readModel({ ...model, id: "" })).toEqual({ ok: false, code: "executed-model-unknown" })
    expect(readModel({ ...model, providerID: "unknown-provider" })).toEqual({ ok: false, code: "executed-provider-unknown" })
    expect(readModel({ ...model, providerID: null })).toEqual({ ok: false, code: "executed-provider-unknown" })
  })

  test("built-in and custom agent identifiers are admitted", () => {
    for (const agent of ["build", "plan", "general", "compaction", "explore", "my-reviewer", "reviewer_2", "team.agent"]) {
      expect(safeAgent(agent)).toBe(agent)
    }
  })

  test("an agent identifier is capped at 64 characters", () => {
    expect(safeAgent(`a${"b".repeat(63)}`)).toBe(`a${"b".repeat(63)}`)
    expect(safeAgent(`a${"b".repeat(64)}`)).toBeNull()
  })

  test("free text, paths, queries and mixed-case credentials are not agent identifiers", () => {
    for (const agent of ["", " agent", "agent name", "agent/other", "agent=other", "Agent", "sk-live-CRITIC-SECRET", "-leading", "a\nb"]) {
      expect(safeAgent(agent)).toBeNull()
    }
  })

  test("inspection and provenance keep a custom agent and a host variant", () => {
    const inspection = sanitizeInspection({
      observedAt: "2026-01-01T00:00:00.000Z",
      sessionIDHash: "0123456789abcdef",
      found: true,
      status: "running",
      sessionCost: 0,
      reportedCost: 0,
      tokens: null,
      selectedModel: { ...model, variant: "xhigh" },
      executedModel: { ...model, variant: "max" },
      agent: "my-reviewer",
      messageCount: 1,
      latestUserMessageAtMs: 1_750_000_000_123,
      latestUserMessageSource: "session.message.list[].type=user.time.created",
      candidateTimestampSeconds: 1_750_000_000,
      candidateTimestampError: null,
      timestampOriginalUnits: "milliseconds since Unix epoch (converted with floor(ms/1000))",
      errorCodes: [],
    })
    expect((inspection as Record<string, unknown>).executedModel).toEqual({ ...model, variant: "max" })
    expect((inspection as Record<string, unknown>).agent).toBe("my-reviewer")
    expect(sanitizeModelProvenance({ selected: null, executed: { ...model, variant: "none" }, agent: "general", sessionCost: null, reportedCost: null, tokens: null })).toEqual({
      selected: null,
      executed: { ...model, variant: "none" },
      agent: "general",
      sessionCost: null,
      reportedCost: null,
      tokens: null,
    })
  })
})
