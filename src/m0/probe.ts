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

export interface ProbeStage {
  ok: boolean
  detail?: string
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
    execPath: string
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

const sqliteModules = new Map<SqliteKind, unknown>()

async function importModule(specifier: string): Promise<{ ok: true; mod: unknown } | { ok: false; error: string }> {
  try {
    // Variable specifier: bundlers must leave this to the runtime.
    const mod: unknown = await import(specifier)
    return { ok: true, mod }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
      return { ok: row?.value === 1, selectOne: row?.value, detail: row?.value === 1 ? undefined : "SELECT 1 returned no row" }
    } finally {
      db.close()
    }
  } catch (error) {
    return { ok: false, detail: errorText(error) }
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
      execPath: process.execPath,
    },
    imports: {
      net: { ok: netImport.ok && netCreate, createConnection: netCreate, ...(netImport.ok ? {} : { detail: netImport.error }) },
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
    : { ok: false, detail: bunImport.error }
  const nodeStage: ProbeStage & { selectOne?: number } = nodeSqliteImport.ok
    ? probeSqliteModule("node:sqlite", nodeSqliteImport.mod)
    : { ok: false, detail: nodeSqliteImport.error }

  if (bunStage.ok && bunImport.ok) {
    sqliteModules.set("bun:sqlite", bunImport.mod)
    return { backend: bunBackend(bunImport.mod), bun: bunStage, node: nodeStage }
  }
  if (nodeStage.ok && nodeSqliteImport.ok) {
    sqliteModules.set("node:sqlite", nodeSqliteImport.mod)
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

export interface LocalityClassification {
  class: "local" | "remote" | "unknown"
  enrichment: "allowed" | "refused"
  reason: string
  evidence: {
    method: "server.info" | "none"
    serverHostname?: string
    localHostname: string
    urls?: string[]
    error?: string
  }
  observedAt: string
}

function isLoopbackHost(value: string): boolean {
  const host = value.replace(/^\[/, "").replace(/\]$/, "").split(":")[0]
  if (!host) return false
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0"
}

/**
 * M0 classifies the connected server. Only a proven local server may ever
 * enrich from a local session database; unknown and remote both refuse.
 */
export async function classifyLocality(context: Context): Promise<LocalityClassification> {
  const local = localHostname()
  try {
    const info = await context.client.server.info({})
    const urls = info.urls ?? []
    const loopbackURLs = urls.filter((url) => {
      try {
        const parsed = new URL(url)
        return isLoopbackHost(parsed.hostname)
      } catch {
        return false
      }
    })
    const hostMatch = info.hostname !== undefined && (info.hostname === local || info.hostname === "localhost")
    const sameHost = info.hostname === undefined || hostMatch
    const localURLs = urls.length === 0 || loopbackURLs.length === urls.length
    if (sameHost && localURLs) {
      return {
        class: "local",
        enrichment: "allowed",
        reason: "server.info hostname and every advertised URL resolve to this host",
        evidence: { method: "server.info", serverHostname: info.hostname, localHostname: local, urls },
        observedAt: new Date().toISOString(),
      }
    }
    return {
      class: "remote",
      enrichment: "refused",
      reason: "server.info hostname or URL is not this host",
      evidence: { method: "server.info", serverHostname: info.hostname, localHostname: local, urls },
      observedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      class: "unknown",
      enrichment: "refused",
      reason: "server identity could not be observed; local-DB enrichment refused",
      evidence: { method: "none", localHostname: local, error: errorText(error) },
      observedAt: new Date().toISOString(),
    }
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
  lastUserMessageAtMs: number | null
  lastUserMessageSource: string | null
  frozenTimestampSeconds: number | null
  frozenTimestampSource: string | null
  timestampOriginalUnits: string | null
  timestampRefusal: string | null
  errors: string[]
}

const frozenTimestamps = new Map<string, { seconds: number; source: string; originalMs: number }>()

export function resetFrozenTimestamps(): void {
  frozenTimestamps.clear()
}

/**
 * Freeze the current user-message creation time for the session. If no user
 * message exists, publication is refused; startup/publish time is never used.
 */
export function timestampForSession(
  sessionID: string,
  lastUserMessageAtMs: number | null,
  source: string | null,
): { seconds: number; source: string; originalMs: number } | { error: string } {
  const frozen = frozenTimestamps.get(sessionID)
  if (frozen) return frozen
  if (lastUserMessageAtMs === null || source === null) {
    return { error: "no user message creation timestamp is exposed for this session" }
  }
  if (!Number.isFinite(lastUserMessageAtMs) || lastUserMessageAtMs <= 0) {
    return { error: `session timestamp is not a finite positive number: ${String(lastUserMessageAtMs)}` }
  }
  const seconds = Math.floor(lastUserMessageAtMs / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000) {
    return { error: `session timestamp does not convert to a plausible integer Unix second: ${lastUserMessageAtMs}` }
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (seconds > nowSeconds + 300) {
    return { error: `session timestamp is more than 5 minutes in the future: ${seconds} > ${nowSeconds}` }
  }
  const frozenValue = { seconds, source, originalMs: lastUserMessageAtMs }
  frozenTimestamps.set(sessionID, frozenValue)
  return frozenValue
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
    lastUserMessageAtMs: null,
    lastUserMessageSource: null,
    frozenTimestampSeconds: null,
    frozenTimestampSource: null,
    timestampOriginalUnits: null,
    timestampRefusal: null,
    errors,
  }

  let info = context.data.session.get(sessionID)
  if (!info) {
    try {
      await context.data.session.sync(sessionID)
      info = context.data.session.get(sessionID)
    } catch (error) {
      errors.push(`session.sync: ${errorText(error)}`)
    }
  }
  if (!info) {
    errors.push("session.get returned no session")
    return inspection
  }

  inspection.found = true
  try {
    inspection.status = context.data.session.status(sessionID)
  } catch (error) {
    errors.push(`session.status: ${errorText(error)}`)
  }
  try {
    inspection.sessionCost = context.data.session.cost(sessionID)
  } catch (error) {
    errors.push(`session.cost: ${errorText(error)}`)
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
  } catch (error) {
    errors.push(`ui.model.current: ${errorText(error)}`)
  }
  if (!inspection.selectedModel && info.model) {
    inspection.selectedModel = { id: info.model.id, providerID: info.model.providerID, ...(info.model.variant ? { variant: info.model.variant } : {}) }
  }

  let messages = context.data.session.message.list(sessionID)
  if (messages.length === 0) {
    try {
      await context.data.session.message.sync(sessionID)
      messages = context.data.session.message.list(sessionID)
    } catch (error) {
      errors.push(`session.message.sync: ${errorText(error)}`)
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
      inspection.lastUserMessageAtMs = message.time.created
      inspection.lastUserMessageSource = "session.message.list[].type=user.time.created"
    }
    break
  }

  const timestamp = timestampForSession(sessionID, inspection.lastUserMessageAtMs, inspection.lastUserMessageSource)
  if ("error" in timestamp) {
    inspection.timestampRefusal = timestamp.error
  } else {
    inspection.frozenTimestampSeconds = timestamp.seconds
    inspection.frozenTimestampSource = timestamp.source
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
