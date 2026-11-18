/**
 * Synthetic host boundary for the immutable installed ./tui export.
 * No imports of production internals and no hooks in the shipped bundle.
 */
import { createRequire } from "node:module"
import { hostname } from "node:os"
import { join } from "node:path"

const [installation, runtimeDir, evidenceDir, identity = "local"] = process.argv.slice(2)
if (!installation || !runtimeDir || !evidenceDir) throw new Error("installation runtime evidence required")
const require = createRequire(join(installation, "package.json"))
const plugin = (await import(require.resolve("opencode-presence-discord/tui"))).default
const initial = JSON.parse(process.env.PACKED_HOST_METADATA ?? "{}")
let state: any = { session: "ses_packed", created: 1_750_000_000_123, status: "running", ...initial.state }
let listener: ((event: any) => void) | null = null
let toasts = 0
let referencePush: ((event: unknown) => void) | null = null
const referenceQueue: unknown[] = []
const context: any = {
  options: { m0: { capture: true, captureReference: true, live: true, runtimeDir, evidenceDir } },
  app: { version: "2.3.0", channel: "latest", ...initial.app },
  client: {
    server: { info: async () => identity === "local"
      ? { hostname: hostname(), urls: ["http://127.0.0.1:43199"] }
      : { urls: ["http://127.0.0.1:43199"] } },
    event: { async *subscribe({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => referencePush?.(null), { once: true })
      while (!signal.aborted) {
        const event = referenceQueue.length ? referenceQueue.shift() : await new Promise((resolve) => { referencePush = resolve })
        referencePush = null
        if (event) yield event
      }
    } },
  },
  data: {
    listen(fn: (event: any) => void) { listener = fn; return () => { listener = null } },
    session: {
      list: () => [{ id: state.session, time: { updated: state.created } }],
      get: () => ({
        id: state.session, cost: state.cost ?? 0, tokens: state.tokens,
        agent: state.agent ?? "build",
        model: state.sessionModel ?? { id: "deepseek-v4.1-flash-free", providerID: "opencode" },
      }),
      sync: async () => {},
      status: () => state.status,
      cost: () => state.cost ?? 0,
      message: {
        list: () => state.empty ? [] : state.messages ?? [
          { type: "user", time: { created: state.created } },
          { type: "assistant", model: state.executed ?? { id: "deepseek-v4.1-flash-free", providerID: "opencode" }, agent: state.messageAgent ?? "build" },
        ],
        sync: async () => { if (state.syncDelay) await Bun.sleep(state.syncDelay) },
      },
    },
  },
  ui: {
    router: { current: () => state.home ? { type: "home" } : { type: "session", sessionID: state.session } },
    model: { current: () => state.selected ?? { modelID: "deepseek-v4.1-flash-free", providerID: "opencode" } },
    toast: { show: () => { toasts++ } },
  },
  keymap: { layer: (fn: () => any) => { commands = fn().commands } },
}
let commands: any[] = []
const dispose = await plugin.setup(context)
const send = (record: unknown) => console.log(JSON.stringify(record))
send({ ready: true, pid: process.pid })

async function handle(input: any): Promise<void> {
  try {
    if (input.action === "set") {
      state = { ...state, ...input.value }
      if (input.app) Object.assign(context.app, input.app)
    } else if (input.action === "event") {
      listener?.({ details: input.value })
      if (referencePush) referencePush(input.value)
      else referenceQueue.push(input.value)
    } else if (input.action === "dispose") await dispose()
    else if (input.action !== "stats") {
      const command = commands.find((command) => command.id === `presence-m0-${input.action}`)
      if (!command) throw new Error("unknown host command")
      await command.run()
    }
    send({ id: input.id, ok: true, toasts })
  } catch {
    send({ id: input.id, ok: false, toasts })
  }
}
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let end
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line) void handle(JSON.parse(line))
  }
}
await dispose()
