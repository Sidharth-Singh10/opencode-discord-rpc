/**
 * Read-only M0 evidence validator. Missing evidence fails: it never fills in
 * defaults or infers an unobserved scenario.
 *
 * Usage: bun run scripts/m0-evidence.ts <evidence-dir>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { validateActivity } from "../src/discord/presence.js"

const dir = resolve(process.argv[2] ?? "")
if (!process.argv[2] || !existsSync(dir)) {
  console.error("usage: bun run scripts/m0-evidence.ts <evidence-dir>")
  process.exit(2)
}

const failures: string[] = []
const notices: string[] = []
const report: Record<string, unknown> = {}

function fail(message: string): void {
  failures.push(message)
}

function notice(message: string): void {
  notices.push(message)
}

function file(name: string): string {
  return join(dir, name)
}

function readJson(name: string): unknown | null {
  const path = file(name)
  if (!existsSync(path)) {
    fail(`missing ${name}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

interface JsonlRecord {
  [key: string]: unknown
}

function readJsonl(name: string): JsonlRecord[] {
  const path = file(name)
  if (!existsSync(path)) {
    fail(`missing ${name}`)
    return []
  }
  const records: JsonlRecord[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as JsonlRecord)
    } catch {
      fail(`${name} contains a malformed JSON line`)
    }
  }
  return records
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

// ---------------------------------------------------------------- run + probe
const run = asRecord(readJson("run.json"))
if (run) {
  const host = asRecord(run.host)
  const imports = asRecord(run.imports)
  const sqlite = asRecord(run.sqlite)
  if (typeof host?.version !== "string" || !host.version.startsWith("2.3.")) fail(`host version is not OpenCode 2.3.x: ${String(host?.version)}`)
  if (asRecord(imports?.net)?.ok !== true) fail("node:net import did not succeed inside the host")
  if (sqlite?.usable !== true) fail("no SQLite module was usable inside the host")
  if (typeof sqlite?.kind !== "string" || sqlite.kind.length === 0) fail("SQLite module kind was not recorded")
  const options = asRecord(run.options)
  if (options?.capture !== true) fail("event capture was not enabled in the recorded run")
  report.host = host
  report.imports = imports
  report.sqlite = sqlite
}

// ------------------------------------------------------------------ snapshots
const snapshotFiles = existsSync(dir) ? readdirSync(dir).filter((name) => /^snapshot-[a-zA-Z0-9-]+\.json$/.test(name)) : []
const snapshots = snapshotFiles
  .map((name) => asRecord(readJson(name)))
  .filter((value): value is Record<string, unknown> => value !== null)
if (snapshots.length < 2) fail(`expected at least two instance snapshots (two terminals), found ${snapshots.length}`)

const instanceIds = new Set(snapshots.map((snapshot) => String(snapshot.instanceId ?? "")).filter((id) => id.length > 0))
if (instanceIds.size < 2) fail(`expected two distinct plugin instances, found ${instanceIds.size}`)

const startup =
  snapshots.find((snapshot) => snapshot.kind === "startup-mid-task" && asRecord(snapshot.inspection)?.status === "running") ??
  snapshots.find((snapshot) => snapshot.kind === "startup-mid-task")
const startupInspection = asRecord(startup?.inspection)
if (!startup) fail("no startup-mid-task snapshot")
else {
  if (startupInspection?.found !== true) fail("startup snapshot did not find a session")
  if (startupInspection?.status !== "running") fail("no startup snapshot was taken while a session was mid-task (status=running)")
  if (typeof startupInspection?.lastUserMessageAtMs !== "number") fail("startup snapshot has no last user message creation time")
  const start = startupInspection?.frozenTimestampSeconds
  const createdMs = startupInspection?.lastUserMessageAtMs
  if (!Number.isSafeInteger(start)) fail("startup snapshot has no frozen integer timestamp")
  else if (typeof createdMs === "number" && start !== Math.floor(createdMs / 1000)) {
    fail("frozen timestamp is not floor(user message ms / 1000)")
  }
  if (typeof startupInspection?.frozenTimestampSource !== "string") fail("timestamp source field is not recorded")
  if (typeof startupInspection?.timestampOriginalUnits !== "string" || !/millisecond/i.test(startupInspection.timestampOriginalUnits)) {
    fail("timestamp original units are not recorded as milliseconds")
  }
  if (asRecord(startupInspection?.executedModel) === null) fail("startup snapshot has no executed model")
}
report.snapshots = { count: snapshots.length, instances: instanceIds.size }

// -------------------------------------------------------------------- capture
const capture = readJsonl("capture.jsonl")
const reference = readJsonl("reference.jsonl")
const publication = readJsonl("publication.jsonl")

const listenTypes = new Map<string, number>()
for (const record of capture) {
  if (typeof record.type === "string") listenTypes.set(record.type, (listenTypes.get(record.type) ?? 0) + 1)
}
const referenceTypes = new Map<string, number>()
for (const record of reference) {
  if (typeof record.type === "string") referenceTypes.set(record.type, (referenceTypes.get(record.type) ?? 0) + 1)
}

const requiredScenarios: Array<{ name: string; test: () => boolean }> = [
  { name: "startup mid-task snapshot", test: () => startupInspection?.status === "running" },
  { name: "turn started", test: () => (listenTypes.get("session.execution.started") ?? 0) > 0 },
  { name: "turn succeeded", test: () => (listenTypes.get("session.execution.succeeded") ?? 0) > 0 },
  { name: "turn failed", test: () => (listenTypes.get("session.execution.failed") ?? 0) > 0 },
  { name: "turn cancelled by user", test: () => capture.some((record) => record.type === "session.execution.interrupted" && asRecord(record.values)?.reason === "user") },
  { name: "permission wait and reply", test: () => (listenTypes.get("permission.asked") ?? 0) > 0 && (listenTypes.get("permission.replied") ?? 0) > 0 },
  { name: "compaction start and end", test: () => (listenTypes.get("session.compaction.started") ?? 0) > 0 && (listenTypes.get("session.compaction.ended") ?? 0) > 0 },
  { name: "tool call", test: () => (listenTypes.get("session.tool.called") ?? 0) > 0 },
  {
    name: "turn terminal event",
    test: () =>
      (listenTypes.get("session.idle") ?? 0) > 0 ||
      (listenTypes.get("session.status") ?? 0) > 0 ||
      (listenTypes.get("session.execution.succeeded") ?? 0) > 0 ||
      (listenTypes.get("session.execution.failed") ?? 0) > 0,
  },
  {
    name: "form observed (privacy canary seeded in form content)",
    test: () => (listenTypes.get("form.created") ?? 0) > 0,
  },
  {
    name: "reconnect (same instance saw server.connected twice or re-READY)",
    test: () => {
      const counts = new Map<string, number>()
      for (const record of reference) {
        if (record.type !== "server.connected" || typeof record.instanceId !== "string") continue
        counts.set(record.instanceId, (counts.get(record.instanceId) ?? 0) + 1)
      }
      if ([...counts.values()].some((count) => count >= 2)) return true
      const closes = new Set(publication.filter((record) => record.attempt === "socket-close").map((record) => record.instanceId))
      const readies = new Set(publication.filter((record) => record.attempt === "ready").map((record) => record.instanceId))
      return [...closes].some((id) => readies.has(id))
    },
  },
  { name: "cleanup", test: () => publication.some((record) => record.attempt === "cleanup") },
  { name: "explicit disconnect", test: () => publication.some((record) => record.attempt === "disconnect-command" || record.attempt === "disconnect") },
]
const coverage = asRecord(existsSync(file("coverage.json")) ? readJson("coverage.json") : null)
const unobserved = new Set(Array.isArray(coverage?.unobserved) ? coverage.unobserved.map(String) : [])
for (const scenario of requiredScenarios) {
  if (!scenario.test()) fail(`scenario not observed: ${scenario.name}`)
}
if ((listenTypes.get("location.shutdown") ?? 0) === 0) {
  if (unobserved.has("location.shutdown")) notice("location.shutdown was not observed; coverage.json records the limitation and its cause")
  else fail("scenario not observed: location.shutdown (no coverage.json entry explains the gap)")
}
report.scenarios = Object.fromEntries(requiredScenarios.map((scenario) => [scenario.name, scenario.test()]))
report.types = { listen: Object.fromEntries(listenTypes), reference: Object.fromEntries(referenceTypes) }

// -------------------------------------------------------------- paired events
const listenById = new Map<string, string>()
for (const record of capture) {
  if (typeof record.eventIDHash === "string" && typeof record.type === "string") listenById.set(record.eventIDHash, record.type)
}
const referenceById = new Map<string, string>()
for (const record of reference) {
  if (typeof record.eventIDHash === "string" && typeof record.type === "string" && !referenceById.has(record.eventIDHash)) {
    referenceById.set(record.eventIDHash, record.type)
  }
}
let paired = 0
const pairedTypes = new Set<string>()
for (const [id, type] of listenById) {
  if (referenceById.has(id)) {
    paired += 1
    pairedTypes.add(type)
  }
}
const listenOnly = [...listenById.keys()].filter((id) => !referenceById.has(id))
const referenceOnly = [...referenceById.keys()].filter((id) => !listenById.has(id))
if (paired < 5) fail(`paired listen/subscribe observations are too few: ${paired}`)
if (referenceOnly.length === 0) notice("every reference event was also seen by data.listen; no delivery gap recorded")
report.pairing = { listen: listenById.size, reference: referenceById.size, paired, pairedTypes: [...pairedTypes], listenOnly: listenOnly.length, referenceOnly: referenceOnly.length }

// ------------------------------------------------------------------ canaries
const canaryFile = asRecord(readJson("canaries.json"))
const canaryTokens: string[] = []
if (canaryFile) {
  const entries = Array.isArray(canaryFile.tokens) ? canaryFile.tokens : []
  for (const entry of entries) {
    if (typeof entry === "string") canaryTokens.push(entry)
    else {
      const record = asRecord(entry)
      if (typeof record?.token === "string") canaryTokens.push(record.token)
    }
  }
}
if (canaryTokens.length < 4) fail(`expected at least four seeded canaries, found ${canaryTokens.length}`)
const scannedFiles = existsSync(dir)
  ? readdirSync(dir).filter((name) => /\.(json|jsonl)$/.test(name) && name !== "canaries.json")
  : []
const leaked: Array<{ file: string; token: string }> = []
for (const name of scannedFiles) {
  const content = readFileSync(file(name), "utf8")
  for (const token of canaryTokens) {
    if (content.includes(token)) leaked.push({ file: name, token })
  }
}
if (leaked.length > 0) fail(`privacy canary leaked into evidence: ${leaked.map((entry) => `${entry.token} in ${entry.file}`).join(", ")}`)
report.canaries = { tokens: canaryTokens.length, filesScanned: scannedFiles.length, leaked: leaked.length }

// ------------------------------------------------------- lease and fence order
const publisherFiles = existsSync(dir) ? readdirSync(dir).filter((name) => /^publisher-[a-zA-Z0-9-]+\.jsonl$/.test(name)) : []
if (publisherFiles.length < 2) fail(`expected publisher logs from two instances, found ${publisherFiles.length}`)
interface PublisherEvent {
  atMs: number
  instanceId: string
  kind: string
  fence?: number
  previousFence?: number
  reason?: string
}
const publisherEvents: PublisherEvent[] = []
for (const name of publisherFiles) {
  for (const record of readJsonl(name)) {
    if (typeof record.kind !== "string" || typeof record.atMs !== "number" || typeof record.instanceId !== "string") continue
    publisherEvents.push({
      atMs: record.atMs,
      instanceId: record.instanceId,
      kind: record.kind,
      fence: typeof record.fence === "number" ? record.fence : undefined,
      previousFence: typeof record.previousFence === "number" ? record.previousFence : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    })
  }
}
publisherEvents.sort((a, b) => a.atMs - b.atMs)
const ownerChanges = publisherEvents.filter((event) => event.kind === "acquire" || event.kind === "takeover")
let lastFence = 0
const seenInstances = new Set<string>()
for (const event of ownerChanges) {
  if (event.fence === undefined) {
    fail("owner change without a fence")
    continue
  }
  if (event.fence <= lastFence) fail(`fence did not increase: ${event.fence} after ${lastFence}`)
  if (event.kind === "takeover" && event.previousFence !== undefined && event.previousFence >= event.fence) {
    fail(`takeover fence ${event.fence} does not exceed previous fence ${event.previousFence}`)
  }
  lastFence = event.fence
  seenInstances.add(event.instanceId)
}
if (seenInstances.size < 2) fail(`fence ownership seen from ${seenInstances.size} instance(s), expected two`)
if (!publisherEvents.some((event) => event.kind === "takeover")) fail("no fenced takeover was observed")
if (!publisherEvents.some((event) => event.kind === "revoke")) fail("no revoked owner was observed")
report.fences = { ownerChanges: ownerChanges.length, highest: lastFence, instances: seenInstances.size }

function ownerAt(at: string | number | undefined): PublisherEvent | null {
  if (at === undefined) return null
  const when = typeof at === "number" ? at : Date.parse(at)
  if (!Number.isFinite(when)) return null
  let current: PublisherEvent | null = null
  for (const event of ownerChanges) {
    if (event.atMs <= when) current = event
    else break
  }
  return current
}

const successfulPublications = publication.filter((record) => record.rpcOk === true && asRecord(record.activity) !== null)
const refusedPublications = publication.filter((record) => typeof record.refused === "string")

for (const record of publication) {
  const when = typeof record.at === "string" ? Date.parse(record.at) : NaN
  if (!Number.isFinite(when)) fail("publication record without a parseable time")
  if (record.attempt === "ready") continue
  if (record.attempt === "cleanup" || record.attempt === "socket-close" || record.attempt === "socket-error" || record.attempt === "revoked") continue
  if (record.rpcOk === true || typeof record.nonce === "string") {
    const owner = ownerAt(when)
    if (!owner) {
      fail(`SET_ACTIVITY at ${String(record.at)} has no recorded owner`)
      continue
    }
    if (owner.instanceId !== record.instanceId) fail("SET_ACTIVITY was enqueued by an instance that did not own the fence")
    if (typeof record.fence === "number" && owner.fence !== record.fence) fail("SET_ACTIVITY fence does not match the owner's fence")
  }
  if (typeof record.refused === "string" && /not-owner|another instance|revoked/i.test(record.refused) && typeof record.nonce === "string") {
    fail("a refused (non-owner) publication still enqueued a nonce")
  }
}

if (successfulPublications.length === 0) fail("no acknowledged SET_ACTIVITY is recorded")
if (!publication.some((record) => record.attempt === "ready" && record.ready === true)) fail("no READY handshake is recorded")

// --------------------------------------------------------------- payload rules
const timestampGroups = new Map<string, Array<{ at: number; start: number }>>()
for (const record of successfulPublications) {
  const activity = asRecord(record.activity)
  const validation = validateActivity(activity)
  if (!validation.ok) fail(`published payload is not the fixed M0 payload: ${validation.problems.join("; ")}`)
  if (typeof record.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(record.nonce)) fail("successful SET_ACTIVITY has no nonce")
  const provenance = asRecord(record.timestampProvenance)
  const start = asRecord(activity?.timestamps)?.start
  if (provenance?.seconds !== start) fail("published timestamp does not match its recorded provenance")
  if (typeof provenance?.originalUnits !== "string" || !/millisecond/i.test(provenance.originalUnits)) {
    fail("timestamp provenance does not record the original millisecond units")
  }
  const model = asRecord(activity?.assets)
  const executed = asRecord(asRecord(record.modelProvenance)?.executed)
  if (typeof executed?.providerID !== "string" || typeof executed?.id !== "string") fail("publication lacks executed-model provenance")
  else if (model?.small_text !== `Model: ${executed.providerID}/${executed.id}`) fail("small_text does not match the executed model")
  const at = typeof record.at === "string" ? Date.parse(record.at) : NaN
  if (typeof record.sessionHash === "string" && Number.isFinite(at) && typeof start === "number") {
    const group = timestampGroups.get(record.sessionHash) ?? []
    group.push({ at, start })
    timestampGroups.set(record.sessionHash, group)
  }
}
for (const [sessionHash, group] of timestampGroups) {
  const starts = new Set(group.map((entry) => entry.start))
  if (starts.size > 1) fail(`session ${sessionHash} published more than one timestamp`)
  if (group.length >= 2) {
    const gap = Math.max(...group.map((entry) => entry.at)) - Math.min(...group.map((entry) => entry.at))
    if (gap < 4000) fail("a republish was not separated by at least 4 seconds, so the timer was not proven frozen")
  }
}
report.publication = {
  attempts: publication.length,
  successful: successfulPublications.length,
  refused: refusedPublications.length,
  timestampSessions: timestampGroups.size,
}

// ------------------------------------------------------------------- locality
const locality = asRecord(readJson("locality.json"))
if (locality) {
  if (locality.class === "local" && locality.enrichment !== "allowed") fail("a locally classified server did not allow local-DB enrichment")
  if (locality.class === "remote" && locality.enrichment !== "refused") fail("a remote server did not refuse local-DB enrichment")
  if (locality.class === "unknown" && locality.enrichment !== "refused") fail("an unknown server identity did not refuse local-DB enrichment")
}
const remote = asRecord(readJson("remote.json"))
if (remote) {
  if (remote.status === "blocked") {
    if (typeof remote.reason !== "string" || remote.reason.length === 0) fail("remote test blocked without a reason")
  } else if (remote.status === "tested") {
    if (remote.classification !== "remote" || remote.enrichment !== "refused") {
      fail("remote test did not classify the server as remote with enrichment refused")
    }
  } else fail("remote.json has no recognised status (blocked|tested)")
}

// ---------------------------------------------------------------- final result
report.failures = failures
report.notices = notices
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) {
  console.error(`\nM0 evidence: FAIL (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log("\nM0 evidence: PASS")
for (const message of notices) console.log(`  note: ${message}`)
