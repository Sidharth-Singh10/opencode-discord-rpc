/**
 * Cross-process publisher ownership for M0.
 *
 * One SQLite row is the lease. Fence numbers live in `meta` and only ever
 * increase. Every Discord enqueue runs inside `criticalEnqueue`, which checks
 * owner + fence in the same IMMEDIATE transaction that performs the
 * synchronous socket write. No await, handshake or response wait is allowed
 * in that section.
 *
 * The store opens lazily and the retry timer is always armed, so a startup
 * write lock is a recoverable contention case rather than a terminal error.
 */
import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs"
import { join } from "node:path"

import type { SqliteBackend, SqliteHandle } from "./probe.js"

export interface OwnerIdentity {
  instanceId: string
  pid: number
  generation: string
}

export interface OwnerRow {
  instanceId: string
  pid: number
  generation: string
  fence: number
  acquiredMs: number
  heartbeatMs: number
}

export type PublisherErrorCode =
  | "store-unavailable"
  | "closed"
  | "contended"
  | "acquire-failed"
  | "renew-failed"
  | "release-failed"
  | "critical-failed"

export type Acquisition =
  | { status: "acquired"; fence: number }
  | { status: "renewed"; fence: number }
  | { status: "takeover"; fence: number; previous: OwnerRow }
  | { status: "contended"; fence: number; owner: OwnerRow }
  | { status: "revoked"; reason: RevokeReason }
  | { status: "error"; code: PublisherErrorCode }

export type RevokeReason = "fence-changed" | "owner-row-gone" | "release-fence-mismatch" | "fence-mismatch"

export type CriticalResult<T> =
  | { ok: true; value: T; fence: number }
  | { ok: false; reason: "not-owner" | "revoked" | "busy" | "no-store" | "error" | "anchor-conflict" | "anchor-pending" }

export interface PublisherEvent {
  kind: "acquire" | "renew" | "takeover" | "contended" | "release" | "revoke" | "critical" | "error"
  atMs: number
  instanceId: string
  pid: number
  generation: string
  fence?: number
  previousFence?: number
  reason?: RevokeReason | "busy"
  code?: PublisherErrorCode
}

export interface PublisherOptions {
  runtimeDir: string
  backend: SqliteBackend
  heartbeatMs?: number
  staleMs?: number
  tickMs?: number
  now?: () => number
  onEvent?: (event: PublisherEvent) => void
  onRevoked?: (reason: RevokeReason) => void
  /** Caller-supplied identity so evidence file names and lease rows agree. */
  identity?: OwnerIdentity
}

export interface Anchor {
  seconds: number
  sourceCreatedMs: number
  committedMs: number
}

export interface PendingAnchor {
  seconds: number
  sourceCreatedMs: number
  intentMs: number
}

export interface AnchorState {
  committed: Anchor | null
  pending: PendingAnchor | null
  acknowledgedUnpersisted: { seconds: number; sourceCreatedMs: number } | null
}

export interface CandidateInput {
  sessionKey: string
  /** 1 when the session is running, 0 when idle. */
  priority: number
  updatedMs: number
  /** Exact Discord activity payload, already privacy-reviewed. */
  payload: string
  seconds: number
  sourceCreatedMs: number
}

export interface Candidate extends CandidateInput {
  instanceId: string
  pid: number
  heartbeatMs: number
}

export type AnchorCommitResult =
  | { ok: true; stored: Anchor }
  | { ok: false; code: "anchor-conflict" | "anchor-persist-failed" }

const OWNER_COLUMNS = "instance_id, pid, generation, fence, acquired_ms, heartbeat_ms"
const SESSION_KEY = /^[0-9a-f]{64}$/
const CANDIDATE_PAYLOAD_MAX = 4096

function validCandidate(input: CandidateInput): boolean {
  return (
    SESSION_KEY.test(input.sessionKey) &&
    (input.priority === 0 || input.priority === 1) &&
    Number.isSafeInteger(input.updatedMs) &&
    input.updatedMs > 0 &&
    typeof input.payload === "string" &&
    input.payload.length > 2 &&
    input.payload.length <= CANDIDATE_PAYLOAD_MAX &&
    Number.isSafeInteger(input.seconds) &&
    input.seconds >= 1_000_000_000 &&
    Number.isSafeInteger(input.sourceCreatedMs) &&
    input.seconds === Math.floor(input.sourceCreatedMs / 1000)
  )
}

export class Publisher {
  readonly identity: OwnerIdentity
  readonly dbPath: string
  private readonly options: Required<Omit<PublisherOptions, "onEvent" | "onRevoked" | "identity">> & {
    onEvent?: (event: PublisherEvent) => void
    onRevoked?: (reason: RevokeReason) => void
  }
  private db: SqliteHandle | null = null
  private storeReady = false
  private timer: ReturnType<typeof setInterval> | null = null
  private owned = false
  private fence = 0
  private revoked = false
  private closed = false
  private paused = false
  private readonly unpersisted = new Map<string, { seconds: number; sourceCreatedMs: number }>()

  constructor(options: PublisherOptions) {
    this.options = {
      runtimeDir: options.runtimeDir,
      backend: options.backend,
      heartbeatMs: options.heartbeatMs ?? 2000,
      staleMs: options.staleMs ?? 10_000,
      tickMs: options.tickMs ?? 2000,
      now: options.now ?? Date.now,
      onEvent: options.onEvent,
      onRevoked: options.onRevoked,
    }
    const identity = options.identity ?? { instanceId: randomUUID(), pid: process.pid, generation: randomUUID() }
    this.identity = { instanceId: identity.instanceId, pid: identity.pid, generation: identity.generation }
    this.dbPath = join(options.runtimeDir, "publisher.sqlite")
  }

  get isOwner(): boolean {
    return this.owned && !this.revoked
  }

  get currentFence(): number {
    return this.fence
  }

  get isRevoked(): boolean {
    return this.revoked
  }

  get isPaused(): boolean {
    return this.paused
  }

  start(): Acquisition {
    if (this.closed) return { status: "error", code: "closed" }
    // Arm first: a startup lock must not kill recovery.
    this.armTimer()
    if (!this.openStore()) return { status: "error", code: "store-unavailable" }
    return this.tryAcquire()
  }

  /** The only retry path; the timer calls it, no auxiliary process does. */
  tick(): Acquisition | null {
    if (this.closed || this.revoked || this.paused) return null
    if (!this.openStore()) return { status: "error", code: "store-unavailable" }
    this.retryPersistence()
    const result = this.owned ? this.renew() : this.tryAcquire()
    if (result.status === "revoked") this.revoke(result.reason)
    return result
  }

  /**
   * Fenced publication with durable pending intent. The intended anchor is
   * committed before the socket write, then rechecked inside the synchronous
   * owner/fence + enqueue transaction. Even a failed second COMMIT cannot
   * erase the durable reservation for an already-sent operation.
   */
  criticalPublish<T>(sessionKey: string, intended: { seconds: number; sourceCreatedMs: number }, enqueue: () => T): CriticalResult<T> {
    if (!SESSION_KEY.test(sessionKey)) return { ok: false, reason: "anchor-conflict" }
    if (!Number.isSafeInteger(intended.seconds) || intended.seconds < 1_000_000_000 ||
        !Number.isSafeInteger(intended.sourceCreatedMs) || intended.seconds !== Math.floor(intended.sourceCreatedMs / 1000)) {
      return { ok: false, reason: "anchor-conflict" }
    }
    if (!this.storeReady || !this.db) return { ok: false, reason: "no-store" }
    if (this.revoked || this.closed) return { ok: false, reason: "revoked" }
    const acknowledged = this.unpersisted.get(sessionKey)
    if (acknowledged && (acknowledged.seconds !== intended.seconds || acknowledged.sourceCreatedMs !== intended.sourceCreatedMs)) return { ok: false, reason: "anchor-conflict" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch {
      return { ok: false, reason: "busy" }
    }
    try {
      const owner = this.readOwner()
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK")
        this.emit({ kind: "critical", reason: "fence-mismatch", fence: owner?.fence })
        this.revoke("fence-mismatch")
        return { ok: false, reason: "not-owner" }
      }
      const committed = this.readAnchorRow(sessionKey)
      const pending = this.readPendingRow(sessionKey)
      if (committed && (committed.seconds !== intended.seconds || committed.sourceCreatedMs !== intended.sourceCreatedMs)) {
        this.db.exec("ROLLBACK")
        return { ok: false, reason: "anchor-conflict" }
      }
      if (pending && (pending.seconds !== intended.seconds || pending.sourceCreatedMs !== intended.sourceCreatedMs)) {
        this.db.exec("ROLLBACK")
        return { ok: false, reason: "anchor-pending" }
      }
      if (!committed && !pending) {
        this.db.run(
          "INSERT INTO anchor_pending (session_key, seconds, source_created_ms, intent_ms) VALUES (?, ?, ?, ?)",
          sessionKey,
          intended.seconds,
          intended.sourceCreatedMs,
          this.options.now(),
        )
      }
      this.db.exec("COMMIT")
    } catch {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Already rolled back.
      }
      this.emit({ kind: "error", code: "critical-failed" })
      return { ok: false, reason: "error" }
    }
    return this.criticalEnqueue(() => {
      const committed = this.readAnchorRow(sessionKey)
      const pending = this.readPendingRow(sessionKey)
      if ((!committed && !pending) || [committed, pending].some((row) =>
        row && (row.seconds !== intended.seconds || row.sourceCreatedMs !== intended.sourceCreatedMs))) {
        throw new Error("anchor conflict")
      }
      return enqueue()
    })
  }

  criticalEnqueue<T>(enqueue: () => T): CriticalResult<T> {
    if (!this.storeReady || !this.db) return { ok: false, reason: "no-store" }
    if (this.revoked || this.closed) return { ok: false, reason: "revoked" }
    let enqueued: { value: T } | null = null
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch {
      return { ok: false, reason: "busy" }
    }

    try {
      const owner = this.readOwner()
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK")
        this.emit({ kind: "critical", reason: "fence-mismatch", fence: owner?.fence })
        this.revoke("fence-mismatch")
        return { ok: false, reason: "not-owner" }
      }
      this.db.run(
        "UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1 AND instance_id = ? AND fence = ?",
        this.options.now(),
        this.identity.instanceId,
        this.fence,
      )
      // Synchronous only. This is the guarantee boundary: once this returns,
      // the frame is handed to the OS and cannot be recalled.
      const value = enqueue()
      enqueued = { value }
      this.db.exec("COMMIT")
      this.emit({ kind: "critical", fence: this.fence })
      return { ok: true, value, fence: this.fence }
    } catch {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // The transaction may already be gone.
      }
      this.emit({ kind: "error", code: "critical-failed" })
      // Bytes already handed to the OS cannot be reclassified as a refusal.
      // The independently committed intent survives rollback; return the
      // request so ACK/timeout/closure is still reconciled and evidenced.
      if (enqueued) {
        this.emit({ kind: "critical", fence: this.fence })
        return { ok: true, value: enqueued.value, fence: this.fence }
      }
      return { ok: false, reason: "error" }
    }
  }

  release(): boolean {
    if (!this.storeReady || !this.db || !this.owned || this.revoked) {
      this.disarmTimer()
      return false
    }
    try {
      this.db.exec("BEGIN IMMEDIATE")
      const owner = this.readOwner()
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK")
        this.revoke("release-fence-mismatch")
        return false
      }
      this.db.run("DELETE FROM owner WHERE singleton = 1 AND instance_id = ? AND fence = ?", this.identity.instanceId, this.fence)
      this.db.exec("COMMIT")
      this.emit({ kind: "release", fence: this.fence })
      this.owned = false
      // An explicit release is a deliberate pause: do not keep a fence that no
      // card uses. A later publish calls resume() and contends again.
      this.paused = true
      this.disarmTimer()
      return true
    } catch {
      this.emit({ kind: "error", code: "release-failed" })
      return false
    }
  }

  /** Re-enter arbitration after an explicit release, e.g. publish after disconnect. */
  resume(): Acquisition | null {
    if (this.closed || this.revoked) return null
    if (!this.openStore()) return { status: "error", code: "store-unavailable" }
    this.paused = false
    this.armTimer()
    return this.owned ? this.renew() : this.tryAcquire()
  }

  stop(): void {
    if (this.closed) return
    this.disarmTimer()
    if (this.owned && !this.revoked) this.release()
    this.closed = true
    this.storeReady = false
    try {
      this.db?.close()
    } catch {
      // Closing a coordination DB is best effort during shutdown.
    }
    this.db = null
  }

  ownerSnapshot(): OwnerRow | null {
    if (!this.storeReady || !this.db) return null
    try {
      return this.readOwner()
    } catch {
      return null
    }
  }

  /** Read the committed timestamp anchor for a server-qualified session. */
  readAnchor(sessionKey: string): Anchor | null {
    if (!SESSION_KEY.test(sessionKey) || !this.openStore() || !this.db) return null
    try {
      return this.readAnchorRow(sessionKey)
    } catch {
      return null
    }
  }

  readAnchorState(sessionKey: string): AnchorState {
    if (!SESSION_KEY.test(sessionKey) || !this.openStore() || !this.db) {
      return { committed: null, pending: null, acknowledgedUnpersisted: null }
    }
    try {
      return {
        committed: this.readAnchorRow(sessionKey),
        pending: this.readPendingRow(sessionKey),
        acknowledgedUnpersisted: this.unpersisted.get(sessionKey) ?? null,
      }
    } catch {
      return { committed: null, pending: null, acknowledgedUnpersisted: this.unpersisted.get(sessionKey) ?? null }
    }
  }

  /**
   * Advertise this instance's current card. Every TUI writes one row; only the
   * fence owner publishes the best fresh row, so the card follows activity in
   * another workspace without giving that workspace a second socket.
   */
  upsertCandidate(input: CandidateInput): boolean {
    if (!this.openStore() || !this.db) return false
    if (!validCandidate(input)) return false
    try {
      this.db.run(
        `INSERT INTO candidate (instance_id, pid, session_key, priority, updated_ms, heartbeat_ms, payload, seconds, source_created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           pid = excluded.pid,
           session_key = excluded.session_key,
           priority = excluded.priority,
           updated_ms = excluded.updated_ms,
           heartbeat_ms = excluded.heartbeat_ms,
           payload = excluded.payload,
           seconds = excluded.seconds,
           source_created_ms = excluded.source_created_ms`,
        this.identity.instanceId,
        this.identity.pid,
        input.sessionKey,
        input.priority,
        input.updatedMs,
        this.options.now(),
        input.payload,
        input.seconds,
        input.sourceCreatedMs,
      )
      return true
    } catch {
      return false
    }
  }

  removeCandidate(): boolean {
    if (!this.openStore() || !this.db) return false
    try {
      this.db.run("DELETE FROM candidate WHERE instance_id = ?", this.identity.instanceId)
      return true
    } catch {
      return false
    }
  }

  /** Fresh candidates only, best first. Stale rows are pruned. */
  readCandidates(staleMs = this.options.staleMs): Candidate[] {
    if (!this.openStore() || !this.db) return []
    const cutoff = this.options.now() - staleMs
    try {
      this.db.run("DELETE FROM candidate WHERE heartbeat_ms < ?", cutoff)
      const rows = this.db.all<{
        instance_id: string
        pid: number
        session_key: string
        priority: number
        updated_ms: number
        heartbeat_ms: number
        payload: string
        seconds: number
        source_created_ms: number
      }>(
        `SELECT instance_id, pid, session_key, priority, updated_ms, heartbeat_ms, payload, seconds, source_created_ms
         FROM candidate WHERE heartbeat_ms >= ?
         ORDER BY priority DESC, updated_ms DESC, heartbeat_ms DESC`,
        cutoff,
      )
      const candidates: Candidate[] = []
      for (const row of rows) {
        const candidate: Candidate = {
          instanceId: row.instance_id,
          pid: row.pid,
          sessionKey: row.session_key,
          priority: row.priority,
          updatedMs: row.updated_ms,
          heartbeatMs: row.heartbeat_ms,
          payload: row.payload,
          seconds: row.seconds,
          sourceCreatedMs: row.source_created_ms,
        }
        if (validCandidate(candidate)) candidates.push(candidate)
      }
      return candidates
    } catch {
      return []
    }
  }

  /**
   * Record an ACK first, then attempt durable reconciliation. A failed write
   * leaves the anchor in memory (and the durable pending intent) so no newer
   * anchor can be published; the ticker retries.
   */
  markAcknowledged(sessionKey: string, seconds: number, sourceCreatedMs: number): AnchorCommitResult {
    if (!SESSION_KEY.test(sessionKey)) return { ok: false, code: "anchor-persist-failed" }
    if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || !Number.isSafeInteger(sourceCreatedMs) || seconds !== Math.floor(sourceCreatedMs / 1000)) {
      return { ok: false, code: "anchor-persist-failed" }
    }
    const existing = this.unpersisted.get(sessionKey)
    if (existing && (existing.seconds !== seconds || existing.sourceCreatedMs !== sourceCreatedMs)) return { ok: false, code: "anchor-conflict" }
    this.unpersisted.set(sessionKey, { seconds, sourceCreatedMs })
    return this.persistAcknowledged(sessionKey)
  }

  private persistAcknowledged(sessionKey: string): AnchorCommitResult {
    const acknowledged = this.unpersisted.get(sessionKey)
    if (!acknowledged) return { ok: false, code: "anchor-persist-failed" }
    if (!this.openStore() || !this.db) return { ok: false, code: "anchor-persist-failed" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch {
      return { ok: false, code: "anchor-persist-failed" }
    }
    try {
      const committed = this.readAnchorRow(sessionKey)
      const pending = this.readPendingRow(sessionKey)
      if (pending && (pending.seconds !== acknowledged.seconds || pending.sourceCreatedMs !== acknowledged.sourceCreatedMs)) {
        this.db.exec("ROLLBACK")
        return { ok: false, code: "anchor-conflict" }
      }
      if (committed) {
        if (committed.seconds !== acknowledged.seconds || committed.sourceCreatedMs !== acknowledged.sourceCreatedMs) {
          this.db.exec("ROLLBACK")
          return { ok: false, code: "anchor-conflict" }
        }
        this.db.run("DELETE FROM anchor_pending WHERE session_key = ?", sessionKey)
        this.db.exec("COMMIT")
        this.unpersisted.delete(sessionKey)
        return { ok: true, stored: committed }
      }
      this.db.run(
        "INSERT INTO anchor (session_key, seconds, source_created_ms, committed_ms) VALUES (?, ?, ?, ?)",
        sessionKey,
        acknowledged.seconds,
        acknowledged.sourceCreatedMs,
        this.options.now(),
      )
      const stored = this.readAnchorRow(sessionKey)
      if (!stored || stored.seconds !== acknowledged.seconds || stored.sourceCreatedMs !== acknowledged.sourceCreatedMs) {
        this.db.exec("ROLLBACK")
        return { ok: false, code: "anchor-persist-failed" }
      }
      this.db.run("DELETE FROM anchor_pending WHERE session_key = ?", sessionKey)
      this.db.exec("COMMIT")
      this.unpersisted.delete(sessionKey)
      return { ok: true, stored }
    } catch {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Already rolled back.
      }
      return { ok: false, code: "anchor-persist-failed" }
    }
  }

  private retryPersistence(): void {
    for (const key of [...this.unpersisted.keys()]) this.persistAcknowledged(key)
  }

  private readAnchorRow(sessionKey: string): Anchor | null {
    if (!this.db) return null
    const row = this.db.get<{ seconds: number; source_created_ms: number; committed_ms: number }>(
      "SELECT seconds, source_created_ms, committed_ms FROM anchor WHERE session_key = ?",
      sessionKey,
    )
    if (!row || !Number.isSafeInteger(row.seconds) || !Number.isSafeInteger(row.source_created_ms)) return null
    return { seconds: row.seconds, sourceCreatedMs: row.source_created_ms, committedMs: row.committed_ms }
  }

  private readPendingRow(sessionKey: string): PendingAnchor | null {
    if (!this.db) return null
    const row = this.db.get<{ seconds: number; source_created_ms: number; intent_ms: number }>(
      "SELECT seconds, source_created_ms, intent_ms FROM anchor_pending WHERE session_key = ?",
      sessionKey,
    )
    if (!row || !Number.isSafeInteger(row.seconds) || !Number.isSafeInteger(row.source_created_ms)) return null
    return { seconds: row.seconds, sourceCreatedMs: row.source_created_ms, intentMs: row.intent_ms }
  }

  private openStore(): boolean {
    if (this.storeReady && this.db) return true
    if (this.closed) return false
    try {
      this.prepareRuntimeDir()
      this.db = this.options.backend.open(this.dbPath)
      this.db.exec("PRAGMA journal_mode = WAL")
      this.db.exec("PRAGMA synchronous = FULL")
      this.initSchema()
      this.storeReady = true
      return true
    } catch {
      try {
        this.db?.close()
      } catch {
        // Ignore a failed cleanup attempt.
      }
      this.db = null
      this.storeReady = false
      this.emit({ kind: "error", code: "store-unavailable" })
      return false
    }
  }

  private prepareRuntimeDir(): void {
    mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.options.runtimeDir)
    if (stat.isSymbolicLink()) throw new Error("unsafe runtime dir")
    if (!stat.isDirectory()) throw new Error("unsafe runtime dir")
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) throw new Error("unsafe runtime dir ownership")
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(this.options.runtimeDir, 0o700)
      const tightened = statSync(this.options.runtimeDir)
      if ((tightened.mode & 0o077) !== 0) throw new Error("unsafe runtime dir mode")
    }

    try {
      const dbStat = lstatSync(this.dbPath)
      if (dbStat.isSymbolicLink()) throw new Error("unsafe coordination file")
      if (!dbStat.isFile()) throw new Error("unsafe coordination file")
      if (uid !== undefined && dbStat.uid !== uid) throw new Error("unsafe coordination ownership")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
      const fd = openSync(this.dbPath, "wx", 0o600)
      closeSync(fd)
    }
  }

  private initSchema(): void {
    if (!this.db) throw new Error("no db")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        generation TEXT NOT NULL,
        fence INTEGER NOT NULL,
        acquired_ms INTEGER NOT NULL,
        heartbeat_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor (
        session_key TEXT PRIMARY KEY,
        seconds INTEGER NOT NULL,
        source_created_ms INTEGER NOT NULL,
        committed_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor_pending (
        session_key TEXT PRIMARY KEY,
        seconds INTEGER NOT NULL,
        source_created_ms INTEGER NOT NULL,
        intent_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate (
        instance_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        priority INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        heartbeat_ms INTEGER NOT NULL,
        payload TEXT NOT NULL,
        seconds INTEGER NOT NULL,
        source_created_ms INTEGER NOT NULL
      );
    `)
    this.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", "fence", "0")
  }

  private armTimer(): void {
    this.disarmTimer()
    this.timer = setInterval(() => {
      this.tick()
    }, this.options.tickMs)
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  private disarmTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tryAcquire(): Acquisition {
    if (!this.db) return { status: "error", code: "store-unavailable" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch {
      this.emit({ kind: "contended", reason: "busy" })
      return { status: "contended", fence: -1, owner: { instanceId: "", pid: 0, generation: "", fence: -1, acquiredMs: 0, heartbeatMs: 0 } }
    }
    try {
      const now = this.options.now()
      const owner = this.readOwner()
      if (!owner) {
        const fence = this.nextFence()
        this.db.run(
          `INSERT INTO owner (singleton, ${OWNER_COLUMNS}) VALUES (1, ?, ?, ?, ?, ?, ?)`,
          this.identity.instanceId,
          this.identity.pid,
          this.identity.generation,
          fence,
          now,
          now,
        )
        this.db.exec("COMMIT")
        this.owned = true
        this.fence = fence
        this.emit({ kind: "acquire", fence })
        return { status: "acquired", fence }
      }

      if (owner.instanceId === this.identity.instanceId && owner.generation === this.identity.generation) {
        this.db.run("UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1", now)
        this.db.exec("COMMIT")
        this.owned = true
        this.fence = owner.fence
        this.emit({ kind: "renew", fence: owner.fence })
        return { status: "renewed", fence: owner.fence }
      }

      if (now - owner.heartbeatMs >= this.options.staleMs) {
        const fence = this.nextFence()
        this.db.run(
          "UPDATE owner SET instance_id = ?, pid = ?, generation = ?, fence = ?, acquired_ms = ?, heartbeat_ms = ? WHERE singleton = 1",
          this.identity.instanceId,
          this.identity.pid,
          this.identity.generation,
          fence,
          now,
          now,
        )
        this.db.exec("COMMIT")
        this.owned = true
        this.fence = fence
        this.emit({ kind: "takeover", fence, previousFence: owner.fence })
        return { status: "takeover", fence, previous: owner }
      }

      this.db.exec("COMMIT")
      this.owned = false
      this.emit({ kind: "contended", fence: owner.fence })
      return { status: "contended", fence: owner.fence, owner }
    } catch {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Already rolled back.
      }
      this.emit({ kind: "error", code: "acquire-failed" })
      return { status: "error", code: "acquire-failed" }
    }
  }

  private renew(): Acquisition {
    if (!this.db) return { status: "error", code: "store-unavailable" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch {
      return { status: "error", code: "contended" }
    }
    try {
      const owner = this.readOwner()
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK")
        return { status: "revoked", reason: owner ? "fence-changed" : "owner-row-gone" }
      }
      this.db.run("UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1", this.options.now())
      this.db.exec("COMMIT")
      this.emit({ kind: "renew", fence: this.fence })
      return { status: "renewed", fence: this.fence }
    } catch {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Already rolled back.
      }
      this.emit({ kind: "error", code: "renew-failed" })
      return { status: "error", code: "renew-failed" }
    }
  }

  private revoke(reason: RevokeReason): void {
    if (this.revoked) return
    this.revoked = true
    this.owned = false
    this.disarmTimer()
    this.emit({ kind: "revoke", reason, fence: this.fence })
    try {
      this.options.onRevoked?.(reason)
    } catch {
      // A revocation hook must not throw back into the lease logic.
    }
  }

  private readOwner(): OwnerRow | null {
    if (!this.db) return null
    const row = this.db.get<{
      instance_id: string
      pid: number
      generation: string
      fence: number
      acquired_ms: number
      heartbeat_ms: number
    }>(`SELECT ${OWNER_COLUMNS} FROM owner WHERE singleton = 1`)
    if (!row) return null
    return {
      instanceId: row.instance_id,
      pid: row.pid,
      generation: row.generation,
      fence: row.fence,
      acquiredMs: row.acquired_ms,
      heartbeatMs: row.heartbeat_ms,
    }
  }

  private matches(owner: OwnerRow | null): boolean {
    return (
      owner !== null &&
      owner.instanceId === this.identity.instanceId &&
      owner.generation === this.identity.generation &&
      owner.fence === this.fence
    )
  }

  private nextFence(): number {
    if (!this.db) throw new Error("no db")
    const row = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", "fence")
    const current = row ? Number.parseInt(row.value, 10) : 0
    const fence = (Number.isFinite(current) ? current : 0) + 1
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "fence",
      String(fence),
    )
    return fence
  }

  private emit(event: Omit<PublisherEvent, "atMs" | "instanceId" | "pid" | "generation">): void {
    const full: PublisherEvent = {
      ...event,
      atMs: this.options.now(),
      instanceId: this.identity.instanceId,
      pid: this.identity.pid,
      generation: this.identity.generation,
    }
    try {
      this.options.onEvent?.(full)
    } catch {
      // Evidence must never break arbitration.
    }
  }
}

export { OWNER_COLUMNS }
