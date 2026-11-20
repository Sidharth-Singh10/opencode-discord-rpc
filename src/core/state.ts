export type ActivityKind = "working" | "thinking" | "typing" | "asking" | "compacting" | "retrying" | "idle" | "error"

export interface ActivityState {
  kind: ActivityKind
  at: number
}

/** Events influence public state only; their text, names and errors are ignored. */
export function reduceActivity(previous: ActivityState, type: string, now: number): ActivityState {
  let kind: ActivityKind
  if (type === "session.execution.started") kind = "working"
  else if (type === "session.execution.failed") kind = "error"
  else if (type === "session.execution.succeeded" || type === "session.execution.interrupted") kind = "idle"
  else if (type === "permission.asked" || type === "form.created") kind = "asking"
  else if (type === "permission.replied" || type === "form.replied" || type === "form.cancelled") {
    if (previous.kind !== "asking") return previous
    kind = "working"
  } else if (type === "session.compaction.started") kind = "compacting"
  else if (type === "session.compaction.ended" || type === "session.compaction.failed") {
    if (previous.kind !== "compacting") return previous
    kind = "working"
  } else {
    if (previous.kind === "asking" || previous.kind === "compacting") return previous
    if (type === "session.reasoning.started" || type === "session.reasoning.delta") kind = "thinking"
    else if (type === "session.text.started" || type === "session.text.delta") kind = "typing"
    else if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") kind = "working"
    else if (type === "session.retry.scheduled") kind = "retrying"
    else return previous
  }
  return { kind, at: now }
}

export function reconcileActivity(state: ActivityState, running: boolean, now: number): ActivityKind {
  // Let a just-observed event lead the host's cached status briefly. Afterwards
  // authoritative idle releases protected states even when a terminal was lost.
  if (now - state.at < 2_000) return state.kind
  if (!running) return state.kind === "error" ? "error" : "idle"
  // A missing end/reply must not pin a protected state forever.
  if (now - state.at >= 30_000 || state.kind === "idle" || state.kind === "error") return "working"
  return state.kind
}
