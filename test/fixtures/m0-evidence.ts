/**
 * Complete positive M0 evidence fixture used by validator tests. It mirrors
 * the shipped document shapes without copying lab data or canary values.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { buildActivity } from "../../src/discord/presence.js"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const SESSION = "aaaaaaaaaaaaaaaa"
const INSTANCE_A = A
const INSTANCE_B = B
const SESSION_KEY_HASH = SESSION

const baseMs = 1_750_000_000_000
const seconds = Math.floor(baseMs / 1000)
const createdMs = seconds * 1000 + 123
const at = (offset: number): string => new Date(baseMs + offset).toISOString()

const hash = (n: number): string => n.toString(16).padStart(16, "0")
const id = (n: number): string => `${n}`.padStart(16, "0")

const host = {
  version: "2.3.0",
  channel: "latest",
  kind: "bun",
  bun: "1.4.4",
  node: "26.3.0",
  platform: "linux",
  arch: "x64",
  pid: 4000,
}
const imports = {
  net: { ok: true, createConnection: true },
  "bun:sqlite": { ok: true, selectOne: 1 },
  "node:sqlite": { ok: true, selectOne: 1 },
}
const sqlite = { usable: true, kind: "bun:sqlite", selectOne: 1 }
const locality = {
  class: "local",
  enrichment: "allowed",
  reason: "host-and-urls-match",
  serverFingerprint: "0123456789abcdef",
  evidence: { method: "server.info", hostnamePresent: true, hostnameMatches: true, urlCount: 1, allUrlsLoopback: true },
  observedAt: at(0),
}
const probe = { observedAt: at(0), host, imports, sqlite }

interface CaptureSeed {
  type: string
  instance: string
  fields: Array<[string, string]>
  values?: Record<string, string | number | boolean>
}

const seeds: CaptureSeed[] = [
  { type: "session.execution.started", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.started", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.started", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.started", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.started", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.started", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.started", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.succeeded", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.succeeded", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.succeeded", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.failed", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.failed", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"]] },
  { type: "session.execution.interrupted", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.reason", "string"]], values: { reason: "user" } },
  { type: "session.execution.interrupted", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.reason", "string"]], values: { reason: "user" } },
  { type: "permission.asked", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.id", "string"], ["data.sessionID", "string"], ["data.action", "string"]] },
  { type: "permission.replied", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.requestID", "string"], ["data.reply.type", "string"]], values: { reply: "once" } },
  { type: "session.compaction.started", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.reason", "string"]], values: { reason: "manual" } },
  { type: "session.compaction.ended", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.reason", "string"]], values: { reason: "manual" } },
  { type: "session.tool.called", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.executed", "boolean"]], values: { executed: true } },
  { type: "session.tool.success", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.executed", "boolean"]], values: { executed: true } },
  { type: "form.created", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.form.id", "string"], ["data.form.sessionID", "string"]] },
  { type: "form.cancelled", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.id", "string"], ["data.sessionID", "string"]] },
  { type: "location.shutdown", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"]] },
  { type: "session.model.selected", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["created", "number"], ["data", "object"], ["data.sessionID", "string"], ["data.model.providerID", "string"], ["data.model.id", "string"]], values: { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" } },
  { type: "server.connected", instance: INSTANCE_A, fields: [["id", "string"], ["type", "string"], ["data", "object"]] },
  { type: "server.connected", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["data", "object"]] },
  { type: "server.connected", instance: INSTANCE_B, fields: [["id", "string"], ["type", "string"], ["data", "object"]] },
]

function captureRecords(): { capture: Array<Record<string, unknown>>; reference: Array<Record<string, unknown>> } {
  const capture: Array<Record<string, unknown>> = []
  const reference: Array<Record<string, unknown>> = []
  seeds.forEach((seed, index) => {
    const eventIDHash = hash(index + 1)
    const eventCreatedMs = baseMs + index * 10
    const record = {
      v: 1,
      seq: index + 1,
      atMs: eventCreatedMs,
      source: "listen",
      instanceId: seed.instance,
      type: seed.type,
      eventIDHash,
      sessionHash: seed.type === "server.connected" ? null : SESSION,
      locationHash: null,
      eventCreatedMs,
      fields: seed.fields,
      values: seed.values ?? {},
    }
    capture.push(record)
    reference.push({
      v: 1,
      seq: index + 1,
      atMs: eventCreatedMs,
      source: "subscribe",
      type: seed.type,
      eventIDHash,
      sessionHash: seed.type === "server.connected" ? null : SESSION,
      locationHash: null,
      instanceId: seed.instance,
      eventCreatedMs,
    })
  })
  reference.push({ v: 1, seq: 999, atMs: baseMs + 500, source: "subscribe", instanceId: INSTANCE_A, type: "observer.error", code: "capture-listen-failed" })
  return { capture, reference }
}

function inspection(instance: string, status: "idle" | "running"): Record<string, unknown> {
  return {
    observedAt: at(0),
    sessionIDHash: SESSION,
    found: true,
    status,
    sessionCost: 0,
    reportedCost: 0,
    tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    selectedModel: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    executedModel: { providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "default" },
    agent: "build",
    messageCount: 4,
    latestUserMessageAtMs: createdMs,
    latestUserMessageSource: "session.message.list[].type=user.time.created",
    candidateTimestampSeconds: seconds,
    candidateTimestampError: null,
    timestampOriginalUnits: "milliseconds since Unix epoch (converted with floor(ms/1000))",
    errorCodes: [],
  }
}

function publisherEvents(): Array<Record<string, unknown>> {
  const make = (kind: string, instanceId: string, offset: number, extra: Record<string, unknown>): Record<string, unknown> => ({
    v: 1,
    kind,
    atMs: baseMs + offset,
    instanceId,
    pid: instanceId === A ? 4001 : 4002,
    generation: instanceId === A ? "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" : "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    ...extra,
  })
  return [
    make("acquire", A, 0, { fence: 1 }),
    make("release", A, 1000, { fence: 1 }),
    make("acquire", B, 2000, { fence: 2 }),
    make("release", B, 3000, { fence: 2 }),
    make("acquire", A, 4000, { fence: 3 }),
    make("renew", A, 5000, { fence: 3 }),
    make("takeover", B, 10000, { fence: 4, previousFence: 3 }),
    make("revoke", A, 10001, { fence: 3, reason: "fence-changed" }),
    make("release", B, 16000, { fence: 4 }),
    make("acquire", B, 17000, { fence: 5 }),
    make("release", B, 22000, { fence: 5 }),
  ]
}

function publicationRecords(): Array<Record<string, unknown>> {
  const activity = buildActivity({ providerID: "opencode", id: "deepseek-v4.1-flash-free" }, seconds)
  const modelProvenance = {
    selected: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    executed: { providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "default" },
    agent: "build",
    sessionCost: 0,
    reportedCost: 0,
    tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const provenance = (committed: boolean, anchorCommitted: boolean) => ({
    seconds,
    sourceField: "session.message.list[].type=user.time.created",
    originalValue: createdMs,
    originalUnits: "milliseconds since Unix epoch",
    conversion: "floor(ms/1000)",
    committed,
    anchorCommitted,
  })
  const success = (instanceId: string, offset: number, fence: number, nonce: string, committed: boolean) => ({
    v: 1,
    at: at(offset),
    instanceId,
    pid: instanceId === A ? 4001 : 4002,
    attempt: "command-publish",
    live: true,
    sessionHash: SESSION,
    selector: instanceId === A ? "route" : "event",
    fence,
    nonce,
    cmd: "SET_ACTIVITY",
    evt: null,
    activity,
    rpcOk: true,
    durationMs: 5,
    timestampProvenance: provenance(committed, true),
    modelProvenance,
  })
  return [
    { v: 1, at: at(3900), instanceId: A, pid: 4001, attempt: "ready", live: true, ready: true },
    success(A, 4100, 3, "33333333-3333-4333-8333-333333333301", false),
    success(A, 9000, 3, "33333333-3333-4333-8333-333333333302", true),
    success(B, 10100, 4, "44444444-4444-4444-8444-444444444401", true),
    success(B, 15000, 4, "44444444-4444-4444-8444-444444444402", true),
    { v: 1, at: at(15500), instanceId: B, pid: 4002, attempt: "disconnect-command", live: true, fence: 4, nonce: "55555555-5555-4555-8555-555555555501", cmd: "SET_ACTIVITY", evt: null, rpcOk: true },
    { v: 1, at: at(16500), instanceId: B, pid: 4002, attempt: "socket-close", live: true, code: "socket-closed" },
    { v: 1, at: at(16900), instanceId: B, pid: 4002, attempt: "ready", live: true, ready: true },
    success(B, 17100, 5, "55555555-5555-4555-8555-555555555502", true),
    { v: 1, at: at(21000), instanceId: B, pid: 4002, attempt: "cleanup", live: true, code: "cleanup" },
    { v: 1, at: at(10200), instanceId: A, pid: 4001, attempt: "command-publish", live: true, code: "not-owner" },
  ]
}

export function makeEvidenceFixture(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const write = (name: string, value: unknown): void => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`)
  const jsonl = (name: string, records: unknown[]): void => writeFileSync(join(dir, name), records.map((record) => JSON.stringify(record)).join("\n") + "\n")

  write("run.json", {
    v: 1,
    runId: "99999999-9999-4999-8999-999999999999",
    instanceId: A,
    pluginId: "opencode-presence-discord",
    packageVersion: "0.0.1",
    startedAt: at(0),
    host,
    sqlite,
    imports,
    locality,
    options: { capture: true, live: true, captureReference: true },
    discordSocket: "env",
  })
  write("probe.json", probe)
  write("locality.json", locality)
  write("remote.json", { status: "descoped", integration: "unverified", claimed: false, reason: "remote integration unverified; unknown identity refuses enrichment" })
  write("coverage.json", { v: 1, unobserved: ["session.idle", "session.status"], notes: ["sampled host behaviour"] })
  write("reload.json", { reloadReranSetup: true })
  write("canaries.json", {
    v: 1,
    tokens: [
      { category: "prompt", token: "M0CANARY_FIXTURE_PROMPT" },
      { category: "tool", token: "M0CANARY_FIXTURE_TOOL" },
      { category: "permission", token: "M0CANARY_FIXTURE_PERMISSION" },
      { category: "error", token: "M0CANARY_FIXTURE_ERROR" },
      { category: "form", token: "M0CANARY_FIXTURE_FORM" },
    ],
  })

  const { capture, reference } = captureRecords()
  jsonl("capture.jsonl", capture)
  jsonl("reference.jsonl", reference)

  const snapshotBase = (instanceId: string, status: "idle" | "running"): Record<string, unknown> => ({
    v: 1,
    kind: "startup-mid-task",
    at: at(0),
    runId: "99999999-9999-4999-8999-999999999999",
    instanceId,
    pid: instanceId === A ? 4001 : 4002,
    generation: instanceId === A ? "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" : "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    selector: { reason: "route", sessionHash: SESSION },
    inspection: inspection(instanceId, status),
    anchor: { seconds, sourceCreatedMs: createdMs, committedMs: baseMs + 4200 },
    ownership: { isOwner: instanceId === A, fence: instanceId === A ? 3 : 4, revoked: false, ownerRow: { instanceId: A, pid: 4001, generation: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", fence: 3, acquiredMs: baseMs, heartbeatMs: baseMs + 1000 } },
    acquisition: { status: "acquired", fence: instanceId === A ? 3 : 4 },
    locality,
    probe,
    captureEnabled: true,
    live: true,
  })
  write(`snapshot-${A}.json`, snapshotBase(A, "running"))
  write(`snapshot-${B}.json`, snapshotBase(B, "idle"))
  write("snapshot.json", snapshotBase(B, "idle"))

  const events = publisherEvents()
  jsonl(`publisher-${A}.jsonl`, events.filter((event) => event.instanceId === A))
  jsonl(`publisher-${B}.jsonl`, events.filter((event) => event.instanceId === B))
  jsonl("publication.jsonl", publicationRecords())
}

export { A as INSTANCE_A, B as INSTANCE_B, SESSION_KEY_HASH }
