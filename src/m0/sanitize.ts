/**
 * Evidence projection. Every value that reaches an evidence sink passes one of
 * these projectors first. They are runtime allowlists, not TypeScript-shaped
 * assertions: unknown keys are never copied, metadata uses a finite vocabulary,
 * numeric versions are checked and enums are checked at runtime.
 */
import { validateActivity } from "../discord/presence.js"

export const HASH = /^[0-9a-f]{16}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const VERSION = /^[0-9]+(\.[0-9]+){0,3}$/

// M0 is a transmission spike, not a general metadata exporter. A grammar
// alone would accept an API key or private label shaped like an identifier.
// Extend these reviewed vocabularies explicitly; never learn them from events.
const METADATA = new Set([
  "opencode", "opencode-go", "deepseek-v4.1-flash", "deepseek-v4.1-flash-free",
  "build", "plan", "default", "high", "medium", "low",
])

export type Primitive = string | number | boolean

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && METADATA.has(value) ? value : null
}

export function safeVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value) ? value : null
}

export function safeIso(value: unknown): string | null {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : null
}

export function safeHash(value: unknown): string | null {
  return typeof value === "string" && HASH.test(value) ? value : null
}

export function safeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null
}

export function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

export function safeInt(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

export function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function safeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

export interface SafeModel {
  id: string
  providerID: string
  variant?: string
}

export function sanitizeModel(value: unknown): SafeModel | null {
  const model = asObject(value)
  if (!model) return null
  const id = safeIdentifier(model.id)
  const providerID = safeIdentifier(model.providerID)
  if (!id || !providerID) return null
  // An identity that ran with an unreviewed variant is not the identity we can
  // name. Dropping the variant would silently publish a different identity.
  const variant = model.variant === undefined ? undefined : safeIdentifier(model.variant)
  if (!variant && model.variant !== undefined) return null
  return { id, providerID, ...(variant ? { variant } : {}) }
}

export interface SafeTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function sanitizeTokens(value: unknown): SafeTokens | null {
  const tokens = asObject(value)
  if (!tokens) return null
  const input = safeInt(tokens.input, 0)
  const output = safeInt(tokens.output, 0)
  const reasoning = safeInt(tokens.reasoning, 0)
  const cacheRead = safeInt(tokens.cacheRead, 0)
  const cacheWrite = safeInt(tokens.cacheWrite, 0)
  if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null) return null
  return { input, output, reasoning, cacheRead, cacheWrite }
}

const SESSION_ERROR_CODES = new Set([
  "session-sync-failed",
  "session-status-failed",
  "session-cost-failed",
  "model-selection-unavailable",
  "message-sync-failed",
])
const STATUSES = ["idle", "running"] as const
const TIMESTAMP_ERRORS = ["timestamp-missing", "timestamp-invalid", "timestamp-implausible", "timestamp-future"] as const

export function sanitizeInspection(value: unknown): Record<string, unknown> | null {
  const inspection = asObject(value)
  if (!inspection) return null
  const observedAt = safeIso(inspection.observedAt)
  const sessionIDHash = inspection.sessionIDHash === null ? null : safeHash(inspection.sessionIDHash)
  const found = typeof inspection.found === "boolean" ? inspection.found : null
  const status = inspection.status === null ? null : safeEnum(inspection.status, STATUSES)
  const sessionCost = inspection.sessionCost === null ? null : safeNumber(inspection.sessionCost)
  const reportedCost = inspection.reportedCost === null ? null : safeNumber(inspection.reportedCost)
  const tokens = inspection.tokens === null ? null : sanitizeTokens(inspection.tokens)
  const selectedModel = inspection.selectedModel === null ? null : sanitizeModel(inspection.selectedModel)
  const executedModel = inspection.executedModel === null ? null : sanitizeModel(inspection.executedModel)
  const agent = inspection.agent === null ? null : safeIdentifier(inspection.agent)
  const messageCount = safeInt(inspection.messageCount, 0)
  const latestUserMessageAtMs = inspection.latestUserMessageAtMs === null ? null : safeInt(inspection.latestUserMessageAtMs, 1)
  const latestUserMessageSource =
    inspection.latestUserMessageSource === null
      ? null
      : inspection.latestUserMessageSource === "session.message.list[].type=user.time.created"
        ? inspection.latestUserMessageSource
        : null
  const candidateTimestampSeconds = inspection.candidateTimestampSeconds === null ? null : safeInt(inspection.candidateTimestampSeconds, 1)
  const candidateTimestampError = inspection.candidateTimestampError === null ? null : safeEnum(inspection.candidateTimestampError, TIMESTAMP_ERRORS)
  const timestampOriginalUnits =
    inspection.timestampOriginalUnits === null
      ? null
      : inspection.timestampOriginalUnits === "milliseconds since Unix epoch (converted with floor(ms/1000))"
        ? inspection.timestampOriginalUnits
        : null
  const errorCodes = Array.isArray(inspection.errorCodes)
    ? inspection.errorCodes.filter((code): code is string => typeof code === "string" && SESSION_ERROR_CODES.has(code))
    : []
  if (observedAt === null || found === null || messageCount === null) return null
  return {
    observedAt,
    sessionIDHash,
    found,
    status,
    sessionCost,
    reportedCost,
    tokens,
    selectedModel,
    executedModel,
    agent,
    messageCount,
    latestUserMessageAtMs,
    latestUserMessageSource,
    candidateTimestampSeconds,
    candidateTimestampError,
    timestampOriginalUnits,
    errorCodes,
  }
}

const LOCALITY_CLASSES = ["local", "remote", "unknown"] as const
const ENRICHMENT = ["allowed", "refused"] as const
const LOCALITY_REASONS = ["host-and-urls-match", "host-mismatch", "url-not-loopback", "identity-incomplete", "server-info-unavailable"] as const

export function sanitizeLocality(value: unknown): Record<string, unknown> | null {
  const locality = asObject(value)
  if (!locality) return null
  const klass = safeEnum(locality.class, LOCALITY_CLASSES)
  const enrichment = safeEnum(locality.enrichment, ENRICHMENT)
  const reason = safeEnum(locality.reason, LOCALITY_REASONS)
  const fingerprint = locality.serverFingerprint === null ? null : safeHash(locality.serverFingerprint)
  const observedAt = safeIso(locality.observedAt)
  const evidence = asObject(locality.evidence)
  if (!klass || !enrichment || !reason || !observedAt || !evidence) return null
  if (klass !== "local" && enrichment !== "refused") return null
  if (klass === "local" && (enrichment !== "allowed" || !fingerprint)) return null
  const method = safeEnum(evidence.method, ["server.info", "none"] as const)
  const hostnamePresent = safeBoolean(evidence.hostnamePresent)
  const hostnameMatches = evidence.hostnameMatches === null ? null : safeBoolean(evidence.hostnameMatches)
  const urlCount = safeInt(evidence.urlCount, 0)
  const allUrlsLoopback = evidence.allUrlsLoopback === null ? null : safeBoolean(evidence.allUrlsLoopback)
  if (!method || hostnamePresent === null || urlCount === null) return null
  return {
    class: klass,
    enrichment,
    reason,
    serverFingerprint: fingerprint,
    evidence: { method, hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback },
    observedAt,
  }
}

export function sanitizeProbeStage(value: unknown, net: boolean): Record<string, unknown> | null {
  const stage = asObject(value)
  if (!stage) return null
  const ok = safeBoolean(stage.ok)
  if (ok === null) return null
  const result: Record<string, unknown> = { ok }
  if (net) {
    const createConnection = safeBoolean(stage.createConnection)
    if (createConnection === null) return null
    result.createConnection = createConnection
  }
  if (stage.code !== undefined) {
    const code = safeEnum(stage.code, ["import-failed", "probe-failed", "select-mismatch"] as const)
    if (code) result.code = code
  }
  if (stage.selectOne !== undefined) {
    const selectOne = safeInt(stage.selectOne)
    if (selectOne !== null) result.selectOne = selectOne
  }
  return result
}

export function sanitizeProbe(value: unknown): Record<string, unknown> | null {
  const probe = asObject(value)
  if (!probe) return null
  const observedAt = safeIso(probe.observedAt)
  const host = asObject(probe.host)
  const imports = asObject(probe.imports)
  const sqlite = asObject(probe.sqlite)
  if (!observedAt || !host || !imports || !sqlite) return null
  const version = safeVersion(host.version)
  const channel = safeEnum(host.channel, ["latest", "dev", "canary", "test", "unknown"] as const)
  const kind = safeEnum(host.kind, ["bun", "node", "unknown"] as const)
  const platform = safeEnum(host.platform, ["linux", "darwin", "win32", "freebsd", "openbsd", "unknown"] as const)
  const arch = safeEnum(host.arch, ["x64", "arm64", "arm", "ia32", "unknown"] as const)
  const pid = safeInt(host.pid, 0)
  if (!version || !channel || !kind || !platform || !arch || pid === null) return null
  const safeHost: Record<string, unknown> = { version, channel, kind, platform, arch, pid }
  for (const key of ["bun", "node"] as const) {
    if (host[key] !== undefined) {
      const v = safeVersion(host[key])
      if (v) safeHost[key] = v
    }
  }
  const net = sanitizeProbeStage(imports.net, true)
  const bun = sanitizeProbeStage(imports["bun:sqlite"], false)
  const node = sanitizeProbeStage(imports["node:sqlite"], false)
  if (!net || !bun || !node) return null
  const usable = safeBoolean(sqlite.usable)
  const sqliteKind = safeEnum(sqlite.kind, ["bun:sqlite", "node:sqlite"] as const)
  if (usable === null || !sqliteKind) return null
  const safeSqlite: Record<string, unknown> = { usable, kind: sqliteKind }
  if (sqlite.selectOne !== undefined) {
    const selectOne = safeInt(sqlite.selectOne)
    if (selectOne !== null) safeSqlite.selectOne = selectOne
  }
  return { observedAt, host: safeHost, imports: { net, "bun:sqlite": bun, "node:sqlite": node }, sqlite: safeSqlite }
}

export function sanitizeRun(value: unknown): Record<string, unknown> | null {
  const run = asObject(value)
  if (!run) return null
  const runId = safeUuid(run.runId)
  const instanceId = safeUuid(run.instanceId)
  const startedAt = safeIso(run.startedAt)
  const probe = sanitizeProbe({ observedAt: run.startedAt, host: run.host, imports: run.imports, sqlite: run.sqlite })
  const locality = sanitizeLocality(run.locality)
  const options = asObject(run.options)
  if (!runId || !instanceId || !startedAt || !probe || !locality || !options) return null
  const capture = safeBoolean(options.capture)
  const live = safeBoolean(options.live)
  const captureReference = safeBoolean(options.captureReference)
  if (capture === null || live === null || captureReference === null) return null
  return {
    v: 1,
    runId,
    instanceId,
    pluginId: "opencode-presence-discord",
    packageVersion: "0.0.1",
    startedAt,
    host: probe.host,
    sqlite: probe.sqlite,
    imports: probe.imports,
    locality,
    options: { capture, live, captureReference },
    discordSocket: safeEnum(run.discordSocket, ["env", "default"] as const) ?? "default",
  }
}

export function sanitizeAnchor(value: unknown): Record<string, unknown> | null {
  const anchor = asObject(value)
  if (!anchor) return null
  const seconds = safeInt(anchor.seconds, 1_000_000_000)
  const sourceCreatedMs = safeInt(anchor.sourceCreatedMs, 1)
  const committedMs = safeInt(anchor.committedMs, 0)
  if (seconds === null || sourceCreatedMs === null || committedMs === null || seconds !== Math.floor(sourceCreatedMs / 1000)) return null
  return { seconds, sourceCreatedMs, committedMs }
}

export function sanitizeOwnerRow(value: unknown): Record<string, unknown> | null {
  const row = asObject(value)
  if (!row) return null
  const instanceId = safeUuid(row.instanceId)
  const pid = safeInt(row.pid, 0)
  const generation = safeUuid(row.generation)
  const fence = safeInt(row.fence, 0)
  const acquiredMs = safeInt(row.acquiredMs, 0)
  const heartbeatMs = safeInt(row.heartbeatMs, 0)
  if (!instanceId || pid === null || !generation || fence === null || acquiredMs === null || heartbeatMs === null) return null
  return { instanceId, pid, generation, fence, acquiredMs, heartbeatMs }
}

export function sanitizeAcquisition(value: unknown): Record<string, unknown> | null {
  const acquisition = asObject(value)
  if (!acquisition) return null
  const status = safeEnum(acquisition.status, ["acquired", "renewed", "takeover", "contended", "revoked", "error"] as const)
  if (!status) return null
  const result: Record<string, unknown> = { status }
  if (acquisition.fence !== undefined) {
    const fence = safeInt(acquisition.fence, 0)
    if (fence !== null) result.fence = fence
  }
  if (acquisition.code !== undefined) {
    const code = safeEnum(acquisition.code, ["store-unavailable", "closed", "contended", "acquire-failed", "renew-failed", "release-failed", "critical-failed"] as const)
    if (code) result.code = code
  }
  if (acquisition.reason !== undefined) {
    const reason = safeEnum(acquisition.reason, ["fence-changed", "owner-row-gone", "release-fence-mismatch", "fence-mismatch"] as const)
    if (reason) result.reason = reason
  }
  if (acquisition.previous !== undefined) {
    const previous = sanitizeOwnerRow(acquisition.previous)
    if (previous) result.previous = previous
  }
  if (acquisition.owner !== undefined) {
    const owner = sanitizeOwnerRow(acquisition.owner)
    if (owner) result.owner = owner
  }
  return result
}

export function sanitizeSnapshot(value: unknown): Record<string, unknown> | null {
  const snapshot = asObject(value)
  if (!snapshot) return null
  const at = safeIso(snapshot.at)
  const runId = safeUuid(snapshot.runId)
  const instanceId = safeUuid(snapshot.instanceId)
  const pid = safeInt(snapshot.pid, 0)
  const generation = safeUuid(snapshot.generation)
  const kind = safeEnum(snapshot.kind, ["startup-mid-task", "manual-snapshot"] as const)
  if (!at || !runId || !instanceId || pid === null || !generation || !kind) return null
  const inspection = snapshot.inspection === null ? null : sanitizeInspection(snapshot.inspection)
  if (snapshot.inspection !== null && !inspection) return null
  const selector = snapshot.selector === null ? null : asObject(snapshot.selector)
  const safeSelector =
    selector === null
      ? null
      : {
          reason: safeEnum(selector.reason, ["route", "event", "most-recent"] as const),
          sessionHash: safeHash(selector.sessionHash),
        }
  if (selector !== null && (!safeSelector?.reason || !safeSelector.sessionHash)) return null
  const anchor = snapshot.anchor === null ? null : sanitizeAnchor(snapshot.anchor)
  if (snapshot.anchor !== null && !anchor) return null
  const ownership = asObject(snapshot.ownership)
  const safeOwnerRow = ownership && ownership.ownerRow !== null ? sanitizeOwnerRow(ownership.ownerRow) : null
  const safeOwnership =
    ownership && !(ownership.ownerRow !== null && safeOwnerRow === null)
      ? {
          isOwner: safeBoolean(ownership.isOwner),
          fence: safeInt(ownership.fence, 0),
          revoked: safeBoolean(ownership.revoked),
          ownerRow: safeOwnerRow,
        }
      : null
  if (ownership && (safeOwnership?.isOwner === null || safeOwnership?.fence === null || safeOwnership?.revoked === null)) return null
  const acquisition = snapshot.acquisition === null ? null : sanitizeAcquisition(snapshot.acquisition)
  if (snapshot.acquisition !== null && !acquisition) return null
  const locality = sanitizeLocality(snapshot.locality)
  const probe = sanitizeProbe(snapshot.probe)
  const captureEnabled = safeBoolean(snapshot.captureEnabled)
  const live = safeBoolean(snapshot.live)
  if (!locality || !probe || captureEnabled === null || live === null) return null
  return {
    v: 1,
    kind,
    at,
    runId,
    instanceId,
    pid,
    generation,
    selector: safeSelector,
    inspection,
    anchor,
    ownership: safeOwnership,
    acquisition,
    locality,
    probe,
    captureEnabled,
    live,
  }
}

const SELECTORS = ["route", "event"] as const
const ATTEMPTS = ["ready", "socket-close", "socket-error", "command-publish", "disconnect-command", "disconnect", "revoked", "cleanup", "cleanup-close", "coordination-start"] as const
const PHASES = ["lifecycle", "pre-enqueue", "enqueued", "post-enqueue", "acknowledged"] as const
const CODES = [
  "live-disabled",
  "identity-unknown",
  "no-coordinator",
  "no-observed-session",
  "session-unreadable",
  "executed-model-unknown",
  "timestamp-unavailable",
  "payload-invalid",
  "anchor-conflict",
  "anchor-persist-failed",
  "not-owner",
  "connect-failed",
  "enqueue-busy",
  "enqueue-not-owner",
  "enqueue-revoked",
  "enqueue-no-store",
  "enqueue-error",
  "enqueue-rejected",
  "rpc-rejected",
  "rpc-timeout",
  "rpc-closed",
  "clear-refused",
  "no-socket",
  "socket-closed",
  "socket-error",
  "publisher-revoked",
  "cleanup",
] as const

export function sanitizeTimestampProvenance(value: unknown): Record<string, unknown> | null {
  const provenance = asObject(value)
  if (!provenance) return null
  if (provenance.refusal !== undefined) {
    return provenance.refusal === "timestamp-unavailable" ? { refusal: "timestamp-unavailable" } : null
  }
  const seconds = safeInt(provenance.seconds, 1_000_000_000)
  const originalValue = safeInt(provenance.originalValue, 1)
  const committed = safeBoolean(provenance.committed)
  const anchorCommitted = safeBoolean(provenance.anchorCommitted)
  if (seconds === null || originalValue === null || committed === null || anchorCommitted === null) return null
  if (provenance.sourceField !== "session.message.list[].type=user.time.created") return null
  if (provenance.originalUnits !== "milliseconds since Unix epoch") return null
  if (provenance.conversion !== "floor(ms/1000)") return null
  if (seconds !== Math.floor(originalValue / 1000)) return null
  return {
    seconds,
    sourceField: provenance.sourceField,
    originalValue,
    originalUnits: provenance.originalUnits,
    conversion: provenance.conversion,
    committed,
    anchorCommitted,
  }
}

export function sanitizeModelProvenance(value: unknown): Record<string, unknown> | null {
  const model = asObject(value)
  if (!model) return null
  return {
    selected: model.selected === null ? null : sanitizeModel(model.selected),
    executed: model.executed === null ? null : sanitizeModel(model.executed),
    agent: model.agent === null ? null : safeIdentifier(model.agent),
    sessionCost: model.sessionCost === null ? null : safeNumber(model.sessionCost),
    reportedCost: model.reportedCost === null ? null : safeNumber(model.reportedCost),
    tokens: model.tokens === null ? null : sanitizeTokens(model.tokens),
  }
}

export function sanitizeActivity(value: unknown): Record<string, unknown> | null {
  const validation = validateActivity(value)
  if (!validation.ok) return null
  const activity = value as Record<string, unknown>
  const assets = activity.assets as Record<string, unknown>
  const timestamps = activity.timestamps as Record<string, unknown>
  const match = typeof assets.small_text === "string" ? /^Model: ([^/]+)\/([^/]+)$/.exec(assets.small_text) : null
  if (!match || !sanitizeModel({ providerID: match[1], id: match[2] })) return null
  return {
    details: "M0 transmission test",
    state: "M0 · events observed",
    assets: {
      large_image: "state-working",
      large_text: "OpenCode — Working",
      small_image: "badge-model",
      small_text: assets.small_text as string,
    },
    timestamps: { start: timestamps.start as number },
  }
}

export function sanitizePublication(value: unknown): Record<string, unknown> | null {
  const record = asObject(value)
  if (!record) return null
  const at = safeIso(record.at)
  const instanceId = safeUuid(record.instanceId)
  const pid = safeInt(record.pid, 0)
  const attempt = safeEnum(record.attempt, ATTEMPTS)
  const phase = safeEnum(record.phase, PHASES)
  const live = safeBoolean(record.live)
  if (!at || !instanceId || pid === null || !attempt || !phase || live === null) return null
  const result: Record<string, unknown> = { v: 1, at, instanceId, pid, attempt, phase, live }
  if (record.sessionHash !== undefined) {
    const hash = safeHash(record.sessionHash)
    if (!hash) return null
    result.sessionHash = hash
  }
  if (record.selector !== undefined) {
    const selector = safeEnum(record.selector, SELECTORS)
    if (!selector) return null
    result.selector = selector
  }
  if (record.fence !== undefined) {
    const fence = safeInt(record.fence, 0)
    if (fence === null) return null
    result.fence = fence
  }
  if (record.ready !== undefined) {
    const ready = safeBoolean(record.ready)
    if (ready === null) return null
    result.ready = ready
  }
  if (record.nonce !== undefined) {
    const nonce = safeUuid(record.nonce)
    if (!nonce) return null
    result.nonce = nonce
  }
  if (record.cmd !== undefined) {
    if (record.cmd !== "SET_ACTIVITY") return null
    result.cmd = "SET_ACTIVITY"
  }
  if (record.evt !== undefined) {
    if (record.evt !== null && record.evt !== "ERROR") return null
    result.evt = record.evt
  }
  if (record.activity !== undefined) {
    const activity = sanitizeActivity(record.activity)
    if (!activity) return null
    result.activity = activity
  }
  if (record.rpcOk !== undefined) {
    const ok = safeBoolean(record.rpcOk)
    if (ok === null) return null
    result.rpcOk = ok
  }
  if (record.durationMs !== undefined) {
    const duration = safeInt(record.durationMs, 0)
    if (duration === null) return null
    result.durationMs = duration
  }
  if (record.code !== undefined) {
    const code = safeEnum(record.code, CODES)
    if (!code) return null
    result.code = code
  }
  if (record.timestampProvenance !== undefined) {
    const provenance = sanitizeTimestampProvenance(record.timestampProvenance)
    if (!provenance) return null
    result.timestampProvenance = provenance
  }
  if (record.modelProvenance !== undefined) {
    const model = sanitizeModelProvenance(record.modelProvenance)
    if (!model) return null
    result.modelProvenance = model
  }
  return result
}

const PUBLISHER_KINDS = ["acquire", "renew", "takeover", "contended", "release", "revoke", "critical", "error", "snapshot", "cleanup"] as const
const PUBLISHER_ERRORS = ["store-unavailable", "closed", "contended", "acquire-failed", "renew-failed", "release-failed", "critical-failed"] as const
const PUBLISHER_REASONS = ["fence-changed", "owner-row-gone", "release-fence-mismatch", "fence-mismatch", "busy", "cleanup"] as const

export function sanitizePublisherEvent(value: unknown): Record<string, unknown> | null {
  const event = asObject(value)
  if (!event) return null
  const kind = safeEnum(event.kind, PUBLISHER_KINDS)
  const atMs = safeInt(event.atMs, 0)
  const instanceId = safeUuid(event.instanceId)
  const pid = safeInt(event.pid, 0)
  const generation = safeUuid(event.generation)
  if (!kind || atMs === null || !instanceId || pid === null || !generation) return null
  const result: Record<string, unknown> = { v: 1, kind, atMs, instanceId, pid, generation }
  if (event.fence !== undefined) {
    const fence = safeInt(event.fence, 0)
    if (fence !== null) result.fence = fence
  }
  if (event.previousFence !== undefined) {
    const fence = safeInt(event.previousFence, 0)
    if (fence !== null) result.previousFence = fence
  }
  if (event.reason !== undefined) {
    const reason = safeEnum(event.reason, PUBLISHER_REASONS)
    if (reason) result.reason = reason
  }
  if (event.code !== undefined) {
    const code = safeEnum(event.code, PUBLISHER_ERRORS)
    if (code) result.code = code
  }
  if (event.snapshotKind !== undefined) {
    const kindValue = safeEnum(event.snapshotKind, ["startup-mid-task", "manual-snapshot"] as const)
    if (kindValue) result.snapshotKind = kindValue
  }
  return result
}
