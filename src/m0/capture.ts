/**
 * Opt-in, asynchronous, bounded evidence capture.
 *
 * Only allowlisted structure and primitive values leave an event. Whole
 * events, contexts, sessions, prompts, reasoning, deltas, tool input/output,
 * paths, titles, permission resources, form answers, errors and credentials
 * are never serialized.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Context } from "@opencode/plugin/tui/plugin"

import { pseudonym } from "./probe.js"

export interface EvidenceOptions {
  dir: string
  runId: string
  maxBytesPerFile?: number
}

interface SinkState {
  chain: Promise<void>
  bytes: number
  dropped: number
  overflowNoted: boolean
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

export class EvidenceLog {
  readonly dir: string
  readonly runId: string
  private readonly maxBytes: number
  private readonly sinks = new Map<string, SinkState>()
  private ready: Promise<void> | null = null

  constructor(options: EvidenceOptions) {
    this.dir = options.dir
    this.runId = options.runId
    this.maxBytes = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES
  }

  init(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined)
    }
    return this.ready
  }

  /** Overwrite a single JSON document (run.json, snapshot-*.json). */
  async writeJson(name: string, value: unknown): Promise<void> {
    await this.init()
    await writeFile(join(this.dir, this.guardName(name)), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  }

  /** Queue one JSONL line. Never throws and never blocks the TUI. */
  append(name: string, entry: unknown): void {
    const file = this.guardName(name)
    let serialized: string
    try {
      serialized = JSON.stringify(entry)
    } catch {
      return
    }
    if (serialized === undefined) return
    const line = serialized + "\n"
    const sink = this.sink(file)
    if (sink.bytes + Buffer.byteLength(line) > this.maxBytes) {
      sink.dropped += 1
      if (!sink.overflowNoted) {
        sink.overflowNoted = true
        const marker = JSON.stringify({ v: 1, atMs: Date.now(), type: "capture.overflow", file, maxBytes: this.maxBytes }) + "\n"
        sink.bytes += Buffer.byteLength(marker)
        sink.chain = sink.chain.then(() => this.appendRaw(file, marker)).catch(() => {})
      }
      return
    }
    sink.bytes += Buffer.byteLength(line)
    sink.chain = sink.chain.then(() => this.appendRaw(file, line)).catch(() => {})
  }

  dropped(name: string): number {
    return this.sinks.get(this.guardName(name))?.dropped ?? 0
  }

  async close(): Promise<void> {
    await this.init()
    await Promise.all([...this.sinks.values()].map((sink) => sink.chain))
  }

  private sink(file: string): SinkState {
    let sink = this.sinks.get(file)
    if (!sink) {
      sink = { chain: this.init(), bytes: 0, dropped: 0, overflowNoted: false }
      this.sinks.set(file, sink)
    }
    return sink
  }

  private appendRaw(file: string, line: string): Promise<void> {
    return appendFile(join(this.dir, file), line, { mode: 0o600 })
  }

  private guardName(name: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) throw new Error(`unsafe evidence file name: ${name}`)
    return name
  }
}

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,48}$/
const STOP_CONTAINERS = new Set([
  "input",
  "content",
  "metadata",
  "native",
  "error",
  "resources",
  "save",
  "message",
  "answer",
  "fields",
  "text",
  "files",
  "agents",
  "skills",
  "form",
  "title",
  "permissions",
  "system",
  "description",
  "prompt",
  "reasoning",
  "delta",
])

export type CaptureSource = "listen" | "subscribe"

export interface CapturedEvent {
  v: 1
  seq: number
  atMs: number
  source: CaptureSource
  type: string
  eventIDHash: string | null
  sessionHash: string | null
  locationHash: string | null
  instanceId: string | null
  eventCreatedMs: number | null
  fields: Array<[string, string]>
  values: Record<string, string | number | boolean>
}

function primitiveType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function structuralFields(event: Record<string, unknown>): Array<[string, string]> {
  const fields: Array<[string, string]> = []
  const visit = (value: unknown, path: string, depth: number): void => {
    if (fields.length >= 80) return
    if (path) fields.push([path, primitiveType(value)])
    if (depth >= 3 || value === null || typeof value !== "object" || Array.isArray(value)) return
    if (path && STOP_CONTAINERS.has(path.split(".").pop() ?? "")) return
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!SAFE_KEY.test(key)) continue
      visit((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1)
    }
  }
  visit(event, "", 0)
  return fields
}

function allowedValues(event: Record<string, unknown>): Record<string, string | number | boolean> {
  const type = typeof event.type === "string" ? event.type : "unknown"
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>
  const values: Record<string, string | number | boolean> = {}

  const status = data.status as Record<string, unknown> | undefined
  switch (type) {
    case "session.status":
      if (status && typeof status.type === "string") values.status = status.type
      if (status && typeof status.attempt === "number") values.attempt = status.attempt
      break
    case "session.execution.interrupted":
      if (typeof data.reason === "string") values.reason = data.reason
      break
    case "session.compaction.started":
    case "session.compaction.ended":
      if (typeof data.reason === "string") values.reason = data.reason
      break
    case "session.retry.scheduled":
      if (typeof data.attempt === "number") values.attempt = data.attempt
      if (typeof data.at === "number") values.at = data.at
      break
    case "permission.replied": {
      const reply = data.reply as Record<string, unknown> | undefined
      if (reply && typeof reply.type === "string") values.reply = reply.type
      break
    }
    case "session.model.selected": {
      const model = data.model as Record<string, unknown> | undefined
      if (model && typeof model.providerID === "string") values.providerID = model.providerID
      if (model && typeof model.id === "string") values.modelID = model.id
      break
    }
    case "session.agent.selected":
      if (typeof data.agentID === "string") values.agentID = data.agentID
      break
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
      if (typeof data.executed === "boolean") values.executed = data.executed
      break
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.idle":
    case "location.shutdown":
    case "form.created":
    case "form.replied":
    case "form.cancelled":
    case "permission.asked":
      break
    default:
      break
  }
  return values
}

export function captureEvent(
  event: unknown,
  source: CaptureSource,
  seq: number,
  salt: string,
  now: number = Date.now(),
  instanceId: string | null = null,
): CapturedEvent | null {
  if (!event || typeof event !== "object") return null
  const record = event as Record<string, unknown>
  if (typeof record.type !== "string") return null
  const data = (record.data && typeof record.data === "object" ? record.data : {}) as Record<string, unknown>
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  const location = record.location as Record<string, unknown> | undefined
  const eventID = typeof record.id === "string" ? record.id : null

  return {
    v: 1,
    seq,
    atMs: now,
    source,
    type: record.type,
    eventIDHash: eventID ? pseudonym(salt, eventID) : null,
    sessionHash: typeof sessionID === "string" ? pseudonym(salt, sessionID) : null,
    locationHash: location && typeof location.directory === "string" ? pseudonym(salt, location.directory) : null,
    instanceId,
    eventCreatedMs: typeof record.created === "number" ? record.created : null,
    fields: structuralFields(record),
    values: allowedValues(record),
  }
}

export function referenceRecord(captured: CapturedEvent): Record<string, unknown> {
  return {
    v: captured.v,
    seq: captured.seq,
    atMs: captured.atMs,
    source: captured.source,
    type: captured.type,
    eventIDHash: captured.eventIDHash,
    sessionHash: captured.sessionHash,
    locationHash: captured.locationHash,
    instanceId: captured.instanceId,
    eventCreatedMs: captured.eventCreatedMs,
  }
}

/** Reference records carry identity and timing only: no structure, no values. */
export function captureReference(event: unknown, seq: number, salt: string, now: number = Date.now(), instanceId: string | null = null): Record<string, unknown> | null {
  const captured = captureEvent(event, "subscribe", seq, salt, now, instanceId)
  return captured ? referenceRecord(captured) : null
}

export interface CaptureController {
  onListen(event: unknown): void
  onReference(event: unknown): void
  notify(type: string, detail?: string): void
  referenceTask: Promise<void>
  stop(): void
  flush(): Promise<void>
}

/**
 * Starts the one temporary reference observer used to compare server events
 * against `data.listen`. It is evidence machinery, not architecture.
 */
export function startCapture(
  log: EvidenceLog,
  options: { salt: string; reference: boolean; context: Context; instanceId: string },
): CaptureController {
  let listenSeq = 0
  let referenceSeq = 0
  const abort = new AbortController()
  let stopped = false

  const referenceTask = (async () => {
    if (!options.reference) return
    try {
      for await (const event of options.context.client.event.subscribe({ signal: abort.signal })) {
        if (stopped) break
        referenceSeq += 1
        const record = captureReference(event, referenceSeq, options.salt, Date.now(), options.instanceId)
        if (record) log.append("reference.jsonl", record)
      }
    } catch (error) {
      if (!stopped) {
        log.append("reference.jsonl", {
          v: 1,
          seq: referenceSeq + 1,
          atMs: Date.now(),
          source: "subscribe",
          type: "observer.error",
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })()

  return {
    onListen(event: unknown) {
      listenSeq += 1
      const captured = captureEvent(event, "listen", listenSeq, options.salt, Date.now(), options.instanceId)
      if (captured) log.append("capture.jsonl", captured)
    },
    onReference(event: unknown) {
      referenceSeq += 1
      const record = captureReference(event, referenceSeq, options.salt, Date.now(), options.instanceId)
      if (record) log.append("reference.jsonl", record)
    },
    notify(type: string, detail?: string) {
      log.append("capture.jsonl", { v: 1, seq: 0, atMs: Date.now(), source: "listen", type, ...(detail ? { detail } : {}) })
    },
    referenceTask,
    stop() {
      stopped = true
      abort.abort()
    },
    async flush() {
      await log.close()
    },
  }
}
