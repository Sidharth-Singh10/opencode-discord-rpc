import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/tui/plugin"
import { anchorKey, parseCandidate, presenceNamespace, setupPresence } from "../src/core/presence.js"
import { FakeDiscord } from "./fake-discord.js"

const cleanups: Array<() => void | Promise<void>> = []
const originalSocket = process.env.DISCORD_IPC_PATH

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (originalSocket === undefined) delete process.env.DISCORD_IPC_PATH
  else process.env.DISCORD_IPC_PATH = originalSocket
})

async function host(
  options: Record<string, unknown> = {},
  discordOptions: Record<string, unknown> = {},
  shared: { fake?: FakeDiscord; runtimeDir?: string; sessionID?: string } = {},
) {
  const directory = mkdtempSync("/tmp/opencode/presence-")
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const fake = shared.fake ?? new FakeDiscord({ path: join(directory, "discord.sock"), ...discordOptions })
  if (!shared.fake) {
    await fake.start()
    cleanups.push(() => fake.stop())
  }
  process.env.DISCORD_IPC_PATH = fake.path
  const runtimeDir = shared.runtimeDir ?? join(directory, "runtime")
  const sessionID = shared.sessionID ?? "session"
  let run: (input: string) => Promise<void> = async () => {}
  let listener: ((event: unknown) => void) | null = null
  const state = {
    home: false,
    status: "running",
    model: { id: "gpt-6.1-sol", providerID: "openai" },
    agent: "PRIVATE_AGENT",
    created: 1_790_000_000_123,
    messages: null as null | Array<unknown>,
    sessions: null as null | Array<{ id: string; updated: number; status?: string }>,
    urls: ["http://127.0.0.1:43199"],
    directory: "/home/levi/project",
    tokens: null as null | { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
    cost: 0,
    assistantTokens: null as null | { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
    models: [] as Array<{ id: string; modelID: string; providerID: string; limit: { context: number } }>,
  }
  const toasts: string[] = []
  const context = {
    options: { runtimeDir, automatic: false, ...options },
    client: { server: { info: async () => ({ hostname: hostname(), pid: process.pid, urls: state.urls }) } },
    data: {
      listen: (fn: (event: unknown) => void) => { listener = fn; return () => { listener = null } },
      session: {
      list: () => (state.sessions ?? []).map((session) => ({ id: session.id, time: { updated: session.updated } })),
      get: (id?: string) => ({ id: id ?? sessionID, cost: state.cost, tokens: state.tokens ?? undefined, location: { directory: state.directory } }),
      sync: async () => {},
      status: (id?: string) => state.sessions?.find((session) => session.id === id)?.status ?? state.status,
      cost: () => state.cost,
      message: {
        list: () => state.messages ?? [
          { type: "user", time: { created: state.created }, content: "PRIVATE_PROMPT" },
          { type: "assistant", model: state.model, agent: state.agent, tokens: state.assistantTokens ?? undefined, text: "PRIVATE_ANSWER" },
        ],
        sync: async () => {},
      },
    },
    location: { model: { list: () => state.models } } },
    ui: {
      router: { current: () => state.home ? { type: "home" } : { type: "session", sessionID } },
      model: { current: () => ({ modelID: "PRIVATE_SELECTED", providerID: "PRIVATE_PROVIDER" }) },
      toast: { show: ({ message }: { message: string }) => toasts.push(message) },
    },
    keymap: { layer: (factory: () => { commands: Array<{ run: typeof run }> }) => { run = factory().commands[0]!.run } },
  } as unknown as Context
  const dispose = await setupPresence(context)
  cleanups.push(dispose)
  return { fake, state, runtimeDir, run: (input: string) => run(input), dispose, toasts,
    emit: (type: string, id = sessionID) => listener?.({ details: { type, data: { sessionID: id } } }),
  }
}

function activity(fake: FakeDiscord, index = 0) {
  return (fake.activityFrames()[index]!.payload as { args: { activity?: Record<string, unknown> } }).args.activity
}

describe("presence anchor namespace", () => {
  const context = (info: () => Promise<unknown>) => ({ client: { server: { info } } }) as unknown as Context

  test("hashes server identity and ignores advertised tunnel or LAN URLs", async () => {
    const loopback = await presenceNamespace(context(async () => ({ hostname: "paradis", pid: 42, urls: ["http://127.0.0.1:1"] })))
    const tunnel = await presenceNamespace(context(async () => ({ hostname: "paradis", pid: 42, urls: ["https://abc.opentunnel.xyz"] })))
    expect(tunnel).toBe(loopback)
    expect(loopback).toMatch(/^[0-9a-f]{64}$/)
    expect(await presenceNamespace(context(async () => ({ hostname: "other", pid: 42 })))).not.toBe(loopback)
    expect(await presenceNamespace(context(async () => ({ hostname: "paradis", pid: 43 })))).not.toBe(loopback)
  })

  test("falls back to a machine-local namespace when server info is unavailable", async () => {
    const fallback = await presenceNamespace(context(async () => { throw new Error("unavailable") }))
    expect(fallback).toMatch(/^[0-9a-f]{64}$/)
    expect(anchorKey(fallback, "ses_one")).not.toBe(anchorKey(fallback, "ses_two"))
  })
})

describe("candidate payload parsing", () => {
  const valid = {
    details: "Working on demo",
    state: "GPT-6.1 Sol · Working",
    assets: { large_image: "state-working", large_text: "OpenCode", small_image: "badge-model", small_text: "Model: GPT-6.1 Sol" },
    timestamps: { start: 1_790_000_000 },
    extra: "PRIVATE",
  }

  test("rebuilds only known fields and drops unknown data", () => {
    const parsed = parseCandidate(JSON.stringify(valid))
    expect(parsed).toEqual({
      details: valid.details,
      state: valid.state,
      assets: valid.assets,
      timestamps: valid.timestamps,
    })
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE")
  })

  test("rejects malformed, oversized or implausible payloads", () => {
    for (const payload of [
      "",
      "not json",
      "{}",
      JSON.stringify({ ...valid, details: "x".repeat(129) }),
      JSON.stringify({ ...valid, state: 1 }),
      JSON.stringify({ ...valid, assets: { large_image: "x", large_text: 1 } }),
      JSON.stringify({ ...valid, timestamps: { start: 1 } }),
    ]) {
      expect(parseCandidate(payload)).toBeNull()
    }
  })
})

describe("release presence publication", () => {
  test("publishes GPT without exposing model or private metadata by default", async () => {
    const h = await host()
    await h.run("publish")
    expect(activity(h.fake)?.details).toBe("Using OpenCode")
    expect(activity(h.fake)?.state).toBe("Working")
    expect(JSON.stringify(h.fake.frames)).not.toContain("PRIVATE")
    expect(JSON.stringify(h.fake.frames)).not.toContain("gpt")
    expect(h.toasts).toContain("Connected")
  })

  test("enriched fields compose project, model, agent and metrics", async () => {
    const h = await host({ shareModel: true, shareAgent: true, shareProject: true, shareMetrics: true })
    h.state.directory = "/home/levi/opencode-discord-rpc"
    h.state.agent = "build"
    h.state.cost = 0.42
    h.state.tokens = { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } }
    h.state.assistantTokens = { input: 40_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
    h.state.models = [{ id: "gpt-6.1-sol", modelID: "gpt-6.1-sol", providerID: "openai", limit: { context: 100_000 } }]
    await h.run("publish")
    const card = activity(h.fake)
    expect(card?.details).toBe("Working on opencode-discord-rpc")
    expect(card?.state).toBe("GPT-6.1 Sol · build · Working · 40% ctx · 1.5K tok · $0.42")
    expect(JSON.stringify(h.fake.frames)).not.toContain("/home/levi/opencode-discord-rpc")
  })

  test("unknown providers and agents do not block generic publication", async () => {
    const h = await host({ shareModel: true })
    h.state.model = { id: "sk_private", providerID: "custom/private" }
    await h.run("publish")
    expect(activity(h.fake)?.assets).toEqual({ large_image: "state-working", large_text: "OpenCode" })
    expect(JSON.stringify(h.fake.frames)).not.toContain("private")
    expect(h.fake.connections).toBe(1)
  })

  test("shares only the newest reviewed execution, never a selected or older model", async () => {
    const h = await host({ shareModel: true })
    h.state.messages = [
      { type: "user", time: { created: h.state.created } },
      { type: "assistant", model: { id: "gpt-6.1-sol", providerID: "openai" } },
      { type: "assistant", model: { id: "PRIVATE_MODEL", providerID: "custom" } },
    ]
    await h.run("publish")
    expect(activity(h.fake)?.assets).not.toHaveProperty("small_text")
  })

  test("an opted-in GPT label is canonical and the timestamp stays stable", async () => {
    const h = await host({ shareModel: true })
    await h.run("publish")
    h.state.created += 100_000
    h.state.status = "idle"
    await Bun.sleep(4_050)
    await h.run("publish")
    expect(activity(h.fake)?.assets).toHaveProperty("small_text", "Model: GPT-6.1 Sol")
    expect(activity(h.fake, 1)?.state).toBe("GPT-6.1 Sol · Idle")
    expect(activity(h.fake, 1)?.timestamps).toEqual(activity(h.fake)?.timestamps)
  })

  test("disabled mode and a home route never open a socket", async () => {
    const disabled = await host({ enabled: false })
    await disabled.run("publish")
    await disabled.run("resume")
    expect(disabled.fake.connections).toBe(0)
    const h = await host()
    h.state.home = true
    await h.run("publish")
    expect(h.fake.connections).toBe(0)
  })

  test("pause clears presence and blocks updates until resume", async () => {
    const h = await host()
    await h.run("publish")
    await h.run("pause")
    await h.run("publish")
    expect(h.fake.activityFrames()).toHaveLength(2)
    expect(activity(h.fake, 1)).toBeUndefined()
    expect(h.toasts.at(-1)).toBe("Paused")
  })

  test("disposal during the handshake prevents publication", async () => {
    const h = await host({}, { handshakeDelayMs: 100 })
    const publishing = h.run("publish")
    await Bun.sleep(15)
    await h.dispose()
    await publishing
    expect(h.fake.activityFrames()).toHaveLength(0)
  })

  test("automatic mode publishes without a command and deduplicates unchanged activity", async () => {
    const h = await host({ automatic: true })
    await h.fake.waitFor((frame) => (frame.payload as { cmd?: string })?.cmd === "SET_ACTIVITY")
    await Bun.sleep(4_100)
    expect(h.fake.activityFrames()).toHaveLength(1)
    expect(h.fake.activityFrames()[0]?.payload).toHaveProperty("args.activity.details", "Using OpenCode")
  }, 10_000)

  test("automatic events show thinking without exposing event content", async () => {
    const h = await host({ automatic: true })
    await h.fake.waitFor((frame) => (frame.payload as { cmd?: string })?.cmd === "SET_ACTIVITY")
    h.emit("session.reasoning.delta")
    await h.fake.waitFor((frame) =>
      (frame.payload as { args?: { activity?: { state?: string } } })?.args?.activity?.state === "Thinking", 6_000)
    expect(JSON.stringify(h.fake.activityFrames())).not.toContain("PRIVATE")
  }, 10_000)

  test("leaving a session clears its card and releases ownership", async () => {
    const h = await host()
    await h.run("publish")
    h.state.home = true
    await h.run("publish")
    expect(h.fake.activityFrames()).toHaveLength(2)
    expect(h.fake.activityFrames()[1]?.payload).not.toHaveProperty("args.activity")
    expect(h.toasts.at(-1)).toBe("No active session")
  })

  test("a running session from another terminal wins while this one is at home", async () => {
    const h = await host()
    h.state.home = true
    h.state.sessions = [{ id: "other-terminal", updated: Date.now(), status: "running" }]
    await h.run("publish")
    expect(activity(h.fake)?.details).toBe("Using OpenCode")
    expect(activity(h.fake)?.state).toBe("Working")
    expect(JSON.stringify(h.fake.frames)).not.toContain("other-terminal")
  })

  test("an idle foreground session is preferred over an idle background session", async () => {
    const h = await host()
    h.state.status = "idle"
    h.state.sessions = [{ id: "other-terminal", updated: Date.now(), status: "idle" }]
    await h.run("publish")
    expect(activity(h.fake)?.state).toBe("Idle")
  })

  test("a Discord rejection is reported without crashing", async () => {
    const h = await host({}, { reject: true })
    await h.run("publish")
    await h.run("status")
    expect(h.toasts.at(-1)).toBe("Discord rejected update")
  })

  test("socket loss backs off, then reconnects on the next attempt", async () => {
    const h = await host({}, { closeOnActivity: true })
    await h.run("publish")
    await h.run("status")
    expect(h.toasts.at(-1)).toBe("Disconnected")
    await Bun.sleep(2_200)
    await h.run("publish")
    expect(h.fake.connections).toBeGreaterThanOrEqual(2)
  }, 10_000)

  test("a tunnel URL does not disable local presence", async () => {
    const h = await host()
    h.state.urls = ["http://127.0.0.1:43199", "https://abc.opentunnel.xyz"]
    await h.run("publish")
    expect(activity(h.fake)?.details).toBe("Using OpenCode")
    expect(h.fake.connections).toBe(1)
  })

  test("newest unknown execution never borrows an older model label", async () => {
    const h = await host({ shareModel: true })
    h.state.messages = [
      { type: "user", time: { created: h.state.created } },
      { type: "assistant", model: { id: "gpt-6.1-sol", providerID: "openai" }, agent: "build" },
      { type: "assistant", model: { id: "PRIVATE", providerID: "PRIVATE" }, agent: "PRIVATE" },
    ]
    await h.run("publish")
    expect(h.fake.activityFrames()[0]?.payload).not.toHaveProperty("args.activity.assets.small_text")
    expect(JSON.stringify(h.fake.frames)).not.toContain("PRIVATE")
  })

  test("the owner publishes a running card from another workspace", async () => {
    const sharedRoot = mkdtempSync("/tmp/opencode/presence-shared-")
    cleanups.push(() => rmSync(sharedRoot, { recursive: true, force: true }))
    const runtimeDir = join(sharedRoot, "runtime")
    const a = await host({ shareProject: true, shareModel: true }, {}, { runtimeDir })
    a.state.status = "idle"
    a.state.directory = "/home/levi/project-a"
    await a.run("publish")
    expect(activity(a.fake)?.details).toBe("Working on project-a")

    const b = await host({ shareProject: true, shareModel: true }, {}, { fake: a.fake, runtimeDir, sessionID: "session-b" })
    b.state.status = "running"
    b.state.directory = "/home/levi/project-b"
    await b.run("publish")

    // Presence updates are throttled to one attempt per four seconds.
    await Bun.sleep(4_100)
    await a.run("publish")
    await a.fake.waitFor((frame) =>
      (frame.payload as { args?: { activity?: { details?: string } } })?.args?.activity?.details === "Working on project-b", 6_000)
    expect(a.fake.activityFrames().at(-1)?.payload).toHaveProperty("args.activity.details", "Working on project-b")
    expect(a.fake.activityFrames().at(-1)?.payload).toHaveProperty("args.activity.state", "GPT-6.1 Sol · Working")

    await b.dispose()
    await Bun.sleep(4_100)
    await a.run("publish")
    await a.fake.waitFor((frame) =>
      (frame.payload as { args?: { activity?: { details?: string } } })?.args?.activity?.details === "Working on project-a", 6_000)
  }, 25_000)

  test("a publisher that loses ownership recreates itself and recovers", async () => {
    const h = await host({ automatic: true })
    await h.fake.waitFor((frame) => (frame.payload as { cmd?: string })?.cmd === "SET_ACTIVITY")
    const db = new Database(join(h.runtimeDir, "publisher.sqlite"))
    try {
      const owner = db.query("SELECT fence FROM owner").get() as { fence: number }
      db.run(
        "UPDATE owner SET instance_id = 'other', generation = 'other', fence = ?, heartbeat_ms = ? WHERE singleton = 1",
        [owner.fence + 1, Date.now()],
      )
      await Bun.sleep(2_500)
      expect((db.query("SELECT instance_id FROM owner").get() as { instance_id: string }).instance_id).toBe("other")
      const before = h.fake.activityFrames().length
      db.run("DELETE FROM owner")
      const deadline = Date.now() + 8_000
      while (h.fake.activityFrames().length <= before && Date.now() < deadline) await Bun.sleep(50)
      expect(h.fake.activityFrames().length).toBeGreaterThan(before)
      expect(h.fake.connections).toBeGreaterThanOrEqual(2)
    } finally {
      db.close()
    }
  }, 15_000)
})
