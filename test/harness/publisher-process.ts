/**
 * Real subprocess harness for publisher contention tests.
 *
 * Normal mode owns a coordination lease, one Discord IPC connection (fake
 * endpoint) and executes `publish` / `clear` actions from the parent. It never
 * ticks the publisher: recovery and takeover must come from the production
 * timer.
 *
 * M0_MODE=locker holds `BEGIN IMMEDIATE` on the coordination DB until the
 * parent creates the release file. It is a test process, not production code.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

import { loadSqliteBackend } from "../../src/m0/probe.js"
import { Publisher } from "../../src/m0/publisher.js"
import { DiscordIpc } from "../../src/discord/ipc.js"
import { buildActivity } from "../../src/discord/presence.js"

const env = process.env
const runtimeDir = env.M0_RUNTIME
const socketPath = env.M0_SOCKET
const eventsFile = env.M0_EVENTS
const actionFile = env.M0_ACTION
const mode = env.M0_MODE ?? "publisher"

if (!runtimeDir || !eventsFile) {
  console.error("harness: missing M0_RUNTIME/M0_EVENTS")
  process.exit(2)
}

function log(entry: Record<string, unknown>): void {
  try {
    appendFileSync(eventsFile!, JSON.stringify({ atMs: Date.now(), pid: process.pid, ...entry }) + "\n")
  } catch {
    // Parent may have removed the file at teardown.
  }
}

const { backend } = await loadSqliteBackend()
if (!backend) {
  log({ kind: "fatal", reason: "no sqlite backend" })
  process.exit(3)
}

if (mode === "locker") {
  const db = backend.open(`${runtimeDir}/publisher.sqlite`)
  try {
    db.exec("BEGIN IMMEDIATE")
    writeFileSync(env.M0_LOCKED_FILE ?? `${runtimeDir}/locked`, `${Date.now()}\n`)
    log({ kind: "locked" })
    const release = env.M0_RELEASE_FILE ?? `${runtimeDir}/release`
    while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 50))
    db.exec("COMMIT")
    log({ kind: "unlocked" })
  } finally {
    db.close()
  }
  process.exit(0)
}

if (!socketPath || !actionFile) {
  console.error("harness: missing M0_SOCKET/M0_ACTION")
  process.exit(2)
}

const activity = buildActivity({ providerID: "opencode-go", id: "deepseek-v4.1-flash" }, 1_750_000_000)

let ipc: DiscordIpc | null = null

const publisher = new Publisher({
  runtimeDir,
  backend,
  heartbeatMs: 2000,
  staleMs: 10_000,
  tickMs: 500,
  onEvent: (event) =>
    log({
      kind: "publisher",
      event: event.kind,
      fence: event.fence,
      previousFence: event.previousFence,
      reason: event.reason,
      code: event.code,
    }),
  onRevoked: (reason) => {
    log({ kind: "revoked", reason })
    if (ipc) {
      log({ kind: "revoked-destroy-socket" })
      ipc.destroy(`publisher lease revoked: ${reason}`)
      ipc = null
    }
  },
})

const acquisition = publisher.start()
log({
  kind: "start",
  status: acquisition.status,
  fence: "fence" in acquisition ? acquisition.fence : null,
  code: acquisition.status === "error" ? acquisition.code : null,
  instanceId: publisher.identity.instanceId,
  generation: publisher.identity.generation,
})

const connection = new DiscordIpc({
  path: socketPath,
  clientId: "1572459187873783838",
  connectTimeoutMs: 3000,
  responseTimeoutMs: 3000,
  onClose: (reason) => log({ kind: "socket-close", reason }),
})
try {
  await connection.connect()
  ipc = connection
  log({ kind: "connected" })
} catch (error) {
  log({ kind: "connect-failed", reason: error instanceof Error ? error.message : String(error) })
}

let executing = false
let lastAction = ""

async function runAction(action: string): Promise<void> {
  if (!action || action === "idle" || action === lastAction) return
  lastAction = action
  log({ kind: "action", action })
  const isClear = action === "clear"
  const critical = publisher.criticalEnqueue(() => {
    if (!ipc || !ipc.isReady) throw new Error("ipc-not-ready")
    return isClear ? ipc.enqueueClearActivity(process.pid) : ipc.enqueueSetActivity(process.pid, activity as unknown as Record<string, unknown>)
  })
  log({ kind: "critical-result", action, ok: critical.ok, reason: critical.ok ? null : critical.reason, fence: critical.ok ? critical.fence : publisher.currentFence })
  if (!critical.ok) return
  try {
    const reply = await critical.value.reply
    log({ kind: "rpc-reply", action, nonce: critical.value.nonce, evt: reply.evt ?? null, cmd: reply.cmd ?? null })
  } catch (error) {
    log({ kind: "rpc-failed", action, nonce: critical.value.nonce, reason: error instanceof Error ? error.message : String(error) })
  }
}

const actionTimer = setInterval(() => {
  if (executing) return
  executing = true
  try {
    let action = ""
    if (existsSync(actionFile)) action = readFileSync(actionFile, "utf8").trim()
    if (action && action !== lastAction) {
      writeFileSync(actionFile, "")
      void runAction(action).finally(() => {
        executing = false
      })
    } else {
      executing = false
    }
  } catch {
    executing = false
  }
}, 100)

async function shutdown(signal: string): Promise<void> {
  clearInterval(actionTimer)
  log({ kind: "shutdown", signal, fence: publisher.currentFence })
  ipc?.close()
  ipc = null
  publisher.stop()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

log({ kind: "ready" })
