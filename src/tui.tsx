/**
 * TUI part for the M0 transmission spike. Wiring only: probes, ownership,
 * event observation, one fixed publication command and cleanup.
 *
 * SPIKE ORCHESTRATION: this file intentionally keeps the whole M0 harness in
 * one place. M1 replaces it with the real reducer/session-election wiring; do
 * not grow this into the production architecture.
 */
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/plugin"

import { EvidenceLog, errorRecord, startCapture, type CaptureController } from "./m0/capture.js"
import { classifyLocality, currentSession, inspectSession, loadPseudonymSalt, probeRuntime, pseudonym, sessionAnchorKey, type SessionInspection } from "./m0/probe.js"
import { sanitizeActivity, sanitizeLocality, sanitizeProbe, sanitizePublication, sanitizePublisherEvent, sanitizeRun, sanitizeSnapshot } from "./m0/sanitize.js"
import { Publisher, type Acquisition, type PublisherEvent } from "./m0/publisher.js"
import { CLIENT_ID, buildActivity } from "./discord/presence.js"
import { DiscordIpc } from "./discord/ipc.js"

const PACKAGE_VERSION = "0.0.1"
const PLUGIN_ID = "opencode-presence-discord"

interface M0Options {
  capture: boolean
  live: boolean
  captureReference: boolean
  evidenceDir: string
  runtimeDir: string
}

function optionBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function optionString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback
}

export function resolveOptions(context: Context): M0Options {
  const raw = (context.options?.m0 ?? {}) as Record<string, unknown>
  const xdgRuntime = process.env.XDG_RUNTIME_DIR
  const defaultRuntime = xdgRuntime ? join(xdgRuntime, "opencode-presence-discord") : join(tmpdir(), "opencode-presence-discord")
  const runtimeDir = optionString(raw.runtimeDir, defaultRuntime)
  return {
    capture: optionBoolean(raw.capture, false),
    live: optionBoolean(raw.live, false),
    captureReference: optionBoolean(raw.captureReference, true),
    evidenceDir: optionString(raw.evidenceDir, join(runtimeDir, "evidence")),
    runtimeDir,
  }
}

function discordSocketPath(): string {
  if (process.env.DISCORD_IPC_PATH) return process.env.DISCORD_IPC_PATH
  const runtime = process.env.XDG_RUNTIME_DIR
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (runtime) return join(runtime, "discord-ipc-0")
  if (uid !== undefined) return `/run/user/${uid}/discord-ipc-0`
  return join(tmpdir(), "discord-ipc-0")
}

function timestamp(): string {
  return new Date().toISOString()
}

export type PublicationPhase = "lifecycle" | "pre-enqueue" | "enqueued" | "post-enqueue" | "acknowledged"

export type PublicationAttempt =
  | "ready"
  | "socket-close"
  | "socket-error"
  | "command-publish"
  | "disconnect-command"
  | "disconnect"
  | "revoked"
  | "cleanup"
  | "cleanup-close"
  | "coordination-start"

export type PublicationCode =
  | "live-disabled"
  | "identity-unknown"
  | "no-coordinator"
  | "no-observed-session"
  | "session-unreadable"
  | "executed-model-unknown"
  | "executed-provider-unknown"
  | "executed-variant-unknown"
  | "executed-agent-unknown"
  | "timestamp-unavailable"
  | "payload-invalid"
  | "anchor-conflict"
  | "anchor-persist-failed"
  | "not-owner"
  | "connect-failed"
  | "enqueue-busy"
  | "enqueue-not-owner"
  | "enqueue-revoked"
  | "enqueue-no-store"
  | "enqueue-error"
  | "rpc-rejected"
  | "rpc-timeout"
  | "rpc-closed"
  | "clear-refused"
  | "no-socket"
  | "socket-closed"
  | "socket-error"
  | "publisher-revoked"
  | "cleanup"

export interface TimestampProvenance {
  seconds: number
  sourceField: string
  originalValue: number
  originalUnits: "milliseconds since Unix epoch"
  conversion: "floor(ms/1000)"
  committed: boolean
  anchorCommitted: boolean
}

interface ModelProvenance {
  selected: unknown
  executed: unknown
  agent: string | null
  sessionCost: number | null
  reportedCost: number | null
  tokens: unknown
}

interface PublicationRecord {
  v: 1
  at: string
  instanceId: string
  pid: number
  attempt: PublicationAttempt
  phase?: PublicationPhase
  live: boolean
  sessionHash?: string
  selector?: "route" | "event"
  fence?: number
  ready?: boolean
  nonce?: string
  cmd?: "SET_ACTIVITY"
  evt?: "ERROR" | null
  activity?: unknown
  rpcOk?: boolean
  durationMs?: number
  code?: PublicationCode
  timestampProvenance?: TimestampProvenance | { refusal: "timestamp-unavailable" }
  modelProvenance?: ModelProvenance
}

function errorCode(error: unknown): PublicationCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (code === "ETIMEDOUT") return "rpc-timeout"
    if (code === "ECLOSED") return "rpc-closed"
    if (code === "ERPC") return "rpc-rejected"
  }
  return "connect-failed"
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    const runId = randomUUID()
    const options = resolveOptions(context)
    const salt = loadPseudonymSalt(options.runtimeDir)
    const log = new EvidenceLog({ dir: options.evidenceDir, runId })
    const instanceId = randomUUID()
    const generation = randomUUID()
    const startedAt = timestamp()

    const writeJson = async (name: string, value: unknown): Promise<void> => {
      if (disposed || disposing) return
      try {
        await log.writeJson(name, value)
      } catch {
        // Evidence must never break the plugin or a session.
      }
    }
    let disposed = false
    let disposing = false
    const publishRecord = (record: PublicationRecord): void => {
      if (disposed || disposing) return
      const phase: PublicationPhase =
        record.phase ??
        (["ready", "socket-close", "socket-error", "revoked", "cleanup", "cleanup-close", "coordination-start", "disconnect"].includes(record.attempt)
          ? "lifecycle"
          : record.nonce
            ? record.rpcOk === true
              ? "acknowledged"
              : "post-enqueue"
            : "pre-enqueue")
      const safe = sanitizePublication({ ...record, phase })
      if (safe) log.append("publication.jsonl", safe)
    }

    await log.init()

    const { report: runtimeProbe, backend } = await probeRuntime(context)
    const safeProbe = sanitizeProbe(runtimeProbe) ?? { observedAt: new Date(0).toISOString(), host: { version: "0.0.0", channel: "unknown", kind: "unknown", platform: "unknown", arch: "unknown", pid: 0 }, imports: { net: { ok: false, createConnection: false }, "bun:sqlite": { ok: false }, "node:sqlite": { ok: false } }, sqlite: { usable: false, kind: "bun:sqlite" } }
    await writeJson("probe.json", safeProbe)

    const locality = await classifyLocality(context)
    await writeJson("locality.json", sanitizeLocality(locality) ?? null)

    const rawRun = {
      v: 1,
      runId,
      instanceId,
      pluginId: PLUGIN_ID,
      packageVersion: PACKAGE_VERSION,
      startedAt,
      host: runtimeProbe.host,
      sqlite: runtimeProbe.sqlite,
      imports: runtimeProbe.imports,
      locality,
      options: { capture: options.capture, live: options.live, captureReference: options.captureReference },
      discordSocket: process.env.DISCORD_IPC_PATH ? "env" : "default",
    }
    await writeJson("run.json", sanitizeRun(rawRun) ?? null)

    let ipc: DiscordIpc | null = null
    let capture: CaptureController | null = null
    let publisher: Publisher | null = null
    let acquisition: Acquisition | null = null
    let lastSessionID: string | null = null
    let cleanupDone = false

    const publisherLog = (event: PublisherEvent): void => {
      if (disposed) return
      const safe = sanitizePublisherEvent({ v: 1, ...event })
      if (safe) log.append(`publisher-${instanceId}.jsonl`, safe)
    }

    if (backend) {
      publisher = new Publisher({
        runtimeDir: options.runtimeDir,
        backend,
        identity: { instanceId, pid: process.pid, generation },
        onEvent: publisherLog,
        onRevoked: () => {
          publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "revoked", live: options.live, code: "publisher-revoked" })
          if (ipc) {
            ipc.destroy("publisher lease revoked")
            ipc = null
          }
        },
      })
      try {
        acquisition = publisher.start()
      } catch {
        publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "coordination-start", live: options.live, code: "no-coordinator" })
      }
    }

    const closeIpc = (code: PublicationCode, attempt: PublicationAttempt = "cleanup-close"): void => {
      if (!ipc) return
      ipc.close()
      ipc = null
      publishRecord({
        v: 1,
        at: timestamp(),
        instanceId,
        pid: process.pid,
        attempt,
        live: options.live,
        code,
      })
    }

    const connectIpc = async (): Promise<DiscordIpc> => {
      if (ipc?.isReady) return ipc
      if (ipc) {
        ipc.close()
        ipc = null
      }
      if (disposed || disposing) throw new Error("disposed")
      const connection = new DiscordIpc({
        path: discordSocketPath(),
        clientId: CLIENT_ID,
        onClose: () => {
          publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "socket-close", live: options.live, code: "socket-closed" })
        },
        onError: () => {
          publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "socket-error", live: options.live, code: "socket-error" })
        },
      })
      // Own the pending connection immediately so disposal can close it.
      ipc = connection
      try {
        await connection.connect()
      } catch (error) {
        if (ipc === connection) ipc = null
        connection.close()
        throw error
      }
      if (disposed || disposing) {
        if (ipc === connection) ipc = null
        connection.close()
        throw new Error("disposed")
      }
      publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "ready", live: options.live, ready: true })
      return connection
    }

    const snapshot = async (kind: string): Promise<Record<string, unknown>> => {
      if (disposed || disposing) return {}
      const observed = currentSession(context, lastSessionID)
      let inspection: SessionInspection | null = null
      let anchor = null
      if (observed) {
        inspection = await inspectSession(context, observed.sessionID, salt)
        if (disposed || disposing) return {}
        const key = sessionAnchorKey(locality, observed.sessionID)
        if (publisher && key) anchor = publisher.readAnchor(key)
      }
      const document = {
        v: 1,
        kind,
        at: timestamp(),
        runId,
        instanceId,
        pid: process.pid,
        generation,
        selector: observed ? { reason: observed.reason, sessionHash: pseudonym(salt, observed.sessionID) } : null,
        inspection,
        anchor,
        ownership: publisher
          ? { isOwner: publisher.isOwner, fence: publisher.currentFence, revoked: publisher.isRevoked, ownerRow: publisher.ownerSnapshot() }
          : null,
        acquisition,
        locality,
        probe: { observedAt: runtimeProbe.observedAt, host: runtimeProbe.host, imports: runtimeProbe.imports, sqlite: runtimeProbe.sqlite },
        captureEnabled: options.capture,
        live: options.live,
      }
      const safeDocument = sanitizeSnapshot(document)
      if (!safeDocument) return {}
      await writeJson(`snapshot-${instanceId}.json`, safeDocument)
      await writeJson("snapshot.json", safeDocument)
      const snapshotEvent = sanitizePublisherEvent({ v: 1, kind: "snapshot", atMs: Date.now(), instanceId, pid: process.pid, generation, snapshotKind: kind })
      if (snapshotEvent && !disposed) log.append(`publisher-${instanceId}.jsonl`, snapshotEvent)
      return safeDocument
    }

    const toast = (message: string): void => {
      if (disposed || disposing) return
      try {
        context.ui.toast.show({ title: "Presence M0", message })
      } catch {
        // A toast failure is not a presence failure.
      }
    }

    let publicationChain: Promise<unknown> = Promise.resolve()
    const serialized = <T,>(fn: () => Promise<T>): Promise<T> => {
      const next = publicationChain.then(fn, fn)
      publicationChain = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }

    const publish = (attempt: PublicationAttempt): Promise<void> => serialized(() => publishInner(attempt))

    const publishInner = async (attempt: PublicationAttempt): Promise<void> => {
      const started = Date.now()
      const base: PublicationRecord = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt, phase: "pre-enqueue", live: options.live }
      const refuse = (code: PublicationCode, extra: Partial<PublicationRecord> = {}): void => {
        publishRecord({ ...base, ...extra, code })
        if (!disposed && !disposing) toast(`Presence update refused: ${code}`)
      }
      if (!options.live) return refuse("live-disabled")
      if (!publisher) return refuse("no-coordinator")
      if (disposed || disposing) return
      const observed = currentSession(context, lastSessionID)
      if (!observed || observed.reason === "most-recent") return refuse("no-observed-session")

      // J6: an unknown or remote identity has no durable, server-qualified
      // anchor namespace. Refuse publication rather than sharing a literal
      // "unknown" namespace across unrelated servers.
      const sessionKey = sessionAnchorKey(locality, observed.sessionID)
      if (!sessionKey) return refuse("identity-unknown")

      let connection: DiscordIpc | null = null
      try {
        for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
          if (disposed || disposing) return
          // Availability is decided before any socket exists. A refused
          // identity must not open a Discord connection or log READY.
          const inspection = await inspectSession(context, observed.sessionID, salt)
          if (disposed || disposing) return
          if (!inspection.found) return refuse("session-unreadable")
          if (!inspection.executedModel) return refuse(inspection.executedModelCode ?? "executed-model-unknown")
          if (!inspection.agent) return refuse(inspection.agentCode ?? "executed-agent-unknown")

          const state = publisher.readAnchorState(sessionKey)
          const reserved = state.acknowledgedUnpersisted ?? state.committed ?? state.pending
          const selected =
            reserved !== null
              ? { seconds: reserved.seconds, sourceCreatedMs: reserved.sourceCreatedMs, committed: state.committed !== null || state.acknowledgedUnpersisted !== null }
              : inspection.candidateTimestampSeconds !== null && inspection.latestUserMessageAtMs !== null
                ? { seconds: inspection.candidateTimestampSeconds, sourceCreatedMs: inspection.latestUserMessageAtMs, committed: false }
                : null
          if (!selected) return refuse("timestamp-unavailable")

          const activity = buildActivity({ id: inspection.executedModel.id, providerID: inspection.executedModel.providerID }, selected.seconds)
          if (!sanitizeActivity(activity)) return refuse("payload-invalid")
          const provenance: TimestampProvenance = {
            seconds: selected.seconds,
            sourceField: "session.message.list[].type=user.time.created",
            originalValue: selected.sourceCreatedMs,
            originalUnits: "milliseconds since Unix epoch",
            conversion: "floor(ms/1000)",
            committed: selected.committed,
            anchorCommitted: false,
          }
          const baseWithSession: PublicationRecord = {
            ...base,
            sessionHash: inspection.sessionIDHash ?? undefined,
            selector: observed.reason === "route" ? "route" : "event",
            fence: publisher.currentFence,
            timestampProvenance: provenance,
            modelProvenance: {
              selected: inspection.selectedModel,
              executed: inspection.executedModel,
              agent: inspection.agent,
              sessionCost: inspection.sessionCost,
              reportedCost: inspection.reportedCost,
              tokens: inspection.tokens,
            },
          }

          if (!publisher.isOwner) {
            if (publisher.isPaused) publisher.resume()
            else publisher.tick()
          }
          if (!publisher.isOwner) return refuse("not-owner", baseWithSession)
          if (disposed || disposing) return

          // A durable committed/pending disagreement is a conflict we can
          // already prove without a socket. Refuse it here rather than letting
          // the transactional recheck discover it after connecting.
          const conflicting =
            (state.committed !== null && (state.committed.seconds !== selected.seconds || state.committed.sourceCreatedMs !== selected.sourceCreatedMs)) ||
            (state.pending !== null && (state.pending.seconds !== selected.seconds || state.pending.sourceCreatedMs !== selected.sourceCreatedMs))
          if (conflicting) return refuse("anchor-conflict", baseWithSession)

          // Everything that can refuse on identity, timestamps, payload or
          // ownership has passed. Only now is the publication attempted, so
          // the socket is opened here rather than before validation.
          if (!connection) {
            try {
              connection = await connectIpc()
            } catch {
              return refuse("connect-failed", baseWithSession)
            }
          }
          if (!connection || disposed || disposing) return

          // Durable intent precedes the synchronous owner/fence + socket
          // enqueue transaction, which rechecks authoritative anchor state.
          const critical = publisher.criticalPublish(sessionKey, { seconds: selected.seconds, sourceCreatedMs: selected.sourceCreatedMs }, () =>
            connection!.enqueueSetActivity(process.pid, activity as unknown as Record<string, unknown>),
          )
          if (!critical.ok) {
            if (critical.reason === "anchor-conflict" || critical.reason === "anchor-pending") continue
            const code: PublicationCode =
              critical.reason === "busy"
                ? "enqueue-busy"
                : critical.reason === "not-owner"
                  ? "enqueue-not-owner"
                  : critical.reason === "revoked"
                    ? "enqueue-revoked"
                    : critical.reason === "no-store"
                      ? "enqueue-no-store"
                      : "enqueue-error"
            return refuse(code, { ...baseWithSession, activity })
          }

          const request = critical.value
          const enqueuedAt = timestamp()
          publishRecord({ ...baseWithSession, at: enqueuedAt, phase: "enqueued", fence: critical.fence, activity, nonce: request.nonce, cmd: "SET_ACTIVITY" })
          try {
            const reply = await request.reply
            if (disposed || disposing) return
            const ok = reply.evt !== "ERROR"
            if (!ok) {
              publishRecord({
                ...baseWithSession,
                at: enqueuedAt,
                phase: "post-enqueue",
                fence: critical.fence,
                activity,
                nonce: request.nonce,
                cmd: "SET_ACTIVITY",
                evt: "ERROR",
                rpcOk: false,
                code: "rpc-rejected",
                durationMs: Date.now() - started,
              })
              toast("Discord rejected the presence update")
              return
            }
            const commit = publisher.markAcknowledged(sessionKey, selected.seconds, selected.sourceCreatedMs)
            publishRecord({
              ...baseWithSession,
              at: enqueuedAt,
              phase: "acknowledged",
              fence: critical.fence,
              activity,
              nonce: request.nonce,
              cmd: "SET_ACTIVITY",
              evt: null,
              rpcOk: true,
              ...(commit.ok ? {} : { code: commit.code }),
              timestampProvenance: { ...provenance, anchorCommitted: commit.ok },
              durationMs: Date.now() - started,
            })
            toast("Presence sent (RPC acknowledged)")
            return
          } catch (error) {
            if (disposed || disposing) return
            publishRecord({
              ...baseWithSession,
              at: enqueuedAt,
              phase: "post-enqueue",
              fence: critical.fence,
              activity,
              nonce: request.nonce,
              cmd: "SET_ACTIVITY",
              ...(errorCode(error) === "rpc-rejected" ? { evt: "ERROR" as const } : {}),
              rpcOk: false,
              code: errorCode(error),
              durationMs: Date.now() - started,
            })
            toast("No RPC acknowledgment")
            return
          }
        }
        return refuse("anchor-conflict")
      } finally {
        if (disposed && connection) connection.close()
      }
    }

    const disconnect = (): Promise<void> => serialized(disconnectInner)

    const disconnectInner = async (): Promise<void> => {
      if (disposed || disposing) return
      const attempt: PublicationRecord = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "disconnect-command", live: options.live }
      if (options.live && ipc?.isReady && publisher?.isOwner) {
        const connection = ipc
        const critical = publisher.criticalEnqueue(() => connection.enqueueClearActivity(process.pid))
        if (critical.ok) {
          publishRecord({ ...attempt, phase: "enqueued", fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY" })
          try {
            const reply = await critical.value.reply
            const ok = reply.evt !== "ERROR"
            publishRecord({ ...attempt, phase: ok ? "acknowledged" : "post-enqueue", fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY", evt: ok ? null : "ERROR", rpcOk: ok, ...(ok ? {} : { code: "rpc-rejected" as const }) })
          } catch (error) {
            publishRecord({ ...attempt, phase: "post-enqueue", fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY", ...(errorCode(error) === "rpc-rejected" ? { evt: "ERROR" as const } : {}), rpcOk: false, code: errorCode(error) })
          }
        } else {
          publishRecord({ ...attempt, code: "clear-refused" })
        }
      } else {
        publishRecord({ ...attempt, code: options.live ? "no-socket" : "live-disabled" })
      }
      if (disposed || disposing) return
      closeIpc("no-socket", "disconnect")
      if (publisher) publisher.release()
      toast("Disconnected")
    }

    const runSubcommand = async (input?: string, event?: string): Promise<void> => {
      if (disposed || disposing) return
      const raw = (input ?? event ?? "").trim()
      const command = raw.split(/\s+/)[0] ?? ""
      if (command === "snapshot") {
        const document = await snapshot("manual-snapshot")
        const inspection = document.inspection as SessionInspection | null
        toast(
          inspection?.found
            ? `Snapshot: ${inspection.status ?? "unknown"} · ${inspection.executedModel?.providerID ?? "?"}/${inspection.executedModel?.id ?? "?"}`
            : "Snapshot written: no session observed",
        )
        return
      }
      if (command === "publish") {
        await publish("command-publish")
        return
      }
      if (command === "disconnect") {
        await disconnect()
        return
      }
      toast("Usage: /presence-m0 snapshot | publish | disconnect")
    }

    try {
      context.keymap.layer(() => ({
        commands: [
          {
            id: "presence-m0",
            title: "Presence M0",
            description: "Discord presence transmission spike",
            group: "presence",
            bind: false,
            palette: true,
            slash: { name: "presence-m0", arguments: true },
            run: (input?: string, event?: unknown) => runSubcommand(input, typeof event === "string" ? event : undefined),
          },
          {
            id: "presence-m0-snapshot",
            title: "Presence M0: snapshot",
            group: "presence",
            bind: false,
            palette: true,
            run: () => runSubcommand("snapshot"),
          },
          {
            id: "presence-m0-publish",
            title: "Presence M0: publish",
            group: "presence",
            bind: false,
            palette: true,
            run: () => runSubcommand("publish"),
          },
          {
            id: "presence-m0-disconnect",
            title: "Presence M0: disconnect",
            group: "presence",
            bind: false,
            palette: true,
            run: () => runSubcommand("disconnect"),
          },
        ],
      }))
    } catch (error) {
      log.append("capture.jsonl", errorRecord("command.registration.failed", "capture-invalid", instanceId))
    }

    const unsubscribe = context.data.listen(({ details }) => {
      if (disposed || disposing) return
      const event = details as unknown as Record<string, unknown>
      try {
        const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>
        if (typeof data.sessionID === "string") lastSessionID = data.sessionID
        capture?.onListen(event)
      } catch (error) {
        capture?.notify("capture.listen.error", "capture-listen-failed")
      }
    })

    if (options.capture) {
      try {
        capture = startCapture(log, { salt, reference: options.captureReference, context, instanceId })
      } catch (error) {
        log.append("capture.jsonl", errorRecord("capture.start.failed", "capture-start-failed", instanceId))
      }
    }

    try {
      await snapshot("startup-mid-task")
    } catch (error) {
      log.append("capture.jsonl", errorRecord("snapshot.startup.failed", "snapshot-startup-failed", instanceId))
    }

    return async () => {
      if (cleanupDone) return
      cleanupDone = true
      disposing = true
      const cleanupRecord = sanitizePublication({
        v: 1,
        at: timestamp(),
        instanceId,
        pid: process.pid,
        attempt: "cleanup",
        phase: "lifecycle",
        live: options.live,
        ...(ipc ? { ready: ipc.isReady } : {}),
      })
      if (cleanupRecord) log.append("publication.jsonl", cleanupRecord)
      // Close pending as well as READY sockets before any asynchronous wait.
      if (ipc) {
        ipc.close()
        ipc = null
      }
      try {
        unsubscribe()
      } catch {
        // Listener is already gone.
      }
      if (capture) {
        capture.stop()
      }
      if (publisher) {
        if (publisher.isOwner && publisher.currentFence > 0) {
          const cleanupEvent = sanitizePublisherEvent({
            v: 1,
            kind: "cleanup",
            atMs: Date.now(),
            instanceId,
            pid: process.pid,
            generation: publisher.identity.generation,
            fence: publisher.currentFence,
            reason: "cleanup",
          })
          if (cleanupEvent) log.append(`publisher-${instanceId}.jsonl`, cleanupEvent)
        }
        // Do not clear on reload: M0 records the actual card lifetime.
        publisher.stop()
      }
      disposed = true
      if (capture) await Promise.race([capture.referenceTask, new Promise<void>((resolve) => setTimeout(resolve, 500))])
      if (capture) {
        await capture.flush()
      } else {
        await log.close()
      }
    }
  },
})
