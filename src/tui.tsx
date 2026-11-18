/**
 * TUI part for the M0 transmission spike. Wiring only: probes, ownership,
 * event observation, one fixed publication command and cleanup.
 */
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/plugin"

import { EvidenceLog, startCapture, type CaptureController } from "./m0/capture.js"
import { classifyLocality, currentSession, inspectSession, loadPseudonymSalt, probeRuntime, pseudonym, type SessionInspection } from "./m0/probe.js"
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

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

interface PublicationRecord {
  v: 1
  at: string
  instanceId: string
  pid: number
  attempt: string
  live: boolean
  sessionHash?: string
  selector?: string
  fence?: number
  ready?: boolean
  socketPath?: string
  nonce?: string
  cmd?: string
  evt?: string
  activity?: unknown
  rpcOk?: boolean
  rpcError?: string
  durationMs?: number
  refused?: string
  timestampProvenance?: unknown
  modelProvenance?: unknown
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
      options: { capture: options.capture, live: options.live, captureReference: options.captureReference, runtimeDir: options.runtimeDir },
      socketPath: discordSocketPath(),
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
        onRevoked: (reason) => {
          log.append("publication.jsonl", {
            v: 1,
            at: timestamp(),
            instanceId,
            pid: process.pid,
            attempt: "revoked",
            live: options.live,
            refused: `publisher lease revoked: ${reason}`,
          })
          if (ipc) {
            ipc.destroy(`publisher lease revoked: ${reason}`)
            ipc = null
          }
        },
      })
      try {
        acquisition = publisher.start()
      } catch (error) {
        log.append("publication.jsonl", {
          v: 1,
          at: timestamp(),
          instanceId,
          pid: process.pid,
          attempt: "coordination-start",
          live: options.live,
          refused: errorText(error),
        })
      }
    }

    const closeIpc = (reason: string, attempt = "disconnect"): void => {
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
        refused: reason,
      })
    }

    const connectIpc = async (): Promise<DiscordIpc> => {
      if (ipc?.isReady) return ipc
      const socketPath = discordSocketPath()
      const connection = new DiscordIpc({
        path: socketPath,
        clientId: CLIENT_ID,
        onClose: (reason) => {
          log.append("publication.jsonl", {
            v: 1,
            at: timestamp(),
            instanceId,
            pid: process.pid,
            attempt: "socket-close",
            live: options.live,
            socketPath,
            refused: reason,
          })
        },
        onError: (error) => {
          log.append("publication.jsonl", {
            v: 1,
            at: timestamp(),
            instanceId,
            pid: process.pid,
            attempt: "socket-error",
            live: options.live,
            socketPath,
            rpcError: errorText(error),
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
        socketPath,
        ready: true,
      })
      return connection
    }

    const snapshot = async (kind: string): Promise<Record<string, unknown>> => {
      const observed = currentSession(context, lastSessionID)
      let inspection: SessionInspection | null = null
      if (observed) {
        inspection = await inspectSession(context, observed.sessionID, salt)
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
        ownership: publisher
          ? { isOwner: publisher.isOwner, fence: publisher.currentFence, revoked: publisher.isRevoked, ownerRow: publisher.ownerSnapshot() }
          : null,
        acquisition,
        locality,
        probe: { host: runtimeProbe.host, imports: runtimeProbe.imports, sqlite: runtimeProbe.sqlite },
        captureEnabled: options.capture,
        live: options.live,
      }
      await writeJson(`snapshot-${instanceId}.json`, document)
      await writeJson("snapshot.json", document)
      log.append(`publisher-${instanceId}.jsonl`, { v: 1, kind: "snapshot", atMs: Date.now(), instanceId, pid: process.pid, detail: kind })
      return document
    }

    const toast = (message: string): void => {
      try {
        context.ui.toast.show({ title: "Presence M0", message })
      } catch {
        // A toast failure is not a presence failure.
      }
    }

    const publish = async (attempt: string): Promise<void> => {
      const started = Date.now()
      const base: PublicationRecord = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt, live: options.live }
      if (!options.live) {
        publishRecord({ ...base, refused: "live publication is not enabled (m0.live=false)" })
        toast("Refused: live publication is off")
        return
      }
      if (!publisher) {
        publishRecord({ ...base, refused: "coordination store unavailable; no owner can be verified" })
        toast("Refused: coordination store unavailable")
        return
      }
      const observed = currentSession(context, lastSessionID)
      if (!observed || observed.reason === "most-recent") {
        publishRecord({ ...base, refused: "no session observed from route or events" })
        toast("Refused: no observed session")
        return
      }

      const inspection = await inspectSession(context, observed.sessionID, salt)
      const baseWithSession: PublicationRecord = {
        ...base,
        sessionHash: inspection.sessionIDHash ?? undefined,
        selector: observed.reason,
        fence: publisher.currentFence,
        timestampProvenance:
          inspection.frozenTimestampSeconds !== null
            ? {
                seconds: inspection.frozenTimestampSeconds,
                sourceField: inspection.frozenTimestampSource,
                originalUnits: inspection.timestampOriginalUnits,
              }
            : { refusal: inspection.timestampRefusal },
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
        publishRecord({ ...baseWithSession, refused: "session inspection failed" })
        toast("Refused: session not readable")
        return
      }
      if (!inspection.executedModel) {
        publishRecord({ ...baseWithSession, refused: "executed model is not observable; small_text cannot be honest" })
        toast("Refused: executed model unknown")
        return
      }
      if (inspection.frozenTimestampSeconds === null) {
        publishRecord({ ...baseWithSession, refused: inspection.timestampRefusal ?? "session timestamp unavailable" })
        toast("Refused: no session-anchored timestamp")
        return
      }

      const activity = buildActivity(
        { id: inspection.executedModel.id, providerID: inspection.executedModel.providerID },
        inspection.frozenTimestampSeconds,
      )
      const validation = validateActivity(activity)
      if (!validation.ok) {
        publishRecord({ ...baseWithSession, activity, refused: `payload validation failed: ${validation.problems.join("; ")}` })
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
        publishRecord({ ...baseWithSession, activity, refused: "this instance does not hold the publisher lease" })
        toast("Refused: another instance owns the card")
        return
      }

      let connection: DiscordIpc
      try {
        connection = await connectIpc()
      } catch (error) {
        publishRecord({ ...baseWithSession, activity, refused: `Discord connection failed: ${errorText(error)}` })
        toast("Discord is not reachable")
        return
      }

      // The only code allowed to enqueue SET_ACTIVITY: verified owner + fence
      // in the same IMMEDIATE transaction as the synchronous socket write.
      const critical = publisher.criticalEnqueue(() => connection.enqueueSetActivity(process.pid, activity as unknown as Record<string, unknown>))
      if (!critical.ok) {
        publishRecord({
          ...baseWithSession,
          activity,
          refused: `fenced enqueue rejected: ${critical.reason}${critical.error ? ` (${critical.error})` : ""}`,
          durationMs: Date.now() - started,
        })
        toast(`Refused: ${critical.reason}`)
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
        publishRecord({
          ...baseWithSession,
          at: enqueuedAt,
          fence: critical.fence,
          activity,
          nonce: request.nonce,
          cmd: reply.cmd ?? "SET_ACTIVITY",
          evt: reply.evt ?? undefined,
          rpcOk: ok,
          ...(ok ? {} : { rpcError: JSON.stringify(reply.data ?? null) }),
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
          rpcError: errorText(error),
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
            publishRecord({ ...attempt, fence: critical.fence, nonce: critical.value.nonce, cmd: reply.cmd, evt: reply.evt ?? undefined, rpcOk: reply.evt !== "ERROR" })
          } catch (error) {
            publishRecord({ ...attempt, fence: critical.fence, nonce: critical.value.nonce, rpcOk: false, rpcError: errorText(error) })
          }
        } else {
          publishRecord({ ...attempt, refused: `clear rejected: ${critical.reason}` })
        }
      } else {
        publishRecord({ ...attempt, refused: options.live ? "no ready socket or no lease; nothing to clear" : "live publication off; nothing to clear" })
      }
      closeIpc("disconnect command")
      if (publisher) {
        const released = publisher.release()
        publisherLog({
          kind: "release",
          atMs: Date.now(),
          instanceId: publisher.identity.instanceId,
          pid: process.pid,
          generation: publisher.identity.generation,
          fence: publisher.currentFence,
          detail: released ? "released by command" : "not owner at disconnect",
        })
      }
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
      log.append("capture.jsonl", { v: 1, seq: 0, atMs: Date.now(), source: "listen", type: "command.registration.failed", detail: errorText(error) })
    }

    const unsubscribe = context.data.listen(({ details }) => {
      const event = details as unknown as Record<string, unknown>
      try {
        const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>
        if (typeof data.sessionID === "string") lastSessionID = data.sessionID
        capture?.onListen(event)
      } catch (error) {
        capture?.notify("capture.listen.error", errorText(error))
      }
    })

    if (options.capture) {
      try {
        capture = startCapture(log, { salt, reference: options.captureReference, context, instanceId })
      } catch (error) {
        log.append("capture.jsonl", { v: 1, seq: 0, atMs: Date.now(), source: "listen", type: "capture.start.failed", detail: errorText(error) })
      }
    }

    try {
      await snapshot("startup-mid-task")
    } catch (error) {
      log.append("capture.jsonl", { v: 1, seq: 0, atMs: Date.now(), source: "listen", type: "snapshot.startup.failed", detail: errorText(error) })
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
            detail: "cleanup closes the socket and releases the lease without clearing the card",
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
