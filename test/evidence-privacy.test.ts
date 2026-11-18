import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { EvidenceLog } from "../src/m0/capture.js"
import { captureEvent, errorRecord } from "../src/m0/capture.js"
import {
  sanitizeAcquisition,
  sanitizeActivity,
  sanitizeAnchor,
  sanitizeInspection,
  sanitizeLocality,
  sanitizeModelProvenance,
  sanitizeProbe,
  sanitizePublication,
  sanitizePublisherEvent,
  sanitizeRun,
  sanitizeSnapshot,
  sanitizeTimestampProvenance,
} from "../src/m0/sanitize.js"
import { buildActivity } from "../src/discord/presence.js"

const SECRETS = [
  "/home/CRITIC_SECRET/file",
  "https://user:password@private.example/v1",
  "sk-live-CRITIC-SECRET",
  "CRITIC_STACK_TEXT",
  "PRIVATE_PATH_VALUE",
  "CREDENTIAL_CONTAINER_VALUE",
]

const dirs: string[] = []
const labRoot = "/tmp/opencode"

afterEach(() => {
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(labRoot, `${prefix}-`))
  dirs.push(dir)
  return dir
}

function assertClean(value: unknown, label: string): void {
  const serialized = JSON.stringify(value)
  for (const secret of SECRETS) expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain("M0CANARY")
  expect(serialized).not.toContain("CRITIC")
  expect(label.length).toBeGreaterThan(0)
}

const maliciousInspection = {
  observedAt: "2026-01-01T00:00:00.000Z",
  sessionIDHash: "0123456789abcdef",
  found: true,
  status: "running",
  sessionCost: Number.NaN,
  reportedCost: Number.POSITIVE_INFINITY,
  tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" } },
  selectedModel: { id: "https://user:password@private.example/v1", providerID: "/home/CRITIC_SECRET/file", variant: "CRITIC_STACK_TEXT" },
  executedModel: { id: "/home/CRITIC_SECRET/file", providerID: "https://user:password@private.example/v1" },
  agent: "CRITIC_STACK_TEXT\nat CRITIC_SECRET",
  messageCount: 2,
  latestUserMessageAtMs: 1_750_000_000_123,
  latestUserMessageSource: "session.message.list[].type=user.time.created",
  candidateTimestampSeconds: 1_750_000_000,
  candidateTimestampError: null,
  timestampOriginalUnits: "milliseconds since Unix epoch (converted with floor(ms/1000))",
  errorCodes: ["session-sync-failed", "/home/CRITIC_SECRET/file", "CRITIC_STACK_TEXT"],
  credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
}

const maliciousModel = {
  selected: maliciousInspection.selectedModel,
  executed: maliciousInspection.executedModel,
  agent: maliciousInspection.agent,
  sessionCost: Number.NaN,
  reportedCost: Number.POSITIVE_INFINITY,
  tokens: maliciousInspection.tokens,
  credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
}

describe("evidence projection", () => {
  test("model, provider, variant and tooltip refuse identifier-shaped secrets; agent refuses non-shape text", () => {
    for (const secret of SECRETS) {
      assertClean(sanitizeInspection({ ...maliciousInspection, selectedModel: { id: secret, providerID: "opencode" }, executedModel: { id: "deepseek-v4.1-flash-free", providerID: secret }, agent: secret }), "metadata")
      const activity = buildActivity({ id: secret, providerID: "opencode" }, 1_750_000_000)
      expect(sanitizeActivity(activity)).toBeNull()
    }
  })

  test("a lowercase secret-shaped agent is shape-admitted into private evidence", () => {
    // Documented boundary: the agent field is a user-defined host name, not a
    // reviewed vocabulary. This token is persisted to 0600 evidence; it is
    // never included in the Discord activity payload.
    const safe = sanitizeInspection({ ...maliciousInspection, agent: "sk_live_abc123" })
    expect((safe as Record<string, unknown>).agent).toBe("sk_live_abc123")
  })

  test("inspection drops credential URLs, private paths, stack text and unknown containers", () => {
    const safe = sanitizeInspection(maliciousInspection)
    expect(safe).not.toBeNull()
    assertClean(safe, "inspection")
    expect((safe as Record<string, unknown>).selectedModel).toBeNull()
    expect((safe as Record<string, unknown>).executedModel).toBeNull()
    expect((safe as Record<string, unknown>).agent).toBeNull()
    expect((safe as Record<string, unknown>).sessionCost).toBeNull()
    expect((safe as Record<string, unknown>).tokens).toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
  })

  test("probe/run drop malicious host metadata and unknown fields", () => {
    const probe = sanitizeProbe({
      observedAt: "2026-01-01T00:00:00.000Z",
      host: {
        version: "2.3.0 https://user:password@private.example/v1",
        channel: "/home/CRITIC_SECRET/file",
        kind: "bun",
        platform: "linux",
        arch: "x64",
        pid: 1,
        execPath: "/home/CRITIC_SECRET/file",
        credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
      },
      imports: {
        net: { ok: true, createConnection: true, code: "CRITIC_STACK_TEXT" },
        "bun:sqlite": { ok: true, selectOne: 1 },
        "node:sqlite": { ok: true, selectOne: 1 },
      },
      sqlite: { usable: true, kind: "bun:sqlite", selectOne: 1 },
      credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
    })
    expect(probe).toBeNull() // invalid version/channel deny the whole document
    const run = sanitizeRun({
      runId: "99999999-9999-4999-8999-999999999999",
      instanceId: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-01-01T00:00:00.000Z",
      host: { version: "2.3.0", channel: "latest", kind: "bun", platform: "linux", arch: "x64", pid: 1 },
      imports: { net: { ok: true, createConnection: true }, "bun:sqlite": { ok: true }, "node:sqlite": { ok: true } },
      sqlite: { usable: true, kind: "bun:sqlite" },
      locality: { class: "local", enrichment: "allowed", reason: "host-and-urls-match", serverFingerprint: "0123456789abcdef", evidence: { method: "server.info", hostnamePresent: true, hostnameMatches: true, urlCount: 1, allUrlsLoopback: true }, observedAt: "2026-01-01T00:00:00.000Z" },
      options: { capture: true, live: true, captureReference: true },
      discordSocket: "env",
      credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
      stack: "CRITIC_STACK_TEXT",
    })
    expect(run).not.toBeNull()
    assertClean(run, "run")
  })

  test("snapshot drops malicious selector, ownership, acquisition and anchor fields", () => {
    const snapshot = sanitizeSnapshot({
      v: 1,
      kind: "startup-mid-task",
      at: "2026-01-01T00:00:00.000Z",
      runId: "99999999-9999-4999-8999-999999999999",
      instanceId: "11111111-1111-4111-8111-111111111111",
      pid: 1,
      generation: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      selector: { reason: "route", sessionHash: "0123456789abcdef", sessionTitle: "CRITIC_STACK_TEXT" },
      inspection: maliciousInspection,
      anchor: { seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_000_123, committedMs: 1, secret: "CREDENTIAL_CONTAINER_VALUE" },
      ownership: {
        isOwner: true,
        fence: 3,
        revoked: false,
        ownerRow: { instanceId: "/home/CRITIC_SECRET/file", pid: 1, generation: "CRITIC_STACK_TEXT", fence: 3, acquiredMs: 1, heartbeatMs: 1, token: "sk-live-CRITIC-SECRET" },
      },
      acquisition: { status: "acquired", fence: 3, credentials: "CREDENTIAL_CONTAINER_VALUE" },
      locality: { class: "local", enrichment: "allowed", reason: "host-and-urls-match", serverFingerprint: "0123456789abcdef", evidence: { method: "server.info", hostnamePresent: true, hostnameMatches: true, urlCount: 1, allUrlsLoopback: true, urls: ["https://user:password@private.example/v1"] }, observedAt: "2026-01-01T00:00:00.000Z" },
      probe: {
        observedAt: "2026-01-01T00:00:00.000Z",
        host: { version: "2.3.0", channel: "latest", kind: "bun", platform: "linux", arch: "x64", pid: 1 },
        imports: { net: { ok: true, createConnection: true }, "bun:sqlite": { ok: true }, "node:sqlite": { ok: true } },
        sqlite: { usable: true, kind: "bun:sqlite" },
        credentials: "CREDENTIAL_CONTAINER_VALUE",
      },
      captureEnabled: true,
      live: true,
      credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
    })
    expect(snapshot).not.toBeNull()
    assertClean(snapshot, "snapshot")
    expect((snapshot as Record<string, unknown>).ownership).toBeNull()
  })

  test("publication drops malformed/private metadata and refusal text", () => {
    const activity = buildActivity({ providerID: "opencode", id: "deepseek-v4.1-flash-free" }, 1_750_000_000)
    const station = sanitizePublication({
      v: 1,
      at: "2026-01-01T00:00:00.000Z",
      instanceId: "11111111-1111-4111-8111-111111111111",
      pid: 1,
      attempt: "command-publish",
      phase: "acknowledged",
      live: true,
      sessionHash: "0123456789abcdef",
      selector: "route",
      fence: 3,
      nonce: "33333333-3333-4333-8333-333333333301",
      cmd: "SET_ACTIVITY",
      evt: null,
      activity,
      rpcOk: true,
      timestampProvenance: { seconds: 1_750_000_000, sourceField: "session.message.list[].type=user.time.created", originalValue: 1_750_000_000_123, originalUnits: "milliseconds since Unix epoch", conversion: "floor(ms/1000)", committed: true, anchorCommitted: true },
      modelProvenance: maliciousModel,
      refused: "https://user:password@private.example/v1 /home/CRITIC_SECRET/file CRITIC_STACK_TEXT",
      code: "CRITIC_STACK_TEXT",
      credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" },
    })
    expect(station).toBeNull() // invalid code + unknown keys reject the record

    const clean = sanitizePublication({
      v: 1,
      at: "2026-01-01T00:00:00.000Z",
      instanceId: "11111111-1111-4111-8111-111111111111",
      pid: 1,
      attempt: "command-publish",
      phase: "acknowledged",
      live: true,
      sessionHash: "0123456789abcdef",
      selector: "route",
      fence: 3,
      nonce: "33333333-3333-4333-8333-333333333301",
      cmd: "SET_ACTIVITY",
      evt: null,
      activity,
      rpcOk: true,
      timestampProvenance: { seconds: 1_750_000_000, sourceField: "session.message.list[].type=user.time.created", originalValue: 1_750_000_000_123, originalUnits: "milliseconds since Unix epoch", conversion: "floor(ms/1000)", committed: true, anchorCommitted: true },
      modelProvenance: maliciousModel,
    })
    expect(clean).not.toBeNull()
    assertClean(clean, "publication")
    expect((clean as Record<string, unknown>).modelProvenance).toEqual({
      selected: null,
      executed: null,
      agent: null,
      sessionCost: null,
      reportedCost: null,
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    })
  })

  test("publisher events and small projectors reject arbitrary strings", () => {
    expect(sanitizePublisherEvent({ v: 1, kind: "revoke", atMs: 1, instanceId: "11111111-1111-4111-8111-111111111111", pid: 1, generation: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", reason: "/home/CRITIC_SECRET/file" })).toEqual({
      v: 1,
      kind: "revoke",
      atMs: 1,
      instanceId: "11111111-1111-4111-8111-111111111111",
      pid: 1,
      generation: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    })
    expect(sanitizePublication({ v: 1, at: "2026-01-01T00:00:00.000Z", instanceId: "11111111-1111-4111-8111-111111111111", pid: 1, attempt: "command-publish", phase: "pre-enqueue", live: true, code: "identity-unknown", refused: "CRITIC_STACK_TEXT" })).toEqual({
      v: 1,
      at: "2026-01-01T00:00:00.000Z",
      instanceId: "11111111-1111-4111-8111-111111111111",
      pid: 1,
      attempt: "command-publish",
      phase: "pre-enqueue",
      live: true,
      code: "identity-unknown",
    })
    expect(sanitizeAnchor({ seconds: 1_750_000_000, sourceCreatedMs: 1_750_000_001_013, committedMs: 1 })).toBeNull()
    expect(sanitizeTimestampProvenance({ refusal: "CRITIC_STACK_TEXT" })).toBeNull()
    expect(sanitizeModelProvenance(maliciousModel)).not.toBeNull()
    expect(sanitizeAcquisition({ status: "acquired", fence: 1, code: "/home/CRITIC_SECRET/file" })).toEqual({ status: "acquired", fence: 1 })
    expect(sanitizeLocality({ class: "unknown", enrichment: "allowed", reason: "identity-incomplete", serverFingerprint: null, evidence: { method: "server.info", hostnamePresent: false, hostnameMatches: null, urlCount: 0, allUrlsLoopback: null }, observedAt: "2026-01-01T00:00:00.000Z" })).toBeNull()
  })

  test("capture/reference streams map unknown event types and do not traverse credentials", async () => {
    const event = {
      id: "evt_1",
      type: "/home/CRITIC_SECRET/file",
      created: 1_750_000_000_000,
      location: { directory: "/home/CRITIC_SECRET/file" },
      data: { sessionID: "ses_1", credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" }, message: "https://user:password@private.example/v1" },
    }
    const captured = captureEvent(event, "listen", 1, "salt", 1_750_000_000_000, "11111111-1111-4111-8111-111111111111")
    expect(captured?.type).toBe("event.other")
    assertClean(captured, "capture")
    const reference = captureEvent({ ...event, type: "session.text.delta" }, "subscribe", 2, "salt", 1_750_000_000_000, "11111111-1111-4111-8111-111111111111")
    assertClean(reference, "reference")

    const error = errorRecord("/home/CRITIC_SECRET/file", "capture-invalid", "11111111-1111-4111-8111-111111111111")
    expect(error.type).toBe("event.other")
    assertClean(error, "error")
  })

  test("the evidence sink cannot emit a sensitive document after projecting every source", async () => {
    const dir = tempDir("privacy-sink")
    const log = new EvidenceLog({ dir, runId: "run" })
    await log.init()
    log.append("capture.jsonl", captureEvent({ type: "/home/CRITIC_SECRET/file", data: { credentials: { secret: "CREDENTIAL_CONTAINER_VALUE" } } }, "listen", 1, "salt", 1, "11111111-1111-4111-8111-111111111111"))
    log.append("capture.jsonl", errorRecord("/home/CRITIC_SECRET/file", "capture-invalid", "11111111-1111-4111-8111-111111111111"))
    await log.writeJson("snapshot.json", sanitizeSnapshot({
      v: 1, kind: "manual-snapshot", at: "2026-01-01T00:00:00.000Z", runId: "99999999-9999-4999-8999-999999999999", instanceId: "11111111-1111-4111-8111-111111111111", pid: 1, generation: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      selector: null, inspection: maliciousInspection, anchor: null, ownership: null, acquisition: null,
      locality: { class: "local", enrichment: "allowed", reason: "host-and-urls-match", serverFingerprint: "0123456789abcdef", evidence: { method: "server.info", hostnamePresent: true, hostnameMatches: true, urlCount: 1, allUrlsLoopback: true }, observedAt: "2026-01-01T00:00:00.000Z" },
      probe: { observedAt: "2026-01-01T00:00:00.000Z", host: { version: "2.3.0", channel: "latest", kind: "bun", platform: "linux", arch: "x64", pid: 1 }, imports: { net: { ok: true, createConnection: true }, "bun:sqlite": { ok: true }, "node:sqlite": { ok: true } }, sqlite: { usable: true, kind: "bun:sqlite" } },
      captureEnabled: true, live: true,
    }))
    await log.close()
    for (const name of readdirSync(dir)) {
      const content = readFileSync(join(dir, name), "utf8")
      for (const secret of SECRETS) expect(content).not.toContain(secret)
    }
  })

  test("the last sink boundary rejects unchecked records and late writes", async () => {
    const dir = tempDir("privacy-last-boundary")
    const log = new EvidenceLog({ dir, runId: "run" })
    const clean = captureEvent({ type: "session.execution.started" }, "listen", 1, "salt")
    expect(clean).not.toBeNull()
    log.append("capture.jsonl", { ...clean, type: "/home/CRITIC_SECRET/file" })
    log.append("reference.jsonl", { ...clean, type: "/home/CRITIC_SECRET/file" })
    log.append("capture.jsonl", clean)
    await log.close()
    log.append("capture.jsonl", { ...clean, type: "/home/CRITIC_SECRET/file" })
    await log.writeJson("probe.json", { stack: "CRITIC_STACK_TEXT" })
    expect(readdirSync(dir)).toEqual(["capture.jsonl"])
    expect(readFileSync(join(dir, "capture.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
  })
})
