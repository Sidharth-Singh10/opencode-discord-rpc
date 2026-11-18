/**
 * TUI part for the M0 transmission spike. Wiring only: probes, ownership,
 * event observation, one fixed publication command and cleanup.
 *
 * SPIKE ORCHESTRATION: this file intentionally keeps the whole M0 harness in
 * one place. M1 replaces it with the real reducer/session-election wiring; do
 * not grow this into the production architecture.
 */
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/plugin"

import { EvidenceLog, errorRecord, startCapture, type CaptureController } from "./m0/capture.js"
import { classifyLocality, currentSession, inspectSession, loadPseudonymSalt, probeRuntime, pseudonym, resolveSessionTimestamp, type SessionInspection } from "./m0/probe.js"
import { Publisher, type Acquisition, type PublisherEvent } from "./m0/publisher.js"
import { CLIENT_ID, buildActivity, validateActivity } from "./discord/presence.js"
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
  | "no-coordinator"
  | "no-observed-session"
  | "session-unreadable"
  | "executed-model-unknown"
  | "timestamp-unavailable"
  | "payload-invalid"
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

function sessionAnchorKey(classification: { class: string; serverFingerprint: string | null }, sessionID: string): string {
  return createHash("sha256").update(classification.class).update("\u0000").update(classification.serverFingerprint ?? "unknown").update("\u0000").update(sessionID).digest("hex")
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
      try {
        await log.writeJson(name, value)
      } catch {
        // Evidence must never break the plugin or a session.
      }
    }
    const publishRecord = (record: PublicationRecord): void => {
      log.append("publication.jsonl", record)
    }

    await log.init()

    const { report: runtimeProbe, backend } = await probeRuntime(context)
    await writeJson("probe.json", runtimeProbe)

    const locality = await classifyLocality(context)
    await writeJson("locality.json", locality)

    await writeJson("run.json", {
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
    })

    let ipc: DiscordIpc | null = null
    let capture: CaptureController | null = null
    let publisher: Publisher | null = null
    let acquisition: Acquisition | null = null
    let lastSessionID: string | null = null
    let cleanupDone = false

    const publisherLog = (event: PublisherEvent): void => {
      log.append(`publisher-${instanceId}.jsonl`, { v: 1, ...event })
    }

    if (backend) {
      publisher = new Publisher({
        runtimeDir: options.runtimeDir,
        backend,
        identity: { instanceId, pid: process.pid, generation },
        onEvent: publisherLog,
        onRevoked: () => {
          log.append("publication.jsonl", {
            v: 1,
            at: timestamp(),
            instanceId,
            pid: process.pid,
            attempt: "revoked",
            live: options.live,
            code: "publisher-revoked",
          })
          if (ipc) {
            ipc.destroy("publisher lease revoked")
            ipc = null
          }
        },
      })
      try {
        acquisition = publisher.start()
      } catch {
        log.append("publication.jsonl", {
          v: 1,
          at: timestamp(),
          instanceId,
          pid: process.pid,
          attempt: "coordination-start",
          live: options.live,
          code: "no-coordinator",
        })
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
      const socketPath = discordSocketPath()
      const connection = new DiscordIpc({
        path: socketPath,
        clientId: CLIENT_ID,
        onClose: () => {
          log.append("publication.jsonl", {
            v: 1,
            at: timestamp(),
            instanceId,
            pid: process.pid,
            attempt: "socket-close",
            live: options.live,
            code: "socket-closed",
          })
        },
        onError: () => {
          log.append("publication.jsonl", {
            v: 1,
            at: timestamp(),
            instanceId,
            pid: process.pid,
            attempt: "socket-error",
            live: options.live,
            code: "socket-error",
          })
        },
      })
      await connection.connect()
      ipc = connection
      publishRecord({
        v: 1,
        at: timestamp(),
        instanceId,
        pid: process.pid,
        attempt: "ready",
        live: options.live,
        ready: true,
      })
      return connection
    }

    const snapshot = async (kind: string): Promise<Record<string, unknown>> => {
      const observed = currentSession(context, lastSessionID)
      let inspection: SessionInspection | null = null
      let anchor = null
      if (observed) {
        inspection = await inspectSession(context, observed.sessionID, salt)
        if (publisher) anchor = publisher.readAnchor(sessionAnchorKey(locality, observed.sessionID))
      }
      const document = {
        v: 1,
        kind,
        at: timestamp(),
        runId,
        instanceId,
        pid: process.pid,
        generation: publisher?.identity.generation ?? null,
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
      await writeJson(`snapshot-${instanceId}.json`, document)
      await writeJson("snapshot.json", document)
      log.append(`publisher-${instanceId}.jsonl`, { v: 1, kind: "snapshot", atMs: Date.now(), instanceId, pid: process.pid, generation, snapshotKind: kind })
      return document
    }

    const toast = (message: string): void => {
      try {
        context.ui.toast.show({ title: "Presence M0", message })
      } catch {
        // A toast failure is not a presence failure.
      }
    }

    const publish = async (attempt: PublicationAttempt): Promise<void> => {
      const started = Date.now()
      const base: PublicationRecord = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt, live: options.live }
      if (!options.live) {
        publishRecord({ ...base, code: "live-disabled" })
        toast("Refused: live publication is off")
        return
      }
      if (!publisher) {
        publishRecord({ ...base, code: "no-coordinator" })
        toast("Refused: coordination store unavailable")
        return
      }
      const observed = currentSession(context, lastSessionID)
      if (!observed || observed.reason === "most-recent") {
        publishRecord({ ...base, code: "no-observed-session" })
        toast("Refused: no observed session")
        return
      }

      const inspection = await inspectSession(context, observed.sessionID, salt)
      const sessionKey = sessionAnchorKey(locality, observed.sessionID)
      const anchor = publisher.readAnchor(sessionKey)
      const selectedTimestamp = resolveSessionTimestamp(anchor, inspection.latestUserMessageAtMs)
      const provenance: TimestampProvenance | { refusal: "timestamp-unavailable" } =
        "code" in selectedTimestamp
          ? { refusal: "timestamp-unavailable" }
          : {
              seconds: selectedTimestamp.seconds,
              sourceField: "session.message.list[].type=user.time.created",
              originalValue: selectedTimestamp.sourceCreatedMs,
              originalUnits: "milliseconds since Unix epoch",
              conversion: "floor(ms/1000)",
              committed: selectedTimestamp.committed,
              anchorCommitted: false,
            }

      const baseWithSession: PublicationRecord = {
        ...base,
        sessionHash: inspection.sessionIDHash ?? undefined,
        selector: observed.reason,
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

      if (!inspection.found) {
        publishRecord({ ...baseWithSession, code: "session-unreadable" })
        toast("Refused: session not readable")
        return
      }
      if (!inspection.executedModel) {
        publishRecord({ ...baseWithSession, code: "executed-model-unknown" })
        toast("Refused: executed model unknown")
        return
      }
      if ("code" in selectedTimestamp) {
        publishRecord({ ...baseWithSession, code: "timestamp-unavailable" })
        toast("Refused: no session-anchored timestamp")
        return
      }
      const seconds = selectedTimestamp.seconds
      const sourceMs = selectedTimestamp.sourceCreatedMs

      const activity = buildActivity({ id: inspection.executedModel.id, providerID: inspection.executedModel.providerID }, seconds)
      const validation = validateActivity(activity)
      if (!validation.ok) {
        publishRecord({ ...baseWithSession, activity, code: "payload-invalid" })
        toast("Refused: payload validation failed")
        return
      }
      if (!publisher.isOwner) {
        // A fast, synchronous acquisition attempt. Contention still fails fast
        // and the asynchronous ticker keeps trying.
        if (publisher.isPaused) publisher.resume()
        else publisher.tick()
      }
      if (!publisher.isOwner) {
        publishRecord({ ...baseWithSession, activity, code: "not-owner" })
        toast("Refused: another instance owns the card")
        return
      }

      let connection: DiscordIpc
      try {
        connection = await connectIpc()
      } catch {
        publishRecord({ ...baseWithSession, activity, code: "connect-failed" })
        toast("Discord is not reachable")
        return
      }

      // The only code allowed to enqueue SET_ACTIVITY: verified owner + fence
      // in the same IMMEDIATE transaction as the synchronous socket write.
      const critical = publisher.criticalEnqueue(() => connection.enqueueSetActivity(process.pid, activity as unknown as Record<string, unknown>))
      if (!critical.ok) {
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
        publishRecord({ ...baseWithSession, activity, code, durationMs: Date.now() - started })
        toast("Refused: fenced enqueue rejected")
        return
      }

      const request = critical.value
      // Timestamp the record at the fenced enqueue, not at command entry: the
      // ownership check must see the fence that was current at the write.
      const enqueuedAt = timestamp()
      publishRecord({ ...baseWithSession, at: enqueuedAt, fence: critical.fence, activity, nonce: request.nonce, cmd: "SET_ACTIVITY" })
      try {
        const reply = await request.reply
        const ok = reply.evt !== "ERROR"
        let anchorCommitted = false
        if (ok) {
          anchorCommitted = publisher.commitAnchor(sessionKey, seconds, sourceMs)
        }
        publishRecord({
          ...baseWithSession,
          at: enqueuedAt,
          fence: critical.fence,
          activity,
          nonce: request.nonce,
          cmd: "SET_ACTIVITY",
          evt: ok ? null : "ERROR",
          rpcOk: ok,
          ...(ok ? {} : { code: "rpc-rejected" as const }),
          timestampProvenance: { ...provenance, anchorCommitted },
          durationMs: Date.now() - started,
        })
        toast(ok ? "Presence sent (RPC acknowledged)" : "Discord rejected the presence update")
      } catch (error) {
        publishRecord({
          ...baseWithSession,
          at: enqueuedAt,
          fence: critical.fence,
          activity,
          nonce: request.nonce,
          rpcOk: false,
          code: errorCode(error),
          durationMs: Date.now() - started,
        })
        toast("No RPC acknowledgment")
      }
    }

    const disconnect = async (): Promise<void> => {
      const attempt: PublicationRecord = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "disconnect-command", live: options.live }
      if (options.live && ipc?.isReady && publisher?.isOwner) {
        const connection = ipc
        const critical = publisher.criticalEnqueue(() => connection.enqueueClearActivity(process.pid))
        if (critical.ok) {
          try {
            const reply = await critical.value.reply
            const ok = reply.evt !== "ERROR"
            publishRecord({ ...attempt, fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY", evt: ok ? null : "ERROR", rpcOk: ok, ...(ok ? {} : { code: "rpc-rejected" as const }) })
          } catch (error) {
            publishRecord({ ...attempt, fence: critical.fence, nonce: critical.value.nonce, rpcOk: false, code: errorCode(error) })
          }
        } else {
          publishRecord({ ...attempt, code: "clear-refused" })
        }
      } else {
        publishRecord({ ...attempt, code: options.live ? "no-socket" : "live-disabled" })
      }
      closeIpc("no-socket", "disconnect")
      if (publisher) publisher.release()
      toast("Disconnected")
    }

    const runSubcommand = async (input?: string, event?: string): Promise<void> => {
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
      const at = timestamp()
      log.append("publication.jsonl", {
        v: 1,
        at,
        instanceId,
        pid: process.pid,
        attempt: "cleanup",
        live: options.live,
        ...(ipc ? { ready: ipc.isReady } : {}),
      })
      try {
        unsubscribe()
      } catch {
        // Listener is already gone.
      }
      if (capture) {
        capture.stop()
        await Promise.race([capture.referenceTask, new Promise<void>((resolve) => setTimeout(resolve, 500))])
      }
      if (publisher) {
        if (publisher.isOwner && publisher.currentFence > 0) {
          const fence = publisher.currentFence
          log.append(`publisher-${instanceId}.jsonl`, {
            v: 1,
            kind: "cleanup",
            atMs: Date.now(),
            instanceId,
            pid: process.pid,
            generation: publisher.identity.generation,
            fence,
            reason: "cleanup",
          })
        }
        // Do not clear on reload: the previous milestone behaviour is a short
        // flicker, and M0 records the actual card lifetime instead.
        closeIpc("cleanup", "cleanup-close")
        publisher.stop()
      }
      if (capture) {
        await capture.flush()
      } else {
        await log.close()
      }
    }
  },
})
