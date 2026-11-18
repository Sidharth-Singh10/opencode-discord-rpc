import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

import type { Context } from "@opencode/plugin/tui/plugin"

import { captureEvent, errorRecord, validateCaptureRecord } from "../src/m0/capture.js"
import { classifyLocality, loadPseudonymSalt, loadSqliteBackend, pseudonym, resolveSessionTimestamp, toUnixSeconds } from "../src/m0/probe.js"
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
})

function fakeContext(info: () => Promise<{ version: string; pid: number; hostname?: string; urls: unknown[] }>): Context {
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

describe("timestamp lifecycle helpers", () => {
  test("converts milliseconds to floor seconds", () => {
    expect(toUnixSeconds(1_750_000_000_123)).toEqual({ seconds: 1_750_000_000 })
  })

  test("reports explicit failure codes instead of fabricating a time", () => {
    expect(toUnixSeconds(null)).toEqual({ code: "timestamp-missing" })
    expect(toUnixSeconds(Number.NaN)).toEqual({ code: "timestamp-invalid" })
    expect(toUnixSeconds(-1)).toEqual({ code: "timestamp-invalid" })
    expect(toUnixSeconds(Date.now() + 3_600_000)).toEqual({ code: "timestamp-future" })
  })

  test("an existing anchor survives later user messages and reports committed", () => {
    const first = resolveSessionTimestamp(null, 1_750_000_000_123)
    expect(first).toEqual({ seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123, committed: false })
    const anchor = { seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123 }
    expect(resolveSessionTimestamp(anchor, 1_760_000_000_999)).toEqual({
      seconds: 1_750_000_000,
      sourceCreatedMs: 1_750_000_000_123,
      committed: true,
    })
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
  const localName = hostname()

  test("classifies a complete loopback identity as local", async () => {
    const result = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: localName, urls: ["http://127.0.0.1:43173"] })))
    expect(result.class).toBe("local")
    expect(result.enrichment).toBe("allowed")
    expect(result.serverFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(result)).not.toContain(localName)
    expect(JSON.stringify(result)).not.toContain("127.0.0.1")
  })

  test("classifies a foreign host as remote and refuses enrichment", async () => {
    const result = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: "some-remote-host", urls: ["https://some-remote-host.example"] })))
    expect(result.class).toBe("remote")
    expect(result.enrichment).toBe("refused")
    expect(result.reason).toBe("host-mismatch")
    expect(JSON.stringify(result)).not.toContain("some-remote-host")
  })

  test("the whole advertised URL array is validated without filtering", async () => {
    const cases: unknown[][] = [
      ["http://127.0.0.1:1", null],
      ["http://127.0.0.1:1", ""],
      ["http://127.0.0.1:1", "   "],
      ["http://127.0.0.1:1", 42],
      ["http://127.0.0.1:1", "not a url"],
      ["http://127.0.0.1:1", "http://10.0.0.2:1"],
      ["http://127.0.0.1:1", "ftp://127.0.0.1"],
      ["http://127.0.0.1:1", "http://user:password@127.0.0.1"],
      Object.assign(new Array(2), { 0: "http://127.0.0.1:1" }),
    ]
    for (const urls of cases) {
      const result = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: localName, urls })))
      expect(result.class).not.toBe("local")
      expect(result.enrichment).toBe("refused")
    }
  })

  test("valid IPv6 loopback is local and mixed loopback/non-loopback refuses", async () => {
    const ipv6 = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: localName, urls: ["http://[::1]:1234"] })))
    expect(ipv6.class).toBe("local")
    expect(ipv6.enrichment).toBe("allowed")
    const mixed = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: localName, urls: ["http://[::1]:1234", "http://10.0.0.2:1"] })))
    expect(mixed.class).not.toBe("local")
    expect(mixed.enrichment).toBe("refused")
  })

  test("absent or empty identity is unknown, never local", async () => {
    const missing = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, urls: ["http://127.0.0.1:43173"] })))
    const emptyURLs = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: localName, urls: [] })))
    const emptyBoth = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, urls: [] })))
    const malformed = await classifyLocality(fakeContext(async () => ({ version: "2.3.0", pid: 1, hostname: localName, urls: ["not a url"] })))
    for (const result of [missing, emptyURLs, emptyBoth, malformed]) {
      expect(result.class).toBe("unknown")
      expect(result.enrichment).toBe("refused")
      expect(result.serverFingerprint).toBeNull()
    }
  })

  test("an unavailable server.info is unknown and refuses enrichment", async () => {
    const result = await classifyLocality(fakeContext(async () => { throw new Error("secret url https://user:pass@example.test/private") }))
    expect(result.class).toBe("unknown")
    expect(result.enrichment).toBe("refused")
    expect(result.reason).toBe("server-info-unavailable")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(JSON.stringify(result)).not.toContain("example.test")
    expect(JSON.stringify(result)).not.toContain("private")
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
    "M0CANARY_UNHANDLED_SECRET",
  ]

  const events: unknown[] = [
    { id: "evt_text", type: "session.text.delta", created: 1_750_000_000_000, location: { directory: "/home/levi/M0CANARY_PATH_hhhh" }, data: { sessionID: "ses_1", assistantMessageID: "msg_1", text: "M0CANARY_PROMPT_aaaa" } },
    { id: "evt_reasoning", type: "session.reasoning.delta", created: 1_750_000_000_000, data: { sessionID: "ses_1", assistantMessageID: "msg_1", text: "M0CANARY_REASONING_bbbb" } },
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
    { id: "evt_perm", type: "permission.asked", created: 1_750_000_000_000, data: { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["/home/levi/M0CANARY_PERM_eeee"], message: "M0CANARY_PERM_eeee", metadata: { command: "M0CANARY_META_jjjj" } } },
    { id: "evt_form", type: "form.created", created: 1_750_000_000_000, data: { form: { id: "form_1", sessionID: "ses_1", title: "M0CANARY_FORM_ffff", metadata: { title: "M0CANARY_TITLE_iiii" }, fields: [{ id: "field", title: "M0CANARY_FORM_ffff", value: "M0CANARY_META_jjjj" }] } } },
    { id: "evt_status", type: "session.status", created: 1_750_000_000_000, data: { sessionID: "ses_1", status: { type: "retry", attempt: 2, message: "M0CANARY_ERROR_gggg" } } },
    { id: "evt_interrupt", type: "session.execution.interrupted", created: 1_750_000_000_000, data: { sessionID: "ses_1", reason: "user" } },
    { id: "evt_unknown", type: "session.unknown.event", created: 1_750_000_000_000, data: { sessionID: "ses_1", credentials: { M0CANARY_UNHANDLED_SECRET: "M0CANARY_UNHANDLED_SECRET" }, nested: { arbitrary: "M0CANARY_UNHANDLED_SECRET" } } },
  ]

  test("never serializes prompts, deltas, tool data, paths, forms, errors or credentials", () => {
    const serialized = events.map((event, index) => JSON.stringify(captureEvent(event, "listen", index, "salt", Date.now(), "11111111-1111-4111-8111-111111111111"))).join("\n")
    for (const canary of canaries) expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain("M0CANARY")
    expect(serialized).not.toContain("/home/levi")
    expect(serialized).not.toContain("example.test")
  })

  test("unhandled data keys are not traversed at all", () => {
    const captured = captureEvent(events[7], "listen", 1, "salt", Date.now(), "11111111-1111-4111-8111-111111111111")
    expect(captured).not.toBeNull()
    expect(captured?.fields.some(([path]) => path.includes("credentials"))).toBe(false)
    expect(captured?.fields.some(([path]) => path.includes("nested"))).toBe(false)
    expect(JSON.stringify(captured)).not.toContain("M0CANARY")
  })

  test("keeps allowlisted values and fixed structural paths", () => {
    const status = captureEvent(events[5], "listen", 1, "salt", Date.now(), "11111111-1111-4111-8111-111111111111")
    expect(status?.values).toEqual({ status: "retry", attempt: 2 })
    expect(status?.fields.some(([path]) => path === "data.status.type")).toBe(true)
    const interrupted = captureEvent(events[6], "listen", 2, "salt", Date.now(), "11111111-1111-4111-8111-111111111111")
    expect(interrupted?.values).toEqual({ reason: "user" })
    const tool = captureEvent(events[2], "listen", 3, "salt", Date.now(), "11111111-1111-4111-8111-111111111111")
    expect(tool?.values).toEqual({ executed: true })
    expect(tool?.fields.some(([path]) => path === "data.sessionID")).toBe(true)
    expect(tool?.fields.some(([path]) => path.startsWith("data.input"))).toBe(false)
    expect(tool?.fields.some(([path]) => path.startsWith("data.error"))).toBe(false)
    expect(validateCaptureRecord(status)).toBe(true)
  })

  test("runtime validation rejects extra keys and out-of-schema values", () => {
    const base = captureEvent(events[5], "listen", 1, "salt", Date.now(), "11111111-1111-4111-8111-111111111111")
    expect(base).not.toBeNull()
    expect(validateCaptureRecord({ ...base, injected: "x" })).toBe(false)
    expect(validateCaptureRecord({ ...base, values: { arbitrary: "M0CANARY" } })).toBe(false)
    expect(validateCaptureRecord({ ...base, fields: [["data.credentials", "object"]] })).toBe(false)
  })

  test("error records carry a fixed code and no exception text", () => {
    const record = errorRecord("observer.error", "capture-listen-failed", "11111111-1111-4111-8111-111111111111", "subscribe")
    expect(record).toEqual({ v: 1, seq: 0, atMs: record.atMs, source: "subscribe", instanceId: "11111111-1111-4111-8111-111111111111", type: "observer.error", code: "capture-listen-failed" })
    expect(JSON.stringify(record)).not.toContain("https://")
    expect(validateCaptureRecord(record)).toBe(true)
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

  test("close during the handshake settles the pending connect", async () => {
    const dir = tempDir("ipc-close-handshake")
    const path = join(dir, "discord-ipc-0")
    const fake = new FakeDiscord({ path, noReady: true })
    await fake.start()
    closers.push(() => fake.stop())
    const ipc = new DiscordIpc({ path, clientId: "1572459187873783838", connectTimeoutMs: 1000 })
    closers.push(() => ipc.close())
    const started = Date.now()
    const connecting = ipc.connect()
    setTimeout(() => ipc.close(), 30)
    await expect(connecting).rejects.toThrow(/closed|READY/)
    expect(Date.now() - started).toBeLessThan(300)
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

  test("recovers automatically from a startup schema lock without an auxiliary tick", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-startup-lock")
    const raw = backend.open(join(dir, "publisher.sqlite"))
    raw.exec("BEGIN IMMEDIATE")
    const publisher = new Publisher({ runtimeDir: dir, backend, tickMs: 100, heartbeatMs: 200, staleMs: 1000 })
    closers.push(() => publisher.stop())

    const first = publisher.start()
    expect(first.status).toBe("error")

    raw.exec("COMMIT")
    raw.close()

    // No publisher.tick() here: the production timer must recover.
    const deadline = Date.now() + 4000
    while (!publisher.isOwner && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(publisher.isOwner).toBe(true)
    expect(publisher.currentFence).toBeGreaterThan(0)
  })

  test("commits an anchor once and preserves it across a second instance", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-anchor")
    const key = "a".repeat(64)
    const first = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => first.stop())
    expect(first.start().status).toBe("acquired")
    expect(first.readAnchor(key)).toBeNull()
    expect(first.markAcknowledged(key, 1_750_000_000, 1_750_000_000_123).ok).toBe(true)
    expect(first.readAnchor(key)).toEqual({ seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123, committedMs: expect.any(Number) })

    // A later conflicting commit must not move the first acknowledged anchor.
    expect(first.markAcknowledged(key, 1_760_000_000, 1_760_000_000_000).ok).toBe(false)
    expect(first.readAnchor(key)?.seconds).toBe(1_750_000_000)

    const second = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => second.stop())
    const acquired = second.start()
    expect(acquired.status).toBe("contended")
    expect(second.readAnchor(key)?.seconds).toBe(1_750_000_000)
    expect(second.markAcknowledged("not-a-key", 1_750_000_000, 1_750_000_000_123).ok).toBe(false)
  })

  test("failed attempt does not commit; a later success freezes the latest message and survives reload/takeover", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-anchor-lifecycle")
    const key = "b".repeat(64)
    const first = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => first.stop())
    expect(first.start().status).toBe("acquired")

    // Attempt 1 fails before acknowledgement: nothing is committed.
    const attempt1 = resolveSessionTimestamp(first.readAnchor(key), 1_750_000_000_100)
    expect(attempt1).toEqual({ seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_100, committed: false })
    expect(first.readAnchor(key)).toBeNull()

    // A later user message moves the candidate until the first success commits.
    const attempt2 = resolveSessionTimestamp(first.readAnchor(key), 1_750_000_010_900)
    expect(attempt2).toEqual({ seconds: 1_750_000_010, sourceCreatedMs: 1_750_000_010_900, committed: false })
    expect(first.markAcknowledged(key, 1_750_000_010, 1_750_000_010_900).ok).toBe(true)

    // Later messages do not move a committed anchor.
    const later = resolveSessionTimestamp(first.readAnchor(key), 1_750_000_999_000)
    expect(later).toEqual({ seconds: 1_750_000_010, sourceCreatedMs: 1_750_000_010_900, committed: true })

    // A reload/new generation and a taking-over instance read the same anchor.
    const reloaded = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => reloaded.stop())
    expect(reloaded.start().status).toBe("contended")
    expect(resolveSessionTimestamp(reloaded.readAnchor(key), 1_760_000_000_000)).toEqual({
      seconds: 1_750_000_010,
      sourceCreatedMs: 1_750_000_010_900,
      committed: true,
    })
  })

  test("reserves anchor intent in the transaction and never writes on conflict", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-intent")
    const key = "c".repeat(64)
    const publisher = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => publisher.stop())
    expect(publisher.start().status).toBe("acquired")

    let writes = 0
    const first = publisher.criticalPublish(key, { seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123 }, () => {
      writes += 1
      return "first"
    })
    expect(first.ok).toBe(true)
    expect(writes).toBe(1)
    expect(publisher.readAnchorState(key).pending?.seconds).toBe(1_750_000_000)

    const conflict = publisher.criticalPublish(key, { seconds: 1_750_000_010, sourceCreatedMs: 1_750_000_010_123 }, () => {
      writes += 1
      return "second"
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.reason).toBe("anchor-pending")
    expect(writes).toBe(1)

    expect(publisher.markAcknowledged(key, 1_750_000_000, 1_750_000_000_123).ok).toBe(true)
    expect(publisher.readAnchorState(key)).toMatchObject({ committed: { seconds: 1_750_000_000 }, pending: null })
  })

  test("an acknowledged anchor survives a persistence lock and is retried by the timer", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-ack-lock")
    const key = "d".repeat(64)
    const publisher = new Publisher({ runtimeDir: dir, backend, tickMs: 100, heartbeatMs: 200, staleMs: 1000 })
    closers.push(() => publisher.stop())
    expect(publisher.start().status).toBe("acquired")

    const raw = backend.open(join(dir, "publisher.sqlite"))
    raw.exec("BEGIN IMMEDIATE")
    const failed = publisher.markAcknowledged(key, 1_750_000_000, 1_750_000_000_123)
    expect(failed.ok).toBe(false)
    expect(publisher.readAnchorState(key).acknowledgedUnpersisted).toEqual({ seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123 })
    raw.exec("COMMIT")
    raw.close()

    const deadline = Date.now() + 4000
    while (!publisher.readAnchor(key) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(publisher.readAnchor(key)?.seconds).toBe(1_750_000_000)
    expect(publisher.readAnchorState(key).acknowledgedUnpersisted).toBeNull()
  })

  test("a conflicting stored anchor is never overwritten", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) return
    const dir = tempDir("pub-conflict")
    const key = "e".repeat(64)
    const publisher = new Publisher({ runtimeDir: dir, backend, tickMs: 10_000_000 })
    closers.push(() => publisher.stop())
    expect(publisher.start().status).toBe("acquired")
    expect(publisher.markAcknowledged(key, 1_750_000_000, 1_750_000_000_123).ok).toBe(true)
    expect(publisher.markAcknowledged(key, 1_760_000_000, 1_760_000_000_123).ok).toBe(false)
    expect(publisher.readAnchor(key)?.seconds).toBe(1_750_000_000)
  })

  test("an ACK conflict stays unresolved and blocks a newer anchor", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) throw new Error("SQLite unavailable")
    const publisher = new Publisher({ runtimeDir: tempDir("pub-conflict-ack"), backend })
    closers.push(() => publisher.stop())
    publisher.start()
    const key = "f".repeat(64)
    expect(publisher.markAcknowledged(key, 1_750_000_010, 1_750_000_010_123).ok).toBe(true)
    expect(publisher.markAcknowledged(key, 1_750_000_000, 1_750_000_000_123)).toEqual({ ok: false, code: "anchor-conflict" })
    expect(publisher.readAnchorState(key).acknowledgedUnpersisted?.seconds).toBe(1_750_000_000)
    let writes = 0
    expect(publisher.criticalPublish(key, { seconds: 1_750_000_010, sourceCreatedMs: 1_750_000_010_123 }, () => ++writes).ok).toBe(false)
    expect(writes).toBe(0)
  })

  test("intent is durable before enqueue and a later transaction failure retains RPC correlation", async () => {
    const { backend } = await loadSqliteBackend()
    if (!backend) throw new Error("SQLite unavailable")
    let failCommit = false
    const publisher = new Publisher({
      runtimeDir: tempDir("pub-durable-before-send"),
      backend: {
        kind: backend.kind,
        open(path) {
          const db = backend.open(path)
          return {
            ...db,
            exec(sql) {
              if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("synthetic commit I/O failure") }
              db.exec(sql)
            },
          }
        },
      },
    })
    closers.push(() => publisher.stop())
    publisher.start()
    const key = "9".repeat(64)
    const observer = backend.open(publisher.dbPath)
    closers.push(() => observer.close())
    const result = publisher.criticalPublish(key, { seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123 }, () => {
      expect(observer.get<{ seconds: number }>("SELECT seconds FROM anchor_pending")?.seconds).toBe(1_750_000_000)
      failCommit = true
      return { nonce: "retained-request" }
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.nonce).toBe("retained-request")
    expect(publisher.readAnchorState(key).pending?.seconds).toBe(1_750_000_000)
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
