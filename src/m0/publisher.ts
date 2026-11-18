/**
 * Cross-process publisher ownership for M0.
 *
 * One SQLite row is the lease. Fence numbers live in `meta` and only ever
 * increase. Every Discord enqueue runs inside `criticalEnqueue`, which checks
 * owner + fence in the same IMMEDIATE transaction that performs the
 * synchronous socket write. No await, handshake or response wait is allowed
 * in that section.
 */
import { randomUUID } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, openSync, statSync, chmodSync } from "node:fs"
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

export type Acquisition =
  | { status: "acquired"; fence: number }
  | { status: "renewed"; fence: number }
  | { status: "takeover"; fence: number; previous: OwnerRow }
  | { status: "contended"; fence: number; owner: OwnerRow }
  | { status: "revoked"; reason: string }
  | { status: "error"; reason: string }

export type CriticalResult<T> =
  | { ok: true; value: T; fence: number }
  | { ok: false; reason: "not-owner" | "revoked" | "busy" | "no-store" | "error"; error?: string }

export interface PublisherEvent {
  kind: "acquire" | "renew" | "takeover" | "contended" | "release" | "revoke" | "critical" | "error"
  atMs: number
  instanceId: string
  pid: number
  generation: string
  fence?: number
  previousFence?: number
  reason?: string
  detail?: string
}

export interface PublisherOptions {
  runtimeDir: string
  backend: SqliteBackend
  heartbeatMs?: number
  staleMs?: number
  tickMs?: number
  now?: () => number
  onEvent?: (event: PublisherEvent) => void
  onRevoked?: (reason: string) => void
  /** Test-only: called inside the verified critical section, before enqueue. */
  onCriticalEnter?: () => void
  /** Test-only: busy-wait inside the critical section. Never set in production. */
  holdCriticalMs?: number
  /** Caller-supplied identity so evidence file names and lease rows agree. */
  identity?: OwnerIdentity
}

const OWNER_COLUMNS = "instance_id, pid, generation, fence, acquired_ms, heartbeat_ms"

export class Publisher {
  readonly identity: OwnerIdentity
  readonly dbPath: string
  private readonly options: Required<Omit<PublisherOptions, "onEvent" | "onRevoked" | "holdCriticalMs" | "onCriticalEnter" | "identity">> & {
    onEvent?: (event: PublisherEvent) => void
    onRevoked?: (reason: string) => void
    onCriticalEnter?: () => void
    holdCriticalMs?: number
  }
  private db: SqliteHandle | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private owned = false
  private fence = 0
  private revoked = false
  private closed = false
  private paused = false

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
      onCriticalEnter: options.onCriticalEnter,
      holdCriticalMs: options.holdCriticalMs,
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
    if (this.closed) return { status: "error", reason: "publisher already closed" }
    try {
      this.prepareRuntimeDir()
      this.db = this.options.backend.open(this.dbPath)
      this.db.exec("PRAGMA journal_mode = WAL")
      this.db.exec("PRAGMA synchronous = FULL")
      this.initSchema()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ kind: "error", reason })
      return { status: "error", reason }
    }

    const first = this.tryAcquire()
    this.armTimer()
    return first
  }

  /** One asynchronous retry path. Contention never blocks the caller. */
  tick(): Acquisition | null {
    if (this.closed || this.revoked || this.paused || !this.db) return null
    const result = this.owned ? this.renew() : this.tryAcquire()
    if (result.status === "revoked") this.revoke(result.reason)
    return result
  }

  criticalEnqueue<T>(enqueue: () => T): CriticalResult<T> {
    if (!this.db) return { ok: false, reason: "no-store" }
    if (this.revoked || this.closed) return { ok: false, reason: "revoked" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch (error) {
      return { ok: false, reason: "busy", error: error instanceof Error ? error.message : String(error) }
    }

    try {
      const owner = this.readOwner()
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK")
        this.emit({ kind: "critical", reason: "not-owner", fence: owner?.fence })
        this.revoke("fence-mismatch")
        return { ok: false, reason: "not-owner" }
      }
      this.db.run(
        "UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1 AND instance_id = ? AND fence = ?",
        this.options.now(),
        this.identity.instanceId,
        this.fence,
      )
      this.options.onCriticalEnter?.()
      // Synchronous only. This is the guarantee boundary: once this returns,
      // the frame is handed to the OS and cannot be recalled.
      const value = enqueue()
      if (this.options.holdCriticalMs && this.options.holdCriticalMs > 0) {
        const until = this.options.now() + this.options.holdCriticalMs
        while (this.options.now() < until) {
          // Test-only synchronous hold.
        }
      }
      this.db.exec("COMMIT")
      this.emit({ kind: "critical", fence: this.fence })
      return { ok: true, value, fence: this.fence }
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // The transaction may already be gone; keep the original error.
      }
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ kind: "error", reason: "critical-enqueue", detail: message })
      return { ok: false, reason: "error", error: message }
    }
  }

  release(): boolean {
    if (!this.db || !this.owned || this.revoked) {
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
    } catch (error) {
      this.emit({ kind: "error", reason: "release", detail: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Re-enter arbitration after an explicit release, e.g. publish after disconnect. */
  resume(): Acquisition | null {
    if (this.closed || this.revoked || !this.db) return null
    this.paused = false
    this.armTimer()
    return this.owned ? this.renew() : this.tryAcquire()
  }

  stop(): void {
    if (this.closed) return
    this.disarmTimer()
    if (this.owned && !this.revoked) this.release()
    this.closed = true
    try {
      this.db?.close()
    } catch {
      // Closing a coordination DB is best effort during shutdown.
    }
    this.db = null
  }

  ownerSnapshot(): OwnerRow | null {
    if (!this.db) return null
    try {
      return this.readOwner()
    } catch {
      return null
    }
  }

  private prepareRuntimeDir(): void {
    mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.options.runtimeDir)
    if (stat.isSymbolicLink()) throw new Error(`runtime dir is a symlink: ${this.options.runtimeDir}`)
    if (!stat.isDirectory()) throw new Error(`runtime dir is not a directory: ${this.options.runtimeDir}`)
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) throw new Error("runtime dir is owned by another user")
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(this.options.runtimeDir, 0o700)
      const tightened = statSync(this.options.runtimeDir)
      if ((tightened.mode & 0o077) !== 0) throw new Error("runtime dir could not be tightened to 0700")
    }

    // The DB is opened by SQLite; refuse a symlink or foreign-owned file first.
    try {
      const dbStat = lstatSync(this.dbPath)
      if (dbStat.isSymbolicLink()) throw new Error("publisher.sqlite is a symlink")
      if (!dbStat.isFile()) throw new Error("publisher.sqlite is not a regular file")
      if (uid !== undefined && dbStat.uid !== uid) throw new Error("publisher.sqlite is owned by another user")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
      // Create it exclusively so a racing symlink cannot be followed.
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
    `)
    this.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", "fence", "0")
  }

  private armTimer(): void {
    this.disarmTimer()
    this.timer = setInterval(() => {
      this.tick()
    }, this.options.tickMs)
    // Do not keep a closing TUI alive just for the lease.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  private disarmTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tryAcquire(): Acquisition {
    if (!this.db) return { status: "error", reason: "no db" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ kind: "contended", reason: "busy", detail: reason })
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
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Already rolled back.
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ kind: "error", reason: "acquire", detail: reason })
      return { status: "error", reason }
    }
  }

  private renew(): Acquisition {
    if (!this.db) return { status: "error", reason: "no db" }
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ kind: "error", reason: "renew-busy", detail: reason })
      return { status: "error", reason }
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
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Already rolled back.
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ kind: "error", reason: "renew", detail: reason })
      return { status: "error", reason }
    }
  }

  private revoke(reason: string): void {
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
