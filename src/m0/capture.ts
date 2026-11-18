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
import { safeAgent, safeModelID, safeProviderID, safeUuid, sanitizeLocality, sanitizeProbe, sanitizePublication, sanitizePublisherEvent, sanitizeRun, sanitizeSnapshot } from "./sanitize.js"

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
  private closed = false
  private closing: Promise<void> | null = null

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
    if (this.closed) return
    const safe = projectEvidence(name, value)
    if (!safe) return
    const file = this.guardName(name)
    const content = JSON.stringify(safe, null, 2) + "\n"
    const sink = this.sink(file)
    sink.chain = sink.chain.then(() => writeFile(join(this.dir, file), content, { mode: 0o600 })).catch(() => {})
    await sink.chain
  }

  /** Queue one JSONL line. Never throws and never blocks the TUI. */
  append(name: string, entry: unknown): void {
    if (this.closed) return
    const safe = projectEvidence(name, entry)
    if (!safe) return
    const file = this.guardName(name)
    let serialized: string
    try {
      serialized = JSON.stringify(safe)
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
    this.closed = true
    this.closing ??= Promise.all([...this.sinks.values()].map((sink) => sink.chain)).then(() => undefined)
    await this.closing
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

type PrimitiveType = "string" | "number" | "boolean" | "object" | "array" | "null"

const PRIMITIVE_TYPES: ReadonlySet<PrimitiveType> = new Set(["string", "number", "boolean", "object", "array", "null"])
const SAFE_PATH = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/

/** Fixed per-type structural paths. Unknown types get only the common envelope. */
const KNOWN_TYPES = new Set([
  "agent.updated",
  "command.updated",
  "form.cancelled",
  "form.created",
  "form.replied",
  "integration.updated",
  "location.shutdown",
  "model.updated",
  "permission.asked",
  "permission.replied",
  "plugin.updated",
  "project.updated",
  "provider.updated",
  "reference.updated",
  "server.connected",
  "session.agent.selected",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.compaction.started",
  "session.created",
  "session.deleted",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.idle",
  "session.inbox.cancelled",
  "session.inbox.delivered",
  "session.inbox.delivery.changed",
  "session.inbox.enqueued",
  "session.instructions.updated",
  "session.message.content.updated",
  "session.metadata.updated",
  "session.model.selected",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.reasoning.started",
  "session.renamed",
  "session.retry.scheduled",
  "session.status",
  "session.step.ended",
  "session.step.failed",
  "session.step.first-token",
  "session.step.started",
  "session.step.streamed",
  "session.text.delta",
  "session.text.ended",
  "session.text.started",
  "session.tool.called",
  "session.tool.failed",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.input.started",
  "session.tool.progress",
  "session.tool.success",
  "session.usage.updated",
  "session.viewed",
  "shell.created",
  "shell.deleted",
  "shell.exited",
  "skill.updated",
  "websearch.updated",
])

const EVENT_SHAPES: Readonly<Record<string, readonly string[]>> = {
  "session.execution.started": ["data.sessionID"],
  "session.execution.succeeded": ["data.sessionID"],
  "session.execution.failed": ["data.sessionID"],
  "session.execution.interrupted": ["data.sessionID", "data.reason"],
  "session.idle": ["data.sessionID"],
  "session.status": ["data.sessionID", "data.status.type", "data.status.attempt"],
  "session.compaction.started": ["data.sessionID", "data.reason"],
  "session.compaction.ended": ["data.sessionID", "data.reason"],
  "session.compaction.failed": ["data.sessionID", "data.reason"],
  "session.retry.scheduled": ["data.sessionID", "data.attempt", "data.at"],
  "session.model.selected": ["data.sessionID", "data.model.providerID", "data.model.id"],
  "session.agent.selected": ["data.sessionID", "data.agentID"],
  "session.tool.called": ["data.sessionID", "data.executed"],
  "session.tool.success": ["data.sessionID", "data.executed"],
  "session.tool.failed": ["data.sessionID", "data.executed"],
  "permission.asked": ["data.id", "data.sessionID", "data.action"],
  "permission.replied": ["data.sessionID", "data.requestID", "data.reply.type"],
  "form.created": ["data.form.id", "data.form.sessionID"],
  "form.replied": ["data.id", "data.sessionID"],
  "form.cancelled": ["data.id", "data.sessionID"],
  "location.shutdown": [],
  "server.connected": [],
}

const COMMON_SHAPE: readonly string[] = ["id", "type", "created", "durable", "location", "data"]

export type CaptureSource = "listen" | "subscribe"

export interface CapturedEvent {
  v: 1
  seq: number
  atMs: number
  source: CaptureSource
  instanceId: string
  type: string
  eventIDHash: string | null
  sessionHash: string | null
  locationHash: string | null
  eventCreatedMs: number | null
  fields: Array<[string, PrimitiveType]>
  values: Record<string, string | number | boolean>
}

export interface CaptureErrorRecord {
  v: 1
  seq: 0
  atMs: number
  source: CaptureSource
  instanceId: string
  type: string
  code: string
}

export type CaptureRecord = CapturedEvent | CaptureErrorRecord

const HASH = /^[0-9a-f]{16}$/
const ERROR_CODES = new Set(["capture-start-failed", "capture-listen-failed", "capture-invalid", "snapshot-startup-failed"])

function primitiveType(value: unknown): PrimitiveType {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value as PrimitiveType
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function structuralFields(event: Record<string, unknown>): Array<[string, PrimitiveType]> {
  const type = typeof event.type === "string" ? event.type : ""
  const fields: Array<[string, PrimitiveType]> = []
  for (const path of COMMON_SHAPE) {
    const value = readPath(event, path)
    if (value !== undefined) fields.push([path, primitiveType(value)])
  }
  for (const path of EVENT_SHAPES[type] ?? []) {
    const value = readPath(event, path)
    if (value !== undefined) fields.push([path, primitiveType(value)])
  }
  return fields
}

function allowedValues(type: string, data: Record<string, unknown>): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {}
  const status = data.status as Record<string, unknown> | undefined
  const reply = data.reply as Record<string, unknown> | undefined
  const model = data.model as Record<string, unknown> | undefined

  if (type === "session.status") {
    if (status?.type === "idle" || status?.type === "retry") values.status = status.type
    if (typeof status?.attempt === "number" && Number.isInteger(status.attempt) && status.attempt >= 0 && status.attempt <= 100) values.attempt = status.attempt
  }
  if (type === "session.execution.interrupted" && ["user", "shutdown", "superseded", "inactivity"].includes(String(data.reason))) {
    values.reason = String(data.reason)
  }
  if ((type === "session.compaction.started" || type === "session.compaction.ended" || type === "session.compaction.failed") && ["auto", "manual"].includes(String(data.reason))) {
    values.reason = String(data.reason)
  }
  if (type === "session.retry.scheduled") {
    if (typeof data.attempt === "number" && Number.isInteger(data.attempt) && data.attempt >= 0 && data.attempt <= 100) values.attempt = data.attempt
    if (typeof data.at === "number" && Number.isSafeInteger(data.at)) values.at = data.at
  }
  if (type === "permission.replied" && ["once", "always", "reject"].includes(String(reply?.type))) {
    values.reply = String(reply?.type)
  }
  if (type === "session.model.selected") {
    const providerID = safeProviderID(model?.providerID)
    const modelID = safeModelID(model?.id)
    if (providerID) values.providerID = providerID
    if (modelID) values.modelID = modelID
  }
  if (type === "session.agent.selected") {
    const agentID = safeAgent(data.agentID)
    if (agentID) values.agentID = agentID
  }
  if ((type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") && typeof data.executed === "boolean") {
    values.executed = data.executed
  }
  return values
}

const VALUE_KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  "session.status": ["status", "attempt"],
  "session.execution.interrupted": ["reason"],
  "session.compaction.started": ["reason"],
  "session.compaction.ended": ["reason"],
  "session.compaction.failed": ["reason"],
  "session.retry.scheduled": ["attempt", "at"],
  "permission.replied": ["reply"],
  "session.model.selected": ["providerID", "modelID"],
  "session.agent.selected": ["agentID"],
  "session.tool.called": ["executed"],
  "session.tool.success": ["executed"],
  "session.tool.failed": ["executed"],
}

const CAPTURE_KEYS = new Set(["v", "seq", "atMs", "source", "instanceId", "type", "eventIDHash", "sessionHash", "locationHash", "eventCreatedMs", "fields", "values"])
const ERROR_KEYS = new Set(["v", "seq", "atMs", "source", "instanceId", "type", "code"])

/** Runtime shape check. Anything unexpected is discarded, never serialized. */
export function validateCaptureRecord(value: unknown): value is CaptureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.v !== 1 || typeof record.atMs !== "number" || !Number.isSafeInteger(record.atMs)) return false
  if (record.source !== "listen" && record.source !== "subscribe") return false
  if (!safeUuid(record.instanceId) && record.instanceId !== "instance") return false
  if (typeof record.type !== "string") return false
  if (ERROR_KEYS.has("code") && "code" in record) {
    for (const key of Object.keys(record)) if (!ERROR_KEYS.has(key)) return false
    return record.seq === 0 && (ERROR_TYPES.has(record.type) || record.type === "event.other") && typeof record.code === "string" && ERROR_CODES.has(record.code)
  }
  if (!KNOWN_TYPES.has(record.type) && record.type !== "event.other") return false
  for (const key of Object.keys(record)) if (!CAPTURE_KEYS.has(key)) return false
  if (record.seq === undefined || typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 0) return false
  for (const key of ["eventIDHash", "sessionHash", "locationHash"] as const) {
    const hash = record[key]
    if (hash !== null && (typeof hash !== "string" || !HASH.test(hash))) return false
  }
  if (record.eventCreatedMs !== null && (typeof record.eventCreatedMs !== "number" || !Number.isSafeInteger(record.eventCreatedMs))) return false
  const allowedPaths = new Set([...COMMON_SHAPE, ...(EVENT_SHAPES[record.type] ?? [])])
  if (!Array.isArray(record.fields)) return false
  for (const field of record.fields) {
    if (!Array.isArray(field) || field.length !== 2) return false
    if (typeof field[0] !== "string" || !SAFE_PATH.test(field[0]) || !allowedPaths.has(field[0])) return false
    if (typeof field[1] !== "string" || !PRIMITIVE_TYPES.has(field[1] as PrimitiveType)) return false
  }
  if (!record.values || typeof record.values !== "object" || Array.isArray(record.values)) return false
  const allowedValueKeys = new Set(VALUE_KEYS_BY_TYPE[record.type] ?? [])
  for (const [key, value] of Object.entries(record.values as Record<string, unknown>)) {
    if (!allowedValueKeys.has(key)) return false
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return false
    if (typeof value === "number" && !Number.isFinite(value)) return false
    if (typeof value === "string" && key === "providerID" && !safeProviderID(value)) return false
    if (typeof value === "string" && key === "modelID" && !safeModelID(value)) return false
    if (typeof value === "string" && key === "agentID" && !safeAgent(value)) return false
    if (typeof value === "string" && key === "reason" && !["user", "shutdown", "superseded", "inactivity", "auto", "manual"].includes(value)) return false
    if (typeof value === "string" && key === "status" && !["idle", "retry"].includes(value)) return false
    if (typeof value === "string" && key === "reply" && !["once", "always", "reject"].includes(value)) return false
  }
  return true
}

export function captureEvent(
  event: unknown,
  source: CaptureSource,
  seq: number,
  salt: string,
  now: number = Date.now(),
  instanceId: string = "instance",
): CapturedEvent | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null
  const record = event as Record<string, unknown>
  if (typeof record.type !== "string" || record.type.length === 0) return null
  const data = (record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {}) as Record<string, unknown>
  const form = data.form as Record<string, unknown> | undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : typeof form?.sessionID === "string" ? form.sessionID : null
  const location = record.location as Record<string, unknown> | undefined
  const eventID = typeof record.id === "string" ? record.id : null
  const createdAt = typeof record.created === "number" && Number.isSafeInteger(record.created) ? record.created : null

  const type = KNOWN_TYPES.has(record.type) ? record.type : "event.other"
  const captured: CapturedEvent = {
    v: 1,
    seq,
    atMs: now,
    source,
    instanceId,
    type,
    eventIDHash: eventID ? pseudonym(salt, eventID) : null,
    sessionHash: sessionID ? pseudonym(salt, sessionID) : null,
    locationHash: location && typeof location.directory === "string" ? pseudonym(salt, location.directory) : null,
    eventCreatedMs: createdAt,
    fields: structuralFields({ ...record, type }),
    values: allowedValues(type, data),
  }
  return validateCaptureRecord(captured) ? captured : null
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
export function captureReference(event: unknown, seq: number, salt: string, now: number = Date.now(), instanceId: string = "instance"): Record<string, unknown> | null {
  const captured = captureEvent(event, "subscribe", seq, salt, now, instanceId)
  return captured ? referenceRecord(captured) : null
}

const ERROR_TYPES = new Set(["command.registration.failed", "capture.start.failed", "capture.listen.error", "snapshot.startup.failed", "observer.error"])

export function errorRecord(type: string, code: string, instanceId: string, source: CaptureSource = "listen"): CaptureErrorRecord {
  const safeCode = ERROR_CODES.has(code) ? code : "capture-invalid"
  const safeType = ERROR_TYPES.has(type) ? type : "event.other"
  return { v: 1, seq: 0, atMs: Date.now(), source, instanceId: safeUuid(instanceId) ?? "instance", type: safeType, code: safeCode }
}

/** Last boundary before serialization. No sink accepts unchecked caller data. */
function projectEvidence(name: string, value: unknown): Record<string, unknown> | CaptureRecord | null {
  if (name === "probe.json") return sanitizeProbe(value)
  if (name === "locality.json") return sanitizeLocality(value)
  if (name === "run.json") return sanitizeRun(value)
  if (name === "snapshot.json" || /^snapshot-[0-9a-f-]+\.json$/i.test(name)) return sanitizeSnapshot(value)
  if (name === "publication.jsonl") return sanitizePublication(value)
  if (/^publisher-[0-9a-f-]+\.jsonl$/i.test(name)) return sanitizePublisherEvent(value)
  if (name === "capture.jsonl" && validateCaptureRecord(value)) {
    if ("code" in value) return errorRecord(value.type, value.code, value.instanceId, value.source)
    return {
      v: 1, seq: value.seq, atMs: value.atMs, source: value.source, instanceId: value.instanceId, type: value.type,
      eventIDHash: value.eventIDHash, sessionHash: value.sessionHash, locationHash: value.locationHash,
      eventCreatedMs: value.eventCreatedMs,
      fields: value.fields.map(([path, type]) => [path, type]),
      values: Object.fromEntries(Object.entries(value.values)),
    }
  }
  if (name === "reference.jsonl" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.source !== "subscribe") return null
    if ("code" in record) {
      const diagnostic: unknown = record
      return validateCaptureRecord(diagnostic) && "code" in diagnostic ? errorRecord(diagnostic.type, diagnostic.code, diagnostic.instanceId, "subscribe") : null
    }
    const allowed = new Set(["v", "seq", "atMs", "source", "instanceId", "type", "eventIDHash", "sessionHash", "locationHash", "eventCreatedMs"])
    if (Object.keys(record).some((key) => !allowed.has(key))) return null
    const full = { ...record, fields: [], values: {} }
    return validateCaptureRecord(full) ? referenceRecord(full as CapturedEvent) : null
  }
  return null
}

export interface CaptureController {
  onListen(event: unknown): void
  onReference(event: unknown): void
  notify(type: string, code: string): void
  referenceTask: Promise<void>
  stop(): void
  flush(): Promise<void>
}

/**
 * Starts the one temporary reference observer used to compare server events
 * against `data.listen`. It is evidence machinery, not architecture, and it
 * never records exception text.
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
    } catch {
      if (!stopped) log.append("reference.jsonl", errorRecord("observer.error", "capture-listen-failed", options.instanceId, "subscribe"))
    }
  })()

  return {
    onListen(event: unknown) {
      if (stopped) return
      listenSeq += 1
      const captured = captureEvent(event, "listen", listenSeq, options.salt, Date.now(), options.instanceId)
      if (captured) log.append("capture.jsonl", captured)
    },
    onReference(event: unknown) {
      if (stopped) return
      referenceSeq += 1
      const record = captureReference(event, referenceSeq, options.salt, Date.now(), options.instanceId)
      if (record) log.append("reference.jsonl", record)
    },
    notify(type: string, code: string) {
      if (stopped) return
      log.append("capture.jsonl", errorRecord(type, code, options.instanceId))
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
