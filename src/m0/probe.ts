/**
 * M0 host/runtime capability probes and read-only session inspection.
 *
 * Every probe runs inside the TUI `setup` callback. The same module offers the
 * synchronous SQLite opener used by the coordination store, so the probe and
 * the real code path exercise the same import.
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { arch, hostname, platform } from "node:os"

import type { Context } from "@opencode/plugin/tui/plugin"

export type SqliteKind = "bun:sqlite" | "node:sqlite"

export interface SqliteHandle {
  exec(sql: string): void
  run(sql: string, ...params: unknown[]): void
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  close(): void
}

export interface SqliteBackend {
  kind: SqliteKind
  open(path: string): SqliteHandle
}

export type ProbeCode = "import-failed" | "probe-failed" | "select-mismatch"

export interface ProbeStage {
  ok: boolean
  code?: ProbeCode
}

export interface RuntimeProbe {
  observedAt: string
  host: {
    version: string
    channel: string
    kind: "bun" | "node" | "unknown"
    bun?: string
    node?: string
    platform: string
    arch: string
    pid: number
  }
  imports: {
    net: ProbeStage & { createConnection: boolean }
    "bun:sqlite": ProbeStage
    "node:sqlite": ProbeStage
  }
  sqlite: {
    usable: boolean
    kind?: SqliteKind
    selectOne?: number
  }
}

async function importModule(specifier: string): Promise<{ ok: true; mod: unknown } | { ok: false; code: ProbeCode }> {
  try {
    // Variable specifier: bundlers must leave this to the runtime.
    const mod: unknown = await import(specifier)
    return { ok: true, mod }
  } catch {
    return { ok: false, code: "import-failed" }
  }
}

function bunBackend(mod: any): SqliteBackend {
  return {
    kind: "bun:sqlite",
    open(path) {
      const db = new mod.Database(path, { create: true, strict: true })
      db.exec("PRAGMA busy_timeout = 50")
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...params) => {
          db.query(sql).run(...params)
        },
        get: (sql, ...params) => db.query(sql).get(...params) as never,
        all: (sql, ...params) => db.query(sql).all(...params) as never,
        close: () => db.close(),
      }
    },
  }
}

function nodeBackend(mod: any): SqliteBackend {
  return {
    kind: "node:sqlite",
    open(path) {
      const db = new mod.DatabaseSync(path)
      db.exec("PRAGMA busy_timeout = 50")
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...params) => {
          db.prepare(sql).run(...params)
        },
        get: (sql, ...params) => db.prepare(sql).get(...params) as never,
        all: (sql, ...params) => db.prepare(sql).all(...params) as never,
        close: () => db.close(),
      }
    },
  }
}

function probeSqliteModule(kind: SqliteKind, mod: any): ProbeStage & { selectOne?: number } {
  try {
    const backend = kind === "bun:sqlite" ? bunBackend(mod) : nodeBackend(mod)
    const db = backend.open(":memory:")
    try {
      db.exec("CREATE TABLE probe (value INTEGER NOT NULL)")
      db.run("INSERT INTO probe (value) VALUES (?)", 1)
      const row = db.get<{ value: number }>("SELECT value FROM probe LIMIT 1")
      return { ok: row?.value === 1, selectOne: row?.value, ...(row?.value === 1 ? {} : { code: "select-mismatch" as const }) }
    } finally {
      db.close()
    }
  } catch {
    return { ok: false, code: "probe-failed" }
  }
}

export async function probeRuntime(context: Context): Promise<{ report: RuntimeProbe; backend: SqliteBackend | null }> {
  const netImport = await importModule("node:net")
  const netCreate =
    netImport.ok && typeof (netImport.mod as { createConnection?: unknown }).createConnection === "function"

  const { backend, bun: bunStage, node: nodeStage } = await loadSqliteBackend()

  const versions = process.versions as Record<string, string | undefined>
  const kind: RuntimeProbe["host"]["kind"] = versions.bun ? "bun" : versions.node ? "node" : "unknown"

  const report: RuntimeProbe = {
    observedAt: new Date().toISOString(),
    host: {
      version: context.app?.version ?? "unknown",
      channel: context.app?.channel ?? "unknown",
      kind,
      ...(versions.bun ? { bun: versions.bun } : {}),
      ...(versions.node ? { node: versions.node } : {}),
      platform: platform(),
      arch: arch(),
      pid: process.pid,
    },
    imports: {
      net: { ok: netImport.ok && netCreate, createConnection: netCreate, ...(netImport.ok ? {} : { code: netImport.code }) },
      "bun:sqlite": bunStage,
      "node:sqlite": nodeStage,
    },
    sqlite: {
      usable: backend !== null,
      ...(backend ? { kind: backend.kind } : {}),
      ...(bunStage.selectOne !== undefined ? { selectOne: bunStage.selectOne } : nodeStage.selectOne !== undefined ? { selectOne: nodeStage.selectOne } : {}),
    },
  }

  return { report, backend }
}

export async function loadSqliteBackend(): Promise<{
  backend: SqliteBackend | null
  bun: ProbeStage & { selectOne?: number }
  node: ProbeStage & { selectOne?: number }
}> {
  const bunImport = await importModule("bun:sqlite")
  const nodeSqliteImport = await importModule("node:sqlite")

  const bunStage: ProbeStage & { selectOne?: number } = bunImport.ok
    ? probeSqliteModule("bun:sqlite", bunImport.mod)
    : { ok: false, code: bunImport.code }
  const nodeStage: ProbeStage & { selectOne?: number } = nodeSqliteImport.ok
    ? probeSqliteModule("node:sqlite", nodeSqliteImport.mod)
    : { ok: false, code: nodeSqliteImport.code }

  if (bunStage.ok && bunImport.ok) {
    return { backend: bunBackend(bunImport.mod), bun: bunStage, node: nodeStage }
  }
  if (nodeStage.ok && nodeSqliteImport.ok) {
    return { backend: nodeBackend(nodeSqliteImport.mod), bun: bunStage, node: nodeStage }
  }
  return { backend: null, bun: bunStage, node: nodeStage }
}

/**
 * A run-scoped, process-independent salt so two terminal instances hash the
 * same session to the same pseudonym without putting the salt in evidence.
 * It lives in the private runtime directory (0700), never in the evidence dir.
 */
export function loadPseudonymSalt(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const path = join(runtimeDir, "pseudonym.salt")
  try {
    const existing = readFileSync(path, "utf8").trim()
    if (existing.length > 0) return existing
  } catch {
    // First run in this runtime directory.
  }
  try {
    writeFileSync(path, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" })
  } catch {
    // A racing instance created it first.
  }
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return randomUUID()
  }
}

export function pseudonym(salt: string, value: string): string {
  return createHash("sha256").update(salt).update("\u0000").update(value).digest("hex").slice(0, 16)
}

export function localHostname(): string {
  return hostname()
}

export type LocalityReason =
  | "host-and-urls-match"
  | "host-mismatch"
  | "url-not-loopback"
  | "identity-incomplete"
  | "server-info-unavailable"

export interface LocalityClassification {
  class: "local" | "remote" | "unknown"
  enrichment: "allowed" | "refused"
  reason: LocalityReason
  /** Hash of the observed server identity; never the raw host or URLs. */
  serverFingerprint: string | null
  evidence: {
    method: "server.info" | "none"
    hostnamePresent: boolean
    hostnameMatches: boolean | null
    urlCount: number
    allUrlsLoopback: boolean | null
  }
  observedAt: string
}

function isLoopbackHost(value: string): boolean {
  const host = value.replace(/^\[/, "").replace(/\]$/, "").split(":")[0]
  if (!host) return false
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function fingerprintIdentity(serverHostname: string, urls: string[]): string {
  return createHash("sha256").update(serverHostname).update("\u0000").update([...urls].sort().join("\u0000")).digest("hex").slice(0, 16)
}

/**
 * Fail closed: only a complete identity that names this host and advertises
 * exclusively loopback URLs is `local`. Missing, empty or malformed identity is
 * `unknown`; a differing host or non-loopback URL is `remote`. Both refuse
 * local-DB enrichment. Raw hostnames, URLs and exception text are never kept.
 */
export async function classifyLocality(context: Context): Promise<LocalityClassification> {
  const local = localHostname()
  const observedAt = new Date().toISOString()
  const unknown = (reason: LocalityReason, hostnamePresent: boolean, hostnameMatches: boolean | null, urlCount: number, allUrlsLoopback: boolean | null): LocalityClassification => ({
    class: "unknown",
    enrichment: "refused",
    reason,
    serverFingerprint: null,
    evidence: { method: reason === "server-info-unavailable" ? "none" : "server.info", hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback },
    observedAt,
  })

  let info: { hostname?: unknown; urls?: unknown }
  try {
    info = (await context.client.server.info({})) as { hostname?: unknown; urls?: unknown }
  } catch {
    return unknown("server-info-unavailable", false, null, 0, null)
  }

  const hostname = typeof info?.hostname === "string" && info.hostname.trim().length > 0 ? info.hostname : null
  const urls = Array.isArray(info?.urls) ? info.urls.filter((url): url is string => typeof url === "string" && url.length > 0) : []
  const hostnamePresent = hostname !== null
  const hostnameMatches = hostname === null ? null : hostname === local || hostname === "localhost"
  const parsed = urls.map((url) => {
    try {
      return new URL(url)
    } catch {
      return null
    }
  })
  const validURLs = parsed.every((url) => url !== null)
  const allUrlsLoopback = urls.length > 0 && validURLs ? parsed.every((url) => url !== null && isLoopbackHost(url.hostname)) : null

  if (!hostnamePresent || urls.length === 0 || !validURLs) {
    return unknown("identity-incomplete", hostnamePresent, hostnameMatches, urls.length, allUrlsLoopback)
  }
  if (hostnameMatches !== true || allUrlsLoopback !== true) {
    return {
      class: "remote",
      enrichment: "refused",
      reason: hostnameMatches !== true ? "host-mismatch" : "url-not-loopback",
      serverFingerprint: fingerprintIdentity(hostname, urls),
      evidence: { method: "server.info", hostnamePresent, hostnameMatches, urlCount: urls.length, allUrlsLoopback },
      observedAt,
    }
  }
  return {
    class: "local",
    enrichment: "allowed",
    reason: "host-and-urls-match",
    serverFingerprint: fingerprintIdentity(hostname, urls),
    evidence: { method: "server.info", hostnamePresent, hostnameMatches, urlCount: urls.length, allUrlsLoopback },
    observedAt,
  }
}

export interface ModelRefLike {
  id: string
  providerID: string
  variant?: string
}

export interface SessionInspection {
  observedAt: string
  sessionIDHash: string | null
  found: boolean
  status: "idle" | "running" | null
  sessionCost: number | null
  reportedCost: number | null
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null
  selectedModel: ModelRefLike | null
  executedModel: ModelRefLike | null
  agent: string | null
  messageCount: number
  latestUserMessageAtMs: number | null
  latestUserMessageSource: string | null
  candidateTimestampSeconds: number | null
  candidateTimestampError: TimestampErrorCode | null
  timestampOriginalUnits: string | null
  errorCodes: string[]
}

export type TimestampErrorCode = "timestamp-missing" | "timestamp-invalid" | "timestamp-implausible" | "timestamp-future"

/**
 * Pure conversion. Nothing is committed here; the publisher commits the anchor
 * only after a Discord acknowledgment.
 */
export function toUnixSeconds(createdMs: number | null): { seconds: number } | { code: TimestampErrorCode } {
  if (createdMs === null) return { code: "timestamp-missing" }
  if (!Number.isFinite(createdMs) || createdMs <= 0) return { code: "timestamp-invalid" }
  const seconds = Math.floor(createdMs / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000) return { code: "timestamp-implausible" }
  if (seconds > Math.floor(Date.now() / 1000) + 300) return { code: "timestamp-future" }
  return { seconds }
}

export interface TimestampAnchor {
  seconds: number
  sourceCreatedMs: number
}

export function resolveSessionTimestamp(
  anchor: TimestampAnchor | null,
  latestUserMessageAtMs: number | null,
): { seconds: number; sourceCreatedMs: number; committed: boolean } | { code: TimestampErrorCode } {
  if (anchor) return { seconds: anchor.seconds, sourceCreatedMs: anchor.sourceCreatedMs, committed: true }
  const converted = toUnixSeconds(latestUserMessageAtMs)
  if ("code" in converted) return converted
  return { seconds: converted.seconds, sourceCreatedMs: latestUserMessageAtMs as number, committed: false }
}

export async function inspectSession(context: Context, sessionID: string, salt: string): Promise<SessionInspection> {
  const errors: string[] = []
  const inspection: SessionInspection = {
    observedAt: new Date().toISOString(),
    sessionIDHash: pseudonym(salt, sessionID),
    found: false,
    status: null,
    sessionCost: null,
    reportedCost: null,
    tokens: null,
    selectedModel: null,
    executedModel: null,
    agent: null,
    messageCount: 0,
    latestUserMessageAtMs: null,
    latestUserMessageSource: null,
    candidateTimestampSeconds: null,
    candidateTimestampError: null,
    timestampOriginalUnits: null,
    errorCodes: errors,
  }

  let info = context.data.session.get(sessionID)
  if (!info) {
    try {
      await context.data.session.sync(sessionID)
      info = context.data.session.get(sessionID)
    } catch {
      errors.push("session-sync-failed")
    }
  }
  if (!info) {
    errors.push("session.get returned no session")
    return inspection
  }

  inspection.found = true
  try {
    inspection.status = context.data.session.status(sessionID)
  } catch {
    errors.push("session-status-failed")
  }
  try {
    inspection.sessionCost = context.data.session.cost(sessionID)
  } catch {
    errors.push("session-cost-failed")
  }
  inspection.reportedCost = info.cost ?? null
  if (info.tokens) {
    inspection.tokens = {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cacheRead: info.tokens.cache.read,
      cacheWrite: info.tokens.cache.write,
    }
  }
  inspection.agent = info.agent ?? null

  try {
    // The prompt's selection can drift from the model that actually ran.
    const current = context.ui.model.current()
    if (current) inspection.selectedModel = { id: current.modelID, providerID: current.providerID, ...(current.variant ? { variant: current.variant } : {}) }
  } catch {
    errors.push("model-selection-unavailable")
  }
  if (!inspection.selectedModel && info.model) {
    inspection.selectedModel = { id: info.model.id, providerID: info.model.providerID, ...(info.model.variant ? { variant: info.model.variant } : {}) }
  }

  let messages = context.data.session.message.list(sessionID)
  if (messages.length === 0) {
    try {
      await context.data.session.message.sync(sessionID)
      messages = context.data.session.message.list(sessionID)
    } catch {
      errors.push("message-sync-failed")
    }
  }
  inspection.messageCount = messages.length

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.type === "assistant") {
      if (!inspection.executedModel) {
        inspection.executedModel = {
          id: message.model.id,
          providerID: message.model.providerID,
          ...(message.model.variant ? { variant: message.model.variant } : {}),
        }
      }
      if (!inspection.agent) inspection.agent = message.agent
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== "user") continue
    if (typeof message.time?.created === "number") {
      inspection.latestUserMessageAtMs = message.time.created
      inspection.latestUserMessageSource = "session.message.list[].type=user.time.created"
    }
    break
  }

  const timestamp = toUnixSeconds(inspection.latestUserMessageAtMs)
  if ("code" in timestamp) {
    inspection.candidateTimestampError = timestamp.code
  } else {
    inspection.candidateTimestampSeconds = timestamp.seconds
    inspection.timestampOriginalUnits = "milliseconds since Unix epoch (converted with floor(ms/1000))"
  }

  return inspection
}

export interface ObservedSession {
  sessionID: string
  reason: "route" | "event" | "most-recent"
  updatedAt: number
}

/**
 * Pick the session this TUI instance is looking at. The router is
 * authoritative; event observation fills the gap while the router is on a
 * non-session route; most-recent is a last resort and is recorded as such.
 */
export function currentSession(context: Context, lastEventSession: string | null): ObservedSession | null {
  try {
    const route = context.ui.router.current()
    if (route.type === "session") return { sessionID: route.sessionID, reason: "route", updatedAt: Date.now() }
  } catch {
    // Router is not usable in every host context; fall through.
  }
  const sessions = context.data.session.list()
  const located = sessions.filter((session) => {
    if (!session.time.archived) return true
    return false
  })
  if (lastEventSession && located.some((session) => session.id === lastEventSession)) {
    return { sessionID: lastEventSession, reason: "event", updatedAt: Date.now() }
  }
  const mostRecent = located.sort((a, b) => b.time.updated - a.time.updated)[0]
  if (mostRecent) return { sessionID: mostRecent.id, reason: "most-recent", updatedAt: mostRecent.time.updated }
  return null
}
