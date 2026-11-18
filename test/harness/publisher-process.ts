/**
 * Real subprocess harness for publisher contention tests.
 *
 * It owns a coordination lease, one Discord IPC connection (fake endpoint)
 * and executes actions written by the parent test:
 *   publish | clear | hold
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"

import { loadSqliteBackend } from "../../src/m0/probe.js"
import { Publisher } from "../../src/m0/publisher.js"
import { DiscordIpc } from "../../src/discord/ipc.js"
import { buildActivity } from "../../src/discord/presence.js"

const env = process.env
const runtimeDir = env.M0_RUNTIME
const socketPath = env.M0_SOCKET
const eventsFile = env.M0_EVENTS
const actionFile = env.M0_ACTION
const criticalFile = env.M0_CRITICAL_FILE

if (!runtimeDir || !socketPath || !eventsFile || !actionFile) {
  console.error("harness: missing M0_RUNTIME/M0_SOCKET/M0_EVENTS/M0_ACTION")
  process.exit(2)
}

function log(entry: Record<string, unknown>): void {
  try {
    appendFileSync(eventsFile!, JSON.stringify({ atMs: Date.now(), pid: process.pid, ...entry }) + "\n")
  } catch {
    // Parent may have removed the file at teardown.
  }
}

const activity = buildActivity({ providerID: "opencode-go", id: "deepseek-v4.1-flash" }, 1_750_000_000)

const { backend } = await loadSqliteBackend()
if (!backend) {
  log({ kind: "fatal", reason: "no sqlite backend" })
  process.exit(3)
}

let ipc: DiscordIpc | null = null
const holdCriticalMs = Number(env.M0_HOLD_CRITICAL_MS ?? "0")

const publisher = new Publisher({
  runtimeDir,
  backend,
  heartbeatMs: 2000,
  staleMs: 10_000,
  tickMs: 500,
  ...(holdCriticalMs > 0 ? { holdCriticalMs } : {}),
  onEvent: (event) => log({ kind: "publisher", event: event.kind, fence: event.fence, previousFence: event.previousFence, reason: event.reason }),
  onRevoked: (reason) => {
    log({ kind: "revoked", reason })
    if (ipc) {
      log({ kind: "revoked-destroy-socket" })
      ipc.destroy(`publisher lease revoked: ${reason}`)
      ipc = null
    }
  },
  onCriticalEnter: () => {
    if (criticalFile) writeFileSync(criticalFile, `${Date.now()}\n`)
  },
})

const acquisition = publisher.start()
log({
  kind: "start",
  status: acquisition.status,
  fence: "fence" in acquisition ? acquisition.fence : null,
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

// Faster than the production 2 s tick so tests observe takeover promptly.
const ticker = setInterval(() => {
  const result = publisher.tick()
  if (result && (result.status === "takeover" || result.status === "acquired" || result.status === "revoked")) {
    log({ kind: "tick", status: result.status, fence: "fence" in result ? result.fence : null })
  }
}, 500)

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
  clearInterval(ticker)
  clearInterval(actionTimer)
  log({ kind: "shutdown", signal, fence: publisher.currentFence })
  ipc?.close()
  ipc = null
  publisher.stop()
  try {
    rmSync(criticalFile ?? "", { force: true })
  } catch {
    // Ignore.
  }
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

log({ kind: "ready" })
