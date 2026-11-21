import { createHash, randomUUID } from "node:crypto"
import { basename } from "node:path"
import type { SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/plugin"
import { DiscordIpc } from "../discord/ipc.js"
import { availableSockets } from "../discord/sockets.js"
import { Publisher } from "../m0/publisher.js"
import { inspectSession, loadSqliteBackend, type SessionInspection } from "../m0/probe.js"
import { buildPresenceActivity, type BuiltActivity, type PresenceMetrics } from "./activity.js"
import { reduceActivity, reconcileActivity, type ActivityState } from "./state.js"
import { resolvePresenceOptions } from "./config.js"

/**
 * Anchor namespace for local presence. Discord IPC is always local to this
 * machine, so a tunnel or LAN URL in the server's advertised URLs must not
 * disable presence. The raw hostname and PID never leave this process; only a
 * hash is persisted in the private runtime store.
 */
export async function presenceNamespace(context: Context): Promise<string> {
  let identity = "local"
  try {
    const info = await context.client.server.info()
    const host = typeof info?.hostname === "string" && info.hostname ? info.hostname : null
    const pid = typeof info?.pid === "number" ? info.pid : 0
    if (host) identity = `${host}\u0000${pid}`
  } catch {
    // Fall back to a machine-local namespace; presence never needs the DB.
  }
  return createHash("sha256").update("opencode-presence").update("\u0000").update(identity).digest("hex")
}

export function anchorKey(namespace: string, sessionID: string): string {
  return createHash("sha256").update(namespace).update("\u0000").update(sessionID).digest("hex")
}

/**
 * Pick the session to publish. A running session anywhere on the connected
 * server wins, which covers work started in another TUI on the same machine.
 * Otherwise the foreground session is shown; leaving to home with nothing
 * running clears the card.
 */
export function selectSession(context: Context): string | null {
  let routeSession: string | null = null
  try {
    const route = context.ui.router.current()
    if (route.type === "session") routeSession = route.sessionID
  } catch {
    // Router unavailable; fall back to session data.
  }
  const status = (id: string): "running" | "idle" => {
    try { return context.data.session.status(id) } catch { return "idle" }
  }
  if (routeSession && status(routeSession) === "running") return routeSession
  let sessions: Array<{ id: string; time: { updated: number; archived?: number } }> = []
  try { sessions = context.data.session.list() } catch { /* No session data. */ }
  const newest = sessions
    .filter((session) => !session.time.archived)
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, 50)
  const running = newest.find((session) => status(session.id) === "running")
  return running?.id ?? routeSession
}

/** Project basename only; the absolute directory never leaves the process. */
function projectName(context: Context, sessionID: string): string | null {
  try {
    const directory = context.data.session.get(sessionID)?.location?.directory
    return typeof directory === "string" && directory ? basename(directory) : null
  } catch {
    return null
  }
}

function sessionMetrics(
  context: Context,
  sessionID: string,
  executed: SessionMessageInfo | undefined,
  inspection: SessionInspection,
): PresenceMetrics {
  const cumulative = inspection.tokens
  const tokens = cumulative ? cumulative.input + cumulative.output : null
  const cost = inspection.sessionCost && inspection.sessionCost > 0
    ? inspection.sessionCost
    : inspection.reportedCost && inspection.reportedCost > 0
      ? inspection.reportedCost
      : null
  let contextPercent: number | null = null
  if (executed?.type === "assistant" && executed.tokens && executed.model) {
    const used = executed.tokens.input + executed.tokens.cache.read + executed.tokens.cache.write
    try {
      const directory = context.data.session.get(sessionID)?.location?.directory
      const location = typeof directory === "string" && directory ? { directory } : undefined
      const models = context.data.location.model.list(location) ?? context.data.location.model.list()
      const match = models?.find((model) =>
        model.providerID === executed.model.providerID &&
        (model.modelID === executed.model.id || model.id === executed.model.id))
      const limit = match?.limit?.context
      if (typeof limit === "number" && limit > 0) contextPercent = Math.min(100, Math.round((used / limit) * 100))
    } catch {
      // Context usage is optional; the rest of the card still publishes.
    }
  }
  return { tokens, cost, contextPercent }
}

/**
 * Rebuild a candidate payload with an explicit allowlist. Candidates are
 * written only by this plugin, but the store is still treated as input.
 */
export function parseCandidate(payload: string): BuiltActivity | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>
    const assets = value.assets as Record<string, unknown> | undefined
    const timestamps = value.timestamps as { start?: unknown } | undefined
    const details = value.details
    const state = value.state
    if (typeof details !== "string" || details.length === 0 || details.length > 128) return null
    if (typeof state !== "string" || state.length === 0 || state.length > 128) return null
    if (!assets || typeof assets.large_image !== "string" || assets.large_image.length === 0 || assets.large_image.length > 64) return null
    if (typeof assets.large_text !== "string" || assets.large_text.length > 128) return null
    if (assets.small_image !== undefined && (typeof assets.small_image !== "string" || assets.small_image.length > 64)) return null
    if (assets.small_text !== undefined && (typeof assets.small_text !== "string" || assets.small_text.length > 128)) return null
    const start = timestamps?.start
    if (!Number.isSafeInteger(start) || (start as number) < 1_000_000_000) return null
    return {
      details,
      state,
      assets: {
        large_image: assets.large_image,
        large_text: assets.large_text,
        ...(typeof assets.small_image === "string" ? { small_image: assets.small_image } : {}),
        ...(typeof assets.small_text === "string" ? { small_text: assets.small_text } : {}),
      },
      timestamps: { start: start as number },
    }
  } catch {
    return null
  }
}

/** Release path: no evidence capture, private metadata logs, or M0 model gate. */
export async function setupPresence(context: Context): Promise<() => Promise<void>> {
  const options = resolvePresenceOptions(context.options ?? {})
  const { enabled, runtimeDir, clientId } = options
  let disposed = false
  let paused = !enabled
  let generation = 0
  let ipc: DiscordIpc | null = null
  let publisher: Publisher | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let status = enabled ? "Disconnected" : "Paused"
  let nextAttemptAt = 0
  let failures = 0
  let lastPayload: string | null = null
  let polling = false
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let activeSessionID: string | null = null
  let activityState: ActivityState = { kind: "idle", at: 0 }
  let lastActivityMs = 0
  let eventRevision = 0
  let lastCard: { details: string; state: string } | null = null
  const namespace = enabled ? await presenceNamespace(context) : null
  const { backend } = enabled ? await loadSqliteBackend() : { backend: null }
  if (enabled) {
    try {
      // Populate the model catalog once so context limits are available.
      await context.data.location.model.sync(context.location)
    } catch {
      // Context percentage is optional; presence still publishes without it.
    }
  }

  const toast = (message: string) => {
    if (disposed) return
    try {
      context.ui.toast.show({ title: "Discord Presence", message })
    } catch {
      // An optional integration must not break the host UI.
    }
  }
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    const next = chain.then(fn).catch((error) => {
      if (process.env.OPENCODE_PRESENCE_DEBUG === "1") console.error("presence error:", error)
      if (disposed) return
      status = "Disconnected"
      failures = Math.min(failures + 1, 5)
      nextAttemptAt = Date.now() + Math.min(30_000, 1_000 * 2 ** failures)
      lastPayload = null
      ipc?.close()
      ipc = null
    })
    chain = next
    return next
  }
  for (const warning of options.warnings) toast(warning)
  const settle = async (promise: Promise<unknown>, timeoutMs = 1_000): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        promise.catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const clearOwned = async () => {
    const connection = ipc
    if (!connection?.isReady || !publisher?.isOwner) return
    const result = publisher.criticalEnqueue(() => connection.enqueueClearActivity(process.pid))
    if (result.ok) await settle(result.value.reply)
  }
  const createPublisher = (): Publisher | null => {
    if (!backend || !enabled) return null
    try {
      const instance = new Publisher({
        runtimeDir,
        backend,
        identity: { instanceId: randomUUID(), pid: process.pid, generation: randomUUID() },
        onRevoked: () => {
          ipc?.close()
          ipc = null
          status = "Standby"
        },
      })
      instance.start()
      return instance
    } catch {
      return null
    }
  }
  const replacePublisher = (): Publisher | null => {
    try { publisher?.removeCandidate() } catch { /* Store may already be gone. */ }
    publisher?.stop()
    publisher = createPublisher()
    return publisher
  }
  const ensurePublisher = (): Publisher | null => {
    if (!enabled || !backend) return null
    if (publisher && !publisher.isRevoked) return publisher
    return replacePublisher()
  }
  publisher = createPublisher()
  if (!publisher && enabled) status = "Coordination unavailable"

  const diagnostics = (): string => {
    let sockets = 0
    try { sockets = availableSockets().length } catch { /* Discovery is optional. */ }
    return [
      `Mode: ${options.automatic ? "automatic" : "manual"}${enabled ? "" : " (disabled)"}`,
      `Discord: ${ipc?.isReady ? "connected" : "disconnected"} · ${sockets} socket(s) found`,
      `Publisher: ${publisher ? (publisher.isOwner ? "owner" : "standby") : "unavailable"}`,
      `Session: ${activeSessionID ? "active" : "none"}`,
      `Model sharing: ${options.shareModel ? "reviewed labels only" : "off"}`,
      `Card: ${lastCard ? `${lastCard.details} — ${lastCard.state}` : "not published yet"}`,
      `Config warnings: ${options.warnings.length}`,
    ].join("\n")
  }
  const showDiagnostics = async (): Promise<void> => {
    const message = diagnostics()
    try {
      await context.ui.dialog.alert({ title: "Discord Presence", message })
    } catch {
      toast(message.replace(/\n/g, " · "))
    }
  }
  const publish = (): Promise<void> => {
    const revision = generation
    return serialize(async () => {
      const cancelled = () => disposed || paused || generation !== revision
      if (cancelled()) return
      const selected = selectSession(context)
      if (!selected) activeSessionID = null
      else if (activeSessionID !== selected) {
        activeSessionID = selected
        activityState = { kind: "idle", at: 0 }
        lastActivityMs = 0
        eventRevision += 1
      }
      const lease = ensurePublisher()
      if (!lease) { status = "Coordination unavailable"; return }
      const revisionAtRead = eventRevision

      // Advertise this instance's card. Even a standby instance contributes a
      // candidate; the fence owner publishes the best one.
      if (selected) {
        const key = namespace ? anchorKey(namespace, selected) : null
        if (!key) { status = "Local server identity unavailable"; return }
        const inspection = await inspectSession(context, selected, "release-no-evidence")
        if (cancelled() || revisionAtRead !== eventRevision || !inspection.found) return
        const anchors = lease.readAnchorState(key)
        const anchor = anchors.acknowledgedUnpersisted ?? anchors.committed ?? anchors.pending
        const seconds = anchor?.seconds ?? inspection.candidateTimestampSeconds
        const sourceCreatedMs = anchor?.sourceCreatedMs ?? inspection.latestUserMessageAtMs
        if (seconds === null || sourceCreatedMs === null) { status = "Session timestamp unavailable"; return }
        // Read only the newest executed model; never substitute the prompt
        // selection or an older supported assistant for an unknown execution.
        const messages = context.data.session.message.list(selected)
        const executed = [...messages].reverse().find((message) => message.type === "assistant")
        const activity = buildPresenceActivity({
          running: inspection.status === "running",
          startSeconds: seconds,
          model: executed?.type === "assistant" ? executed.model : null,
          agent: executed?.type === "assistant" ? executed.agent : null,
          project: projectName(context, selected),
          metrics: sessionMetrics(context, selected, executed, inspection),
          state: reconcileActivity(activityState, inspection.status === "running", Date.now()),
          shareModel: options.shareModel,
          shareAgent: options.shareAgent,
          shareProject: options.shareProject,
          shareMetrics: options.shareMetrics,
        })
        const updatedMs = context.data.session.get(selected)?.time?.updated
        lease.upsertCandidate({
          sessionKey: key,
          priority: inspection.status === "running" ? 1 : 0,
          updatedMs: Math.max(typeof updatedMs === "number" ? updatedMs : 0, lastActivityMs) || Date.now(),
          payload: JSON.stringify(activity),
          seconds,
          sourceCreatedMs,
        })
      } else {
        lease.removeCandidate()
      }
      if (cancelled()) return

      if (lease.isRevoked) { replacePublisher(); status = "Standby"; return }
      if (lease.isPaused) lease.resume()
      else if (!lease.isOwner) lease.tick()
      if (!lease.isOwner) { status = "Standby"; return }

      const best = lease.readCandidates()[0]
      if (!best) {
        await clearOwned()
        ipc?.close()
        ipc = null
        lastPayload = null
        lastCard = null
        lease.release()
        status = "No active session"
        return
      }
      const activity = parseCandidate(best.payload)
      if (!activity) { status = "Standby"; return }
      const anchors = lease.readAnchorState(best.sessionKey)
      const anchor = anchors.acknowledgedUnpersisted ?? anchors.committed ?? anchors.pending
      const seconds = anchor?.seconds ?? best.seconds
      const sourceCreatedMs = anchor?.sourceCreatedMs ?? best.sourceCreatedMs
      const payload = JSON.stringify(activity)
      if (ipc?.isReady && lastPayload === payload) return
      if (Date.now() < nextAttemptAt) return
      if (!ipc?.isReady) {
        ipc?.close()
        lastPayload = null
        for (const path of availableSockets().slice(0, 10)) {
          if (cancelled()) return
          const connection = new DiscordIpc({ path, clientId, connectTimeoutMs: 1_500 })
          ipc = connection
          try { await connection.connect(); break } catch {
            connection.close()
            if (ipc === connection) ipc = null
          }
        }
        if (!ipc?.isReady) {
          status = "Disconnected"
          failures = Math.min(failures + 1, 5)
          nextAttemptAt = Math.max(nextAttemptAt, Date.now() + Math.min(30_000, 1_000 * 2 ** failures))
          return
        }
      }
      if (cancelled()) return
      // Another instance may have advertised a newer card while the socket
      // connected. Only publish the candidate that is still the best.
      const current = lease.readCandidates()[0]
      if (!current || current.sessionKey !== best.sessionKey || current.payload !== best.payload) return
      const connection = ipc
      nextAttemptAt = Date.now() + 4_000
      const result = lease.criticalPublish(best.sessionKey, { seconds, sourceCreatedMs }, () =>
        connection!.enqueueSetActivity(process.pid, activity as unknown as Record<string, unknown>))
      if (!result.ok) { status = "Standby"; return }
      let reply: { evt?: string | null }
      try {
        reply = await result.value.reply
      } catch (error) {
        // A rejected RPC is a healthy connection with a refused update, not a
        // transport failure: keep the socket and report it precisely.
        if ((error as { code?: unknown })?.code === "ERPC") {
          status = "Discord rejected update"
          return
        }
        throw error
      }
      if (disposed) return
      if (reply.evt === "ERROR") { status = "Discord rejected update"; return }
      lease.markAcknowledged(best.sessionKey, seconds, sourceCreatedMs)
      failures = 0
      lastPayload = payload
      lastCard = { details: activity.details, state: activity.state }
      status = "Connected"
    })
  }
  const pause = (): Promise<void> => {
    paused = true
    generation += 1
    return serialize(async () => {
      if (disposed) return
      try {
        await clearOwned()
      } finally {
        ipc?.close()
        ipc = null
        publisher?.removeCandidate()
        publisher?.release()
        lastPayload = null
        lastCard = null
        nextAttemptAt = Math.max(nextAttemptAt, Date.now() + 1_500)
        status = "Paused"
      }
    })
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    generation += 1
    if (timer) clearInterval(timer)
    try { unsubscribe?.() } catch { /* Already unsubscribed. */ }
    const connection = ipc
    ipc = null
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      if (connection?.isReady && publisher?.isOwner) {
        const result = publisher.criticalEnqueue(() => connection.enqueueClearActivity(process.pid))
        if (result.ok) {
          await Promise.race([
            result.value.reply.catch(() => {}),
            new Promise<void>((resolve) => { timeout = setTimeout(resolve, 250) }),
          ])
        }
      }
    } catch {
      // Teardown is best-effort and must remain bounded.
    } finally {
      if (timeout) clearTimeout(timeout)
      connection?.close()
      try { publisher?.removeCandidate() } catch { /* Store may be gone. */ }
      publisher?.stop()
    }
  }
  try {
    context.keymap.layer(() => ({
      commands: [{
        id: "discord-presence",
        title: "Discord Presence",
        group: "presence",
        palette: true,
        bind: false,
        slash: { name: "presence", arguments: true },
        run: async (input?: string) => {
          const command = input?.trim() ?? "status"
          if (command === "publish") await publish()
          else if (command === "pause") await pause()
          else if (command === "resume" && enabled) { paused = false; generation += 1; await publish() }
          else if (command === "doctor") { await showDiagnostics(); return }
          else if (command !== "status") { toast("Usage: /presence status | doctor | publish | pause | resume"); return }
          toast(status)
        },
      }],
    }))
  } catch {
    await dispose()
    throw new Error("Discord presence command registration failed")
  }
  if (enabled && options.automatic !== false) {
    const tick = () => {
      if (disposed || paused || polling) return
      polling = true
      void publish().finally(() => { polling = false })
    }
    timer = setInterval(tick, 1_000)
    timer.unref()
    try {
      unsubscribe = context.data.listen(({ details }) => {
        if (disposed || paused) return
        try {
          const data = details.data as unknown as Record<string, unknown>
          const form = data?.form as Record<string, unknown> | undefined
          const sessionID = data?.sessionID ?? form?.sessionID
          if (typeof sessionID !== "string") return
          if (activeSessionID !== sessionID) {
            // A different session became active, possibly in another terminal.
            // Let the next publication re-elect and reset state.
            tick()
            return
          }
          lastActivityMs = Date.now()
          const next = reduceActivity(activityState, details.type, Date.now())
          if (next === activityState) return
          activityState = next
          eventRevision += 1
          tick()
        } catch {
          // Host data can disappear during reload/location changes.
        }
      })
    } catch {
      // Polling remains usable if event subscription is unavailable.
    }
    tick()
  }
  return dispose
}
