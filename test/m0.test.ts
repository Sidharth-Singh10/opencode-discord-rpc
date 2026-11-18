import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { Context } from "@opencode/plugin/tui/plugin"

import { captureEvent } from "../src/m0/capture.js"
import { classifyLocality, loadPseudonymSalt, loadSqliteBackend, pseudonym, resetFrozenTimestamps, timestampForSession } from "../src/m0/probe.js"
import { Publisher } from "../src/m0/publisher.js"
import { buildActivity, validateActivity } from "../src/discord/presence.js"
import { DiscordIpc, FrameDecoder, OPCODE, encodeFrame } from "../src/discord/ipc.js"
import { FakeDiscord } from "./fake-discord.js"

const labRoot = "/tmp/opencode"
mkdirSync(labRoot, { recursive: true })

const tempDirs: string[] = []
const closers: Array<() => void | Promise<void>> = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(labRoot, `${prefix}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const close of closers.reverse()) {
    try {
      await close()
    } catch {
      // Best-effort cleanup.
    }
  }
  closers.length = 0
  for (const dir of tempDirs.reverse()) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
  resetFrozenTimestamps()
})

function fakeContext(info: () => Promise<{ version: string; pid: number; hostname?: string; urls: string[] }>): Context {
  return {
    app: { version: "2.3.0", channel: "test" },
    client: { server: { info } },
  } as unknown as Context
}

describe("presence payload", () => {
  test("is the single fixed M0 payload with native assets and integer seconds", () => {
    const activity = buildActivity({ providerID: "opencode-go", id: "deepseek-v4.1-flash" }, 1_750_000_000)
    expect(activity).toEqual({
      details: "M0 transmission test",
      state: "M0 · events observed",
      assets: {
        large_image: "state-working",
        large_text: "OpenCode — Working",
        small_image: "badge-model",
        small_text: "Model: opencode-go/deepseek-v4.1-flash",
      },
      timestamps: { start: 1_750_000_000 },
    })
    expect("largeImageKey" in activity).toBe(false)
    expect(validateActivity(activity)).toEqual({ ok: true, problems: [] })
  })

  test("validator catches fake timers and non-native image keys", () => {
    const broken = {
      details: "M0 transmission test",
      state: "M0 · events observed",
      assets: { large_image: "state-working", large_text: "OpenCode — Working", small_image: "badge-model", small_text: "deepseek" },
      timestamps: { start: 1_750_000_000.5 },
      largeImageKey: "state-working",
    }
    const result = validateActivity(broken)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("non-native image key")
    expect(result.problems.join("\n")).toContain("integer Unix second")
  })

  test("refuses a non-integer start", () => {
    expect(() => buildActivity({ providerID: "p", id: "m" }, 12.5)).toThrow(/integer Unix second/)
  })
})

describe("session timestamp provenance", () => {
  test("converts milliseconds to integer seconds and freezes per session", () => {
    expect(timestampForSession("ses_1", 1_750_000_000_123, "session.message.list[].type=user.time.created")).toEqual({
      seconds: 1_750_000_000,
      source: "session.message.list[].type=user.time.created",
      originalMs: 1_750_000_000_123,
    })
    const frozen = timestampForSession("ses_1", 1_760_000_000_000, "different.source")
    expect(frozen).toEqual({
      seconds: 1_750_000_000,
      source: "session.message.list[].type=user.time.created",
      originalMs: 1_750_000_000_123,
    })
  })

  test("never substitutes another clock when no user message exists", () => {
    const result = timestampForSession("ses_2", null, null)
    expect("error" in result).toBe(true)
  })

  test("rejects nonsensical and future timestamps", () => {
    expect("error" in timestampForSession("ses_3", Number.NaN, "x")).toBe(true)
    expect("error" in timestampForSession("ses_4", -1, "x")).toBe(true)
    expect("error" in timestampForSession("ses_5", Date.now() + 3_600_000, "x")).toBe(true)
  })
})

describe("pseudonym salt", () => {
  test("is stable across instances sharing a runtime directory and never in evidence", () => {
    const dir = tempDir("salt")
    const first = loadPseudonymSalt(dir)
    const second = loadPseudonymSalt(dir)
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(10)
    expect(pseudonym(first, "ses_same")).toBe(pseudonym(second, "ses_same"))
  })
})

describe("locality classification", () => {
  test("classifies loopback as local and allows enrichment", async () => {
    const result = await classifyLocality(
      fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: "localhost", urls: ["http://127.0.0.1:43173"] })),
    )
    expect(result.class).toBe("local")
    expect(result.enrichment).toBe("allowed")
  })

  test("classifies a foreign host as remote and refuses enrichment", async () => {
    const result = await classifyLocality(
      fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: "some-remote-host", urls: ["https://some-remote-host.example"] })),
    )
    expect(result.class).toBe("remote")
    expect(result.enrichment).toBe("refused")
  })

  test("unknown identity refuses enrichment", async () => {
    const result = await classifyLocality(
      fakeContext(async () => {
        throw new Error("server.info unavailable")
      }),
    )
    expect(result.class).toBe("unknown")
    expect(result.enrichment).toBe("refused")
  })
})

describe("capture allowlist", () => {
  const canaries = [
    "M0CANARY_PROMPT_aaaa",
    "M0CANARY_REASONING_bbbb",
    "M0CANARY_TOOL_cccc",
    "M0CANARY_RESULT_dddd",
    "M0CANARY_PERM_eeee",
    "M0CANARY_FORM_ffff",
    "M0CANARY_ERROR_gggg",
    "M0CANARY_PATH_hhhh",
    "M0CANARY_TITLE_iiii",
    "M0CANARY_META_jjjj",
    "M0CANARY_CRED_kkkk",
    "M0CANARY_URL_llll",
  ]

  const events: unknown[] = [
    {
      id: "evt_text",
      type: "session.text.delta",
      created: 1_750_000_000_000,
      location: { directory: "/home/levi/M0CANARY_PATH_hhhh" },
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", text: "M0CANARY_PROMPT_aaaa" },
    },
    {
      id: "evt_reasoning",
      type: "session.reasoning.delta",
      created: 1_750_000_000_000,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", text: "M0CANARY_REASONING_bbbb" },
    },
    {
      id: "evt_tool",
      type: "session.tool.failed",
      created: 1_750_000_000_000,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        id: "call_1",
        executed: true,
        input: { command: "echo M0CANARY_TOOL_cccc", url: "https://user:M0CANARY_URL_llll@example.test" },
        content: [{ type: "text", text: "M0CANARY_RESULT_dddd" }],
        error: { message: "M0CANARY_ERROR_gggg", kind: "unknown", data: { credential: "M0CANARY_CRED_kkkk" } },
        metadata: { title: "M0CANARY_TITLE_iiii", prompt: "M0CANARY_META_jjjj" },
      },
    },
    {
      id: "evt_perm",
      type: "permission.asked",
      created: 1_750_000_000_000,
      data: {
        id: "perm_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["/home/levi/M0CANARY_PERM_eeee"],
        message: "M0CANARY_PERM_eeee",
        metadata: { command: "M0CANARY_META_jjjj" },
      },
    },
    {
      id: "evt_form",
      type: "form.created",
      created: 1_750_000_000_000,
      data: {
        form: {
          id: "form_1",
          sessionID: "ses_1",
          title: "M0CANARY_FORM_ffff",
          metadata: { title: "M0CANARY_TITLE_iiii" },
          fields: [{ id: "field", title: "M0CANARY_FORM_ffff", value: "M0CANARY_META_jjjj" }],
        },
      },
    },
    {
      id: "evt_status",
      type: "session.status",
      created: 1_750_000_000_000,
      data: { sessionID: "ses_1", status: { type: "retry", attempt: 2, message: "M0CANARY_ERROR_gggg" } },
    },
    {
      id: "evt_interrupt",
      type: "session.execution.interrupted",
      created: 1_750_000_000_000,
      data: { sessionID: "ses_1", reason: "user" },
    },
  ]

  test("never serializes prompts, deltas, tool data, paths, forms, errors or credentials", () => {
    const serialized = events
      .map((event, index) => JSON.stringify(captureEvent(event, "listen", index, "salt")))
      .join("\n")
    for (const canary of canaries) expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain("M0CANARY")
    expect(serialized).not.toContain("/home/levi")
    expect(serialized).not.toContain("example.test")
  })

  test("keeps allowlisted status/outcome/attempt values and structural paths", () => {
    const status = captureEvent(events[5], "listen", 1, "salt")
    expect(status?.type).toBe("session.status")
    expect(status?.values).toEqual({ status: "retry", attempt: 2 })
    expect(status?.fields.some(([path]) => path === "data.status.type")).toBe(true)

    const interrupted = captureEvent(events[6], "listen", 2, "salt")
    expect(interrupted?.values).toEqual({ reason: "user" })

    const tool = captureEvent(events[2], "listen", 3, "salt")
    expect(tool?.values).toEqual({ executed: true })
    expect(tool?.fields.some(([path]) => path === "data.input")).toBe(true)
    expect(tool?.fields.some(([path]) => path.startsWith("data.input."))).toBe(false)
    expect(tool?.fields.some(([path]) => path.startsWith("data.error."))).toBe(false)
  })
})

describe("discord ipc framing", () => {
  test("decodes fragmented and coalesced frames", () => {
    const a = encodeFrame(OPCODE.FRAME, { cmd: "A" })
    const b = encodeFrame(OPCODE.PING, { n: 1 })
    const both = Buffer.concat([a, b])
    const decoder = new FrameDecoder()
    expect(decoder.push(both.subarray(0, 5))).toEqual([])
    expect(decoder.push(both.subarray(5, a.length + 2))).toEqual([{ opcode: OPCODE.FRAME, payload: { cmd: "A" } }])
    expect(decoder.push(both.subarray(a.length + 2))).toEqual([{ opcode: OPCODE.PING, payload: { n: 1 } }])
  })

  test("READY, nonce-correlated SET_ACTIVITY, PING/PONG and exact activity", async () => {
    const dir = tempDir("ipc")
    const path = join(dir, "discord-ipc-0")
    const fake = new FakeDiscord({ path, fragment: true, coalesce: true })
    await fake.start()
    closers.push(() => fake.stop())

    const ipc = new DiscordIpc({ path, clientId: "1572459187873783838", connectTimeoutMs: 3000, responseTimeoutMs: 3000 })
    closers.push(() => ipc.close())
    await ipc.connect()
    expect(ipc.isReady).toBe(true)

    const activity = buildActivity({ providerID: "opencode-go", id: "deepseek-v4.1-flash" }, 1_750_000_000)
    const request = ipc.enqueueSetActivity(process.pid, activity as unknown as Record<string, unknown>)
    const reply = await request.reply
    expect(reply.nonce).toBe(request.nonce)
    expect(reply.evt).toBeNull()

    const recorded = await fake.waitFor((frame) => {
      const payload = frame.payload as { cmd?: string } | null
      return frame.opcode === OPCODE.FRAME && payload?.cmd === "SET_ACTIVITY"
    })
    const payload = recorded.payload as { args: { pid: number; activity: unknown }; nonce: string }
    expect(payload.args.pid).toBe(process.pid)
    expect(payload.args.activity).toEqual(activity)
    expect(payload.nonce).toBe(request.nonce)
    const pong = fake.frames.find((frame) => frame.opcode === OPCODE.PONG)
    expect(pong).toBeDefined()
  })

  test("rejects a nonce-matched RPC error", async () => {
    const dir = tempDir("ipc-reject")
    const path = join(dir, "discord-ipc-0")
    const fake = new FakeDiscord({ path, reject: true })
    await fake.start()
    closers.push(() => fake.stop())
    const ipc = new DiscordIpc({ path, clientId: "1572459187873783838", connectTimeoutMs: 3000, responseTimeoutMs: 3000 })
    closers.push(() => ipc.close())
    await ipc.connect()
    const request = ipc.enqueueSetActivity(process.pid, { details: "x" })
    await expect(request.reply).rejects.toThrow(/fake RPC rejection/)
  })

  test("cleans up a dropped connection and refuses further enqueues", async () => {
    const dir = tempDir("ipc-drop")
    const path = join(dir, "discord-ipc-0")
    const fake = new FakeDiscord({ path, closeOnActivity: true })
    await fake.start()
    closers.push(() => fake.stop())
    const ipc = new DiscordIpc({ path, clientId: "1572459187873783838", connectTimeoutMs: 3000, responseTimeoutMs: 1500 })
    await ipc.connect()
    const request = ipc.enqueueSetActivity(process.pid, { details: "x" })
    await expect(request.reply).rejects.toThrow()
    expect(() => ipc.enqueueSetActivity(process.pid, { details: "y" })).toThrow()
    expect(ipc.pendingRpcCount).toBe(0)
  })

  test("times out when the endpoint never sends READY", async () => {
    const dir = tempDir("ipc-noready")
    const path = join(dir, "discord-ipc-0")
    const fake = new FakeDiscord({ path, noReady: true })
    await fake.start()
    closers.push(() => fake.stop())
    const ipc = new DiscordIpc({ path, clientId: "1572459187873783838", connectTimeoutMs: 250 })
    await expect(ipc.connect()).rejects.toThrow(/READY/)
  })
})

describe("publisher owner and fence", () => {
  test("exactly one owner, persistent increasing fence, revoked writer cannot clear", async () => {
    const { backend } = await loadSqliteBackend()
    expect(backend).not.toBeNull()
    if (!backend) return
    const dir = tempDir("pub")

    let revoked = 0
    const first = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000, onRevoked: () => (revoked += 1) })
    const second = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000, onRevoked: () => (revoked += 1) })
    closers.push(() => first.stop())
    closers.push(() => second.stop())

    const acquired = first.start()
    expect(acquired.status).toBe("acquired")
    if (acquired.status !== "acquired") return
    expect(acquired.fence).toBe(1)

    const contended = second.start()
    expect(contended.status).toBe("contended")
    expect(second.isOwner).toBe(false)

    const firstWrite = first.criticalEnqueue(() => "first")
    expect(firstWrite).toMatchObject({ ok: true, value: "first", fence: 1 })

    // A non-owner can never enqueue, even if it asks to clear.
    const stolen = second.criticalEnqueue(() => "stolen-clear")
    expect(stolen.ok).toBe(false)
    if (!stolen.ok) expect(stolen.reason).toBe("not-owner")
    expect(second.isRevoked).toBe(true)
    expect(revoked).toBe(1)

    expect(first.release()).toBe(true)
    const third = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => third.stop())
    const reacquired = third.start()
    expect(reacquired.status).toBe("acquired")
    if (reacquired.status !== "acquired") return
    expect(reacquired.fence).toBe(2)
    expect(reacquired.fence).toBeGreaterThan(acquired.fence)
    expect(second.criticalEnqueue(() => "still-stolen").ok).toBe(false)
  })

  test("explicit release pauses arbitration until resume", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-pause")
    const first = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => first.stop())
    expect(first.start().status).toBe("acquired")
    expect(first.release()).toBe(true)
    expect(first.isPaused).toBe(true)
    expect(first.tick()).toBeNull()
    expect(first.ownerSnapshot()).toBeNull()

    const resumed = first.resume()
    expect(resumed?.status).toBe("acquired")
    if (resumed?.status === "acquired") expect(resumed.fence).toBe(2)

    // Another live instance cannot slide into a paused owner's slot.
    expect(first.release()).toBe(true)
    expect(first.isPaused).toBe(true)
    const second = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => second.stop())
    const acquired = second.start()
    expect(acquired.status).toBe("acquired")
    if (acquired.status === "acquired") expect(acquired.fence).toBe(3)
    expect(first.resume()?.status).toBe("contended")
  })

  test("takes over only after the stale window and moves the fence forward", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-stale")
    let now = 1_000_000

    const owner = new Publisher({ runtimeDir: dir, backend, now: () => now, tickMs: 10_000_000, staleMs: 10_000, heartbeatMs: 2000 })
    closers.push(() => owner.stop())
    expect(owner.start().status).toBe("acquired")
    expect(owner.criticalEnqueue(() => "ok").ok).toBe(true)

    now += 9_000
    const early = new Publisher({ runtimeDir: dir, backend, now: () => now, tickMs: 10_000_000, staleMs: 10_000, heartbeatMs: 2000 })
    closers.push(() => early.stop())
    expect(early.start().status).toBe("contended")

    now += 2_000
    const late = new Publisher({ runtimeDir: dir, backend, now: () => now, tickMs: 10_000_000, staleMs: 10_000, heartbeatMs: 2000 })
    closers.push(() => late.stop())
    const takeover = late.start()
    expect(takeover.status).toBe("takeover")
    if (takeover.status !== "takeover") return
    expect(takeover.fence).toBeGreaterThan(1)
    expect(takeover.previous.fence).toBe(1)

    // The old owner is revoked and cannot clear the new owner's card.
    const oldWrite = owner.criticalEnqueue(() => "old-write")
    expect(oldWrite.ok).toBe(false)
    expect(owner.isRevoked).toBe(true)
    expect(late.isOwner).toBe(true)
    expect(late.ownerSnapshot()?.fence).toBe(takeover.fence)
  })
})
