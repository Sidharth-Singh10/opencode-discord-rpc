/**
 * Synthetic host boundary for the packed release-mode `./tui` export.
 * Imports only the installed package; no production internals, no hooks.
 */
import { createRequire } from "node:module"
import { hostname } from "node:os"
import { join } from "node:path"

const [installation, runtimeDir] = process.argv.slice(2)
if (!installation || !runtimeDir) throw new Error("installation and runtime directory required")
const require = createRequire(join(installation, "package.json"))
const plugin = (await import(require.resolve("opencode-presence-discord/tui"))).default

const toasts: string[] = []
interface Runner { run?: (input?: string) => Promise<void> }
const host = {} as Runner
let listener: ((event: unknown) => void) | null = null
const state = { home: false, status: "running", created: 1_790_000_000_123 }
const context: any = {
  options: { enabled: true, automatic: false, shareModel: true, runtimeDir },
  app: { version: "2.3.0", channel: "latest" },
  client: { server: { info: async () => ({ hostname: hostname(), pid: process.pid, urls: ["http://127.0.0.1:43199", "https://abc.opentunnel.xyz"] }) } },
  data: {
    listen(fn: (event: unknown) => void) { listener = fn; return () => { listener = null } },
    session: {
      list: () => [],
      get: () => ({ id: "ses_release", cost: 0 }),
      sync: async () => {},
      status: () => state.status,
      cost: () => 0,
      message: {
        list: () => [
          { type: "user", time: { created: state.created }, content: "PRIVATE_PROMPT" },
          { type: "assistant", model: { id: "gpt-6.1-sol", providerID: "openai" }, agent: "PRIVATE_AGENT", text: "PRIVATE_ANSWER" },
        ],
        sync: async () => {},
      },
    },
  },
  ui: {
    router: { current: () => state.home ? { type: "home" } : { type: "session", sessionID: "ses_release" } },
    model: { current: () => ({ modelID: "PRIVATE_SELECTED", providerID: "PRIVATE_PROVIDER" }) },
    toast: { show: ({ message }: { message: string }) => toasts.push(message) },
    dialog: { alert: async ({ message }: { message: string }) => { toasts.push(message) } },
  },
  keymap: { layer: (factory: () => any) => { host.run = factory().commands[0].run } },
}

const dispose = await plugin.setup(context)
const send = (record: unknown) => console.log(JSON.stringify(record))
send({ ready: true, pid: process.pid })

let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let end
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line) continue
    const input = JSON.parse(line)
    try {
      if (input.action === "publish") await host.run?.("publish")
      else if (input.action === "doctor") await host.run?.("doctor")
      else if (input.action === "event") (listener as ((event: unknown) => void) | null)?.({ details: input.value })
      else if (input.action === "dispose") await dispose()
      send({ id: input.id, ok: true, toasts })
    } catch {
      send({ id: input.id, ok: false, toasts })
    }
  }
}
await dispose()
