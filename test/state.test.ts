import { describe, expect, test } from "bun:test"
import { reduceActivity, reconcileActivity, type ActivityState } from "../src/core/state.js"

describe("activity states", () => {
  test("tracks a complete execution without relying on session.idle", () => {
    let state: ActivityState = { kind: "idle", at: 0 }
    for (const [event, kind] of [
      ["session.execution.started", "working"],
      ["session.reasoning.delta", "thinking"],
      ["session.text.delta", "typing"],
      ["session.tool.called", "working"],
      ["session.retry.scheduled", "retrying"],
      ["session.execution.succeeded", "idle"],
    ] as const) {
      state = reduceActivity(state, event, 10_000)
      expect(state.kind).toBe(kind)
    }
  })

  test("protects input waits and compaction from stream noise", () => {
    for (const event of ["permission.asked", "form.created", "session.compaction.started"]) {
      const state = reduceActivity({ kind: "working", at: 0 }, event, 10_000)
      expect(reduceActivity(state, "session.text.delta", 11_000)).toBe(state)
      expect(reduceActivity(state, "session.tool.success", 11_000)).toBe(state)
      expect(reconcileActivity(state, false, 13_000)).toBe("idle")
      expect(reconcileActivity(state, true, 41_000)).toBe("working")
    }
  })

  test("failure, interruption and next execution have explicit outcomes", () => {
    const busy: ActivityState = { kind: "working", at: 0 }
    expect(reduceActivity(busy, "session.execution.failed", 10_000).kind).toBe("error")
    expect(reduceActivity(busy, "session.execution.interrupted", 10_000).kind).toBe("idle")
    expect(reduceActivity({ kind: "error", at: 10_000 }, "session.execution.started", 11_000).kind).toBe("working")
  })

  test("fresh events lead cached status; stale detail falls back to authoritative status", () => {
    const state: ActivityState = { kind: "thinking", at: 10_000 }
    expect(reconcileActivity(state, false, 11_000)).toBe("thinking")
    expect(reconcileActivity(state, false, 13_000)).toBe("idle")
    expect(reconcileActivity(state, true, 41_000)).toBe("working")
  })

  test("unknown events and replies for other modes do nothing", () => {
    const state: ActivityState = { kind: "typing", at: 10_000 }
    for (const type of ["PRIVATE_EVENT", "permission.replied", "session.compaction.ended"]) {
      expect(reduceActivity(state, type, 11_000)).toBe(state)
    }
  })
})
