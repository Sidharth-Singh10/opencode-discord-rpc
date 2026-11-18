/**
 * Read-only M0 evidence validator. Strict by design: a missing, null,
 * malformed, array-valued, wrongly typed or incomplete document fails, as does
 * missing scenario evidence, a broken owner/fence timeline, a non-owner write,
 * a tampered timestamp anchor and an unproven remote claim.
 *
 * Usage: bun run scripts/m0-evidence.ts <evidence-dir>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { validateCaptureRecord, type CaptureRecord } from "../src/m0/capture.js"
import type { CapturedEvent } from "../src/m0/capture.js"
import { validateActivity } from "../src/discord/presence.js"

export interface ValidationResult {
  failures: string[]
  notices: string[]
  report: Record<string, unknown>
}

const HASH = /^[0-9a-f]{16}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SESSION_KEY = /^[0-9a-f]{64}$/

const PROBE_CODES = new Set(["import-failed", "probe-failed", "select-mismatch"])
const LOCALITY_REASONS = new Set(["host-and-urls-match", "host-mismatch", "url-not-loopback", "identity-incomplete", "server-info-unavailable"])
const PUBLISHER_KINDS = new Set(["acquire", "renew", "takeover", "contended", "release", "revoke", "critical", "error", "snapshot", "cleanup"])
const PUBLISHER_CODES = new Set(["store-unavailable", "closed", "contended", "acquire-failed", "renew-failed", "release-failed", "critical-failed"])
const PUBLISHER_REASONS = new Set(["fence-changed", "owner-row-gone", "release-fence-mismatch", "fence-mismatch", "busy", "cleanup"])
const ATTEMPTS = new Set(["ready", "socket-close", "socket-error", "command-publish", "disconnect-command", "disconnect", "revoked", "cleanup", "cleanup-close", "coordination-start"])
const CODES = new Set([
  "live-disabled",
  "no-coordinator",
  "no-observed-session",
  "session-unreadable",
  "executed-model-unknown",
  "timestamp-unavailable",
  "payload-invalid",
  "not-owner",
  "connect-failed",
  "enqueue-busy",
  "enqueue-not-owner",
  "enqueue-revoked",
  "enqueue-no-store",
  "enqueue-error",
  "rpc-rejected",
  "rpc-timeout",
  "rpc-closed",
  "clear-refused",
  "no-socket",
  "socket-closed",
  "socket-error",
  "publisher-revoked",
  "cleanup",
])
const CANARY_CATEGORIES = new Set(["prompt", "tool", "permission", "error", "form"])

type Json = Record<string, unknown>

export function validateEvidence(dir: string): ValidationResult {
  const failures: string[] = []
  const notices: string[] = []
  const report: Record<string, unknown> = {}
  const fail = (message: string): void => void failures.push(message)
  const notice = (message: string): void => void notices.push(message)
  const file = (name: string): string => join(dir, name)

  function readJson(name: string): unknown {
    const path = file(name)
    if (!existsSync(path)) {
      fail(`missing ${name}`)
      return undefined
    }
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown
    } catch {
      fail(`${name} is not valid JSON`)
      return undefined
    }
  }

  function readJsonl(name: string): Json[] {
    const path = file(name)
    if (!existsSync(path)) {
      fail(`missing ${name}`)
      return []
    }
    const records: Json[] = []
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        fail(`${name} contains a malformed JSON line`)
        continue
      }
      if (!isObject(parsed)) {
        fail(`${name} contains a non-object record`)
        continue
      }
      records.push(parsed)
    }
    return records
  }

  function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  function shape(value: unknown, name: string, required: readonly string[], optional: readonly string[] = []): Json | null {
    if (!isObject(value)) {
      fail(`${name} must be an object`)
      return null
    }
    const allowed = new Set([...required, ...optional])
    for (const key of required) if (!(key in value)) fail(`${name} is missing ${key}`)
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name} has unexpected key ${key}`)
    return value
  }

  function stringField(value: Json, key: string, name: string, pattern?: RegExp): string | null {
    const field = value[key]
    if (typeof field !== "string" || field.length === 0) {
      fail(`${name}.${key} must be a non-empty string`)
      return null
    }
    if (pattern && !pattern.test(field)) {
      fail(`${name}.${key} has an invalid format`)
      return null
    }
    return field
  }

  function numberField(value: Json, key: string, name: string, integer = false): number | null {
    const field = value[key]
    if (typeof field !== "number" || !Number.isFinite(field) || (integer && !Number.isSafeInteger(field))) {
      fail(`${name}.${key} must be ${integer ? "an integer" : "a finite number"}`)
      return null
    }
    return field
  }

  function booleanField(value: Json, key: string, name: string): boolean | null {
    const field = value[key]
    if (typeof field !== "boolean") {
      fail(`${name}.${key} must be a boolean`)
      return null
    }
    return field
  }

  function hashOrNull(value: Json, key: string, name: string): void {
    const field = value[key]
    if (field !== null && (typeof field !== "string" || !HASH.test(field))) fail(`${name}.${key} must be a 16-hex hash or null`)
  }

  function validateModel(value: unknown, name: string): void {
    if (value === null) return
    const model = shape(value, name, ["id", "providerID"], ["variant"])
    if (!model) return
    stringField(model, "id", name)
    stringField(model, "providerID", name)
    if ("variant" in model) stringField(model, "variant", name)
  }

  function validateTokens(value: unknown, name: string): void {
    if (value === null) return
    const tokens = shape(value, name, ["input", "output", "reasoning", "cacheRead", "cacheWrite"])
    if (!tokens) return
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"]) numberField(tokens, key, name, true)
  }

  function validateLocality(value: unknown, name: string): { class: string; enrichment: string } | null {
    const locality = shape(value, name, ["class", "enrichment", "reason", "serverFingerprint", "evidence", "observedAt"])
    if (!locality) return null
    const klass = stringField(locality, "class", name)
    const enrichment = stringField(locality, "enrichment", name)
    const reason = stringField(locality, "reason", name)
    stringField(locality, "observedAt", name, ISO)
    if (klass !== null && !["local", "remote", "unknown"].includes(klass)) fail(`${name}.class has an invalid enum`)
    if (enrichment !== null && !["allowed", "refused"].includes(enrichment)) fail(`${name}.enrichment has an invalid enum`)
    if (reason !== null && !LOCALITY_REASONS.has(reason)) fail(`${name}.reason has an invalid enum`)
    const fingerprint = locality.serverFingerprint
    if (fingerprint !== null && (typeof fingerprint !== "string" || !HASH.test(fingerprint))) fail(`${name}.serverFingerprint must be a hash or null`)

    const evidence = shape(locality.evidence, `${name}.evidence`, ["method", "hostnamePresent", "hostnameMatches", "urlCount", "allUrlsLoopback"])
    if (evidence) {
      const method = stringField(evidence, "method", `${name}.evidence`)
      if (method !== null && !["server.info", "none"].includes(method)) fail(`${name}.evidence.method has an invalid enum`)
      booleanField(evidence, "hostnamePresent", `${name}.evidence`)
      const matches = evidence.hostnameMatches
      if (matches !== null && typeof matches !== "boolean") fail(`${name}.evidence.hostnameMatches must be boolean or null`)
      const urlCount = numberField(evidence, "urlCount", `${name}.evidence`, true)
      if (urlCount !== null && urlCount < 0) fail(`${name}.evidence.urlCount cannot be negative`)
      const loopback = evidence.allUrlsLoopback
      if (loopback !== null && typeof loopback !== "boolean") fail(`${name}.evidence.allUrlsLoopback must be boolean or null`)
    }

    if (klass === "local") {
      if (enrichment !== "allowed") fail(`${name}: local identity did not allow enrichment`)
      if (reason !== "host-and-urls-match") fail(`${name}: local identity has the wrong reason`)
      if (typeof fingerprint !== "string") fail(`${name}: local identity has no server fingerprint`)
      if (evidence?.hostnameMatches !== true || evidence?.allUrlsLoopback !== true || (evidence?.urlCount as number) <= 0) {
        fail(`${name}: local identity lacks a complete host+loopback proof`)
      }
    } else if (klass === "remote" || klass === "unknown") {
      if (enrichment !== "refused") fail(`${name}: ${klass} identity allowed enrichment`)
      if (reason === "host-and-urls-match") fail(`${name}: ${klass} identity cannot claim a local match`)
    }
    return klass && enrichment ? { class: klass, enrichment } : null
  }

  function validateHost(value: unknown, name: string): void {
    const host = shape(value, name, ["version", "channel", "kind", "platform", "arch", "pid"], ["bun", "node"])
    if (!host) return
    const version = stringField(host, "version", name)
    if (version !== null && !version.startsWith("2.3.")) fail(`${name}.version is not OpenCode 2.3.x`)
    stringField(host, "channel", name)
    const kind = stringField(host, "kind", name)
    if (kind !== null && !["bun", "node", "unknown"].includes(kind)) fail(`${name}.kind has an invalid enum`)
    stringField(host, "platform", name)
    stringField(host, "arch", name)
    numberField(host, "pid", name, true)
    if ("bun" in host) stringField(host, "bun", name)
    if ("node" in host) stringField(host, "node", name)
  }

  function validateProbeStages(value: unknown, name: string, net: boolean): void {
    if (!isObject(value)) {
      fail(`${name} must be an object`)
      return
    }
    const required = net ? ["ok", "createConnection"] : ["ok"]
    const stage = shape(value, name, required, ["code", "selectOne"])
    if (!stage) return
    booleanField(stage, "ok", name)
    if (net) booleanField(stage, "createConnection", name)
    if ("code" in stage && (typeof stage.code !== "string" || !PROBE_CODES.has(stage.code))) fail(`${name}.code has an invalid enum`)
    if ("selectOne" in stage) numberField(stage, "selectOne", name, true)
  }

  function validateProbeDocument(value: unknown, name: string): void {
    const probe = shape(value, name, ["observedAt", "host", "imports", "sqlite"])
    if (!probe) return
    stringField(probe, "observedAt", name, ISO)
    validateHost(probe.host, `${name}.host`)
    const imports = shape(probe.imports, `${name}.imports`, ["net", "bun:sqlite", "node:sqlite"])
    if (imports) {
      validateProbeStages(imports.net, `${name}.imports.net`, true)
      validateProbeStages(imports["bun:sqlite"], `${name}.imports.bun:sqlite`, false)
      validateProbeStages(imports["node:sqlite"], `${name}.imports.node:sqlite`, false)
    }
    const sqlite = shape(probe.sqlite, `${name}.sqlite`, ["usable", "kind"], ["selectOne"])
    if (sqlite) {
      if (booleanField(sqlite, "usable", `${name}.sqlite`) !== true) fail(`${name}.sqlite is not usable`)
      const kind = stringField(sqlite, "kind", `${name}.sqlite`)
      if (kind !== null && !["bun:sqlite", "node:sqlite"].includes(kind)) fail(`${name}.sqlite.kind has an invalid enum`)
    }
  }

  function validateInspection(value: unknown, name: string): Json | null {
    if (value === null) return null
    const inspection = shape(value, name, [
      "observedAt",
      "sessionIDHash",
      "found",
      "status",
      "sessionCost",
      "reportedCost",
      "tokens",
      "selectedModel",
      "executedModel",
      "agent",
      "messageCount",
      "latestUserMessageAtMs",
      "latestUserMessageSource",
      "candidateTimestampSeconds",
      "candidateTimestampError",
      "timestampOriginalUnits",
      "errorCodes",
    ])
    if (!inspection) return null
    stringField(inspection, "observedAt", name, ISO)
    if (inspection.sessionIDHash !== null && (typeof inspection.sessionIDHash !== "string" || !HASH.test(inspection.sessionIDHash))) fail(`${name}.sessionIDHash must be a hash or null`)
    booleanField(inspection, "found", name)
    if (inspection.status !== null && !["idle", "running"].includes(String(inspection.status))) fail(`${name}.status has an invalid enum`)
    for (const key of ["sessionCost", "reportedCost"]) {
      if (inspection[key] !== null && (typeof inspection[key] !== "number" || !Number.isFinite(inspection[key]))) fail(`${name}.${key} must be a number or null`)
    }
    validateTokens(inspection.tokens, `${name}.tokens`)
    validateModel(inspection.selectedModel, `${name}.selectedModel`)
    validateModel(inspection.executedModel, `${name}.executedModel`)
    if (inspection.agent !== null) stringField(inspection, "agent", name)
    numberField(inspection, "messageCount", name, true)
    if (inspection.latestUserMessageAtMs !== null) numberField(inspection, "latestUserMessageAtMs", name, true)
    if (inspection.latestUserMessageSource !== null) {
      if (inspection.latestUserMessageSource !== "session.message.list[].type=user.time.created") fail(`${name}.latestUserMessageSource is not the expected field`)
    }
    if (inspection.candidateTimestampSeconds !== null) numberField(inspection, "candidateTimestampSeconds", name, true)
    if (inspection.candidateTimestampError !== null && !["timestamp-missing", "timestamp-invalid", "timestamp-implausible", "timestamp-future"].includes(String(inspection.candidateTimestampError))) {
      fail(`${name}.candidateTimestampError has an invalid enum`)
    }
    if (inspection.candidateTimestampSeconds !== null) {
      if (inspection.timestampOriginalUnits !== "milliseconds since Unix epoch (converted with floor(ms/1000))") fail(`${name}.timestampOriginalUnits is not the expected value`)
      if (typeof inspection.latestUserMessageAtMs === "number" && inspection.candidateTimestampSeconds !== Math.floor(inspection.latestUserMessageAtMs / 1000)) {
        fail(`${name}: candidate timestamp is not floor(latest user message ms / 1000)`)
      }
    }
    if (!Array.isArray(inspection.errorCodes) || inspection.errorCodes.some((code) => typeof code !== "string")) fail(`${name}.errorCodes must be a string array`)
    return inspection
  }

  function validateAnchor(value: unknown, name: string): void {
    if (value === null) return
    const anchor = shape(value, name, ["seconds", "sourceCreatedMs", "committedMs"])
    if (!anchor) return
    numberField(anchor, "seconds", name, true)
    numberField(anchor, "sourceCreatedMs", name, true)
    numberField(anchor, "committedMs", name, true)
    const seconds = anchor.seconds as number
    const created = anchor.sourceCreatedMs as number
    if (Number.isSafeInteger(seconds) && Number.isSafeInteger(created) && seconds !== Math.floor(created / 1000)) fail(`${name}: anchor conversion is not floor(ms/1000)`)
  }

  // ------------------------------------------------------------- run + probe
  const runValue = readJson("run.json")
  const run = shape(runValue, "run.json", ["v", "runId", "instanceId", "pluginId", "packageVersion", "startedAt", "host", "sqlite", "imports", "locality", "options", "discordSocket"])
  if (run) {
    if (run.v !== 1) fail("run.json.v must be 1")
    stringField(run, "runId", "run.json", UUID)
    stringField(run, "instanceId", "run.json", UUID)
    if (run.pluginId !== "opencode-presence-discord") fail("run.json.pluginId is wrong")
    if (run.packageVersion !== "0.0.1") fail("run.json.packageVersion must be 0.0.1")
    stringField(run, "startedAt", "run.json", ISO)
    validateHost(run.host, "run.json.host")
    validateProbeDocument({ observedAt: run.startedAt, host: run.host, imports: run.imports, sqlite: run.sqlite }, "run.json")
    validateLocality(run.locality, "run.json.locality")
    const options = shape(run.options, "run.json.options", ["capture", "live", "captureReference"])
    if (options) {
      if (booleanField(options, "capture", "run.json.options") !== true) fail("run.json.options.capture must be true")
      booleanField(options, "live", "run.json.options")
      booleanField(options, "captureReference", "run.json.options")
    }
    if (!["env", "default"].includes(String(run.discordSocket))) fail("run.json.discordSocket has an invalid enum")
  }

  validateProbeDocument(readJson("probe.json"), "probe.json")

  const localityValue = readJson("locality.json")
  const locality = validateLocality(localityValue, "locality.json")
  const localityDoc = isObject(localityValue) ? localityValue : null
  if (localityDoc) {
    const evidence = isObject(localityDoc.evidence) ? localityDoc.evidence : null
    if (evidence && typeof evidence.hostnameMatches === "boolean" && evidence.hostnameMatches === false && localityDoc.class === "local") {
      fail("locality.json claims local with a hostname mismatch")
    }
  }

  // ------------------------------------------------------------- remote gate
  const remoteValue = readJson("remote.json")
  const remote = shape(remoteValue, "remote.json", ["status", "claimed", "reason"], ["integration", "classification", "enrichment"])
  if (remote) {
    if (remote.claimed !== false) fail("remote.json claims remote integration without evidence")
    if (remote.status === "descoped") {
      if (remote.integration !== "unverified") fail("descoped remote.json must record integration unverified")
    } else if (remote.status === "tested") {
      if (remote.classification !== "remote" || remote.enrichment !== "refused") fail("tested remote.json must classify remote and refuse enrichment")
    } else fail("remote.json.status must be descoped or tested")
    stringField(remote, "reason", "remote.json")
  }

  // ---------------------------------------------------------- coverage + reload
  const coverageValue = readJson("coverage.json")
  const coverage = shape(coverageValue, "coverage.json", ["v", "unobserved", "notes"])
  if (coverage) {
    if (coverage.v !== 1) fail("coverage.json.v must be 1")
    if (!Array.isArray(coverage.unobserved) || coverage.unobserved.some((entry) => typeof entry !== "string")) fail("coverage.json.unobserved must be a string array")
    if (!Array.isArray(coverage.notes) || coverage.notes.some((entry) => typeof entry !== "string")) fail("coverage.json.notes must be a string array")
  }
  const reloadValue = readJson("reload.json")
  const reload = shape(reloadValue, "reload.json", ["reloadReranSetup"])
  if (reload) {
    if (booleanField(reload, "reloadReranSetup", "reload.json") !== true) fail("reload.json did not record a setup re-run")
  }

  // ---------------------------------------------------------------- canaries
  const canaryValue = readJson("canaries.json")
  const canary = shape(canaryValue, "canaries.json", ["v", "tokens"])
  const canaryTokens: string[] = []
  if (canary) {
    if (canary.v !== 1) fail("canaries.json.v must be 1")
    if (!Array.isArray(canary.tokens)) fail("canaries.json.tokens must be an array")
    else {
      const categories = new Set<string>()
      for (const entry of canary.tokens) {
        const token = shape(entry, "canaries.json.tokens[]", ["category", "token"])
        if (!token) continue
        const category = stringField(token, "category", "canaries.json.tokens[]")
        const text = stringField(token, "token", "canaries.json.tokens[]")
        if (category !== null && !CANARY_CATEGORIES.has(category)) fail(`canaries.json has an unknown category ${category}`)
        if (category) categories.add(category)
        if (text) canaryTokens.push(text)
      }
      if (categories.size < 5) fail("canaries.json must seed prompt/tool/permission/error/form categories")
      if (new Set(canaryTokens).size !== canaryTokens.length) fail("canaries.json tokens must be unique")
    }
  }
  if (canaryTokens.length < 5) fail(`expected at least five canaries, found ${canaryTokens.length}`)
  const scanned = existsSync(dir) ? readdirSync(dir).filter((name) => /\.(json|jsonl)$/.test(name) && name !== "canaries.json") : []
  const leaked: string[] = []
  for (const name of scanned) {
    const content = readFileSync(file(name), "utf8")
    for (const token of canaryTokens) if (content.includes(token)) leaked.push(`${token} in ${name}`)
  }
  if (leaked.length > 0) fail(`privacy canary leaked: ${leaked.join(", ")}`)

  // ---------------------------------------------------------------- snapshots
  const snapshotFiles = existsSync(dir) ? readdirSync(dir).filter((name) => /^snapshot-[a-zA-Z0-9-]+\.json$/.test(name)) : []
  const snapshots: Json[] = []
  for (const name of snapshotFiles) {
    const value = readJson(name)
    const snapshot = shape(value, name, ["v", "kind", "at", "runId", "instanceId", "pid", "generation", "selector", "inspection", "anchor", "ownership", "acquisition", "locality", "probe", "captureEnabled", "live"])
    if (!snapshot) continue
    if (snapshot.v !== 1) fail(`${name}.v must be 1`)
    if (!["startup-mid-task", "manual-snapshot"].includes(String(snapshot.kind))) fail(`${name}.kind has an invalid enum`)
    stringField(snapshot, "at", name, ISO)
    stringField(snapshot, "runId", name, UUID)
    stringField(snapshot, "instanceId", name, UUID)
    numberField(snapshot, "pid", name, true)
    stringField(snapshot, "generation", name, UUID)
    if (snapshot.selector !== null) {
      const selector = shape(snapshot.selector, `${name}.selector`, ["reason", "sessionHash"])
      if (selector) {
        if (!["route", "event", "most-recent"].includes(String(selector.reason))) fail(`${name}.selector.reason has an invalid enum`)
        if (typeof selector.sessionHash !== "string" || !HASH.test(selector.sessionHash)) fail(`${name}.selector.sessionHash must be a hash`)
      }
    }
    validateInspection(snapshot.inspection, `${name}.inspection`)
    validateAnchor(snapshot.anchor, `${name}.anchor`)
    if (snapshot.ownership !== null) {
      const ownership = shape(snapshot.ownership, `${name}.ownership`, ["isOwner", "fence", "revoked", "ownerRow"])
      if (ownership) {
        booleanField(ownership, "isOwner", `${name}.ownership`)
        numberField(ownership, "fence", `${name}.ownership`, true)
        booleanField(ownership, "revoked", `${name}.ownership`)
        if (ownership.ownerRow !== null) {
          const row = shape(ownership.ownerRow, `${name}.ownership.ownerRow`, ["instanceId", "pid", "generation", "fence", "acquiredMs", "heartbeatMs"])
          if (row) {
            stringField(row, "instanceId", `${name}.ownership.ownerRow`, UUID)
            numberField(row, "pid", `${name}.ownership.ownerRow`, true)
            stringField(row, "generation", `${name}.ownership.ownerRow`, UUID)
            numberField(row, "fence", `${name}.ownership.ownerRow`, true)
            numberField(row, "acquiredMs", `${name}.ownership.ownerRow`, true)
            numberField(row, "heartbeatMs", `${name}.ownership.ownerRow`, true)
          }
        }
      }
    }
    if (snapshot.acquisition !== null) {
      const acquisition = shape(snapshot.acquisition, `${name}.acquisition`, ["status"], ["fence", "code", "reason", "previous", "owner"])
      if (acquisition) {
        if (!["acquired", "renewed", "takeover", "contended", "revoked", "error"].includes(String(acquisition.status))) fail(`${name}.acquisition.status has an invalid enum`)
        if (acquisition.owner !== undefined && acquisition.owner !== null) {
          const row = shape(acquisition.owner, `${name}.acquisition.owner`, ["instanceId", "pid", "generation", "fence", "acquiredMs", "heartbeatMs"])
          if (row) numberField(row, "fence", `${name}.acquisition.owner`, true)
        }
      }
    }
    validateLocality(snapshot.locality, `${name}.locality`)
    validateProbeDocument(snapshot.probe, `${name}.probe`)
    booleanField(snapshot, "captureEnabled", name)
    booleanField(snapshot, "live", name)
    snapshots.push(snapshot)
  }
  const instances = new Set(snapshots.map((snapshot) => String(snapshot.instanceId)))
  if (snapshots.length < 2) fail("expected at least two instance snapshots")
  if (instances.size < 2) fail("expected two distinct plugin instances")
  const startup = snapshots.find((snapshot) => snapshot.kind === "startup-mid-task" && isObject(snapshot.inspection) && snapshot.inspection.status === "running")
  if (!startup) fail("no startup-mid-task snapshot with a running session")
  else {
    const inspection = startup.inspection as Json
    if (inspection.found !== true) fail("startup snapshot did not find a session")
    if (typeof inspection.latestUserMessageAtMs !== "number") fail("startup snapshot has no user-message creation time")
    if (!Number.isSafeInteger(inspection.candidateTimestampSeconds)) fail("startup snapshot has no candidate integer timestamp")
    if (inspection.executedModel === null) fail("startup snapshot has no executed model")
  }
  report.snapshots = { count: snapshots.length, instances: instances.size }

  // ----------------------------------------------------------------- capture
  const captureRaw = readJsonl("capture.jsonl")
  const capture: CaptureRecord[] = []
  for (const record of captureRaw) {
    if (!validateCaptureRecord(record)) {
      fail("capture.jsonl contains a record outside the strict allowlisted shape")
      continue
    }
    capture.push(record)
  }
  const isEventRecord = (record: CaptureRecord): record is CapturedEvent => "eventIDHash" in record
  const reference = readJsonl("reference.jsonl")
  const REFERENCE_KEYS = new Set(["v", "seq", "atMs", "source", "type", "eventIDHash", "sessionHash", "locationHash", "instanceId", "eventCreatedMs", "code"])
  for (const record of reference) {
    for (const key of Object.keys(record)) if (!REFERENCE_KEYS.has(key)) fail(`reference.jsonl has an unexpected key ${key}`)
    if (record.v !== 1 || record.source !== "subscribe" || typeof record.type !== "string" || typeof record.instanceId !== "string") {
      fail("reference.jsonl contains an invalid record")
    }
    if (record.type !== "observer.error") {
      for (const key of ["eventIDHash", "sessionHash", "locationHash"]) hashOrNull(record, key, "reference.jsonl")
      if (typeof record.eventIDHash !== "string" || !HASH.test(record.eventIDHash)) fail("reference.jsonl event has no event ID hash")
    } else if (record.code !== "capture-listen-failed" || Object.keys(record).length !== 7) {
      fail("observer.error must carry only the fixed code")
    }
  }

  const perInstance: Record<string, { listen: Record<string, number>; reference: Record<string, number>; listenIDs: Set<string>; referenceIDs: Set<string>; paired: number; listenOnly: number; referenceOnly: number }> = {}
  const listenTypes = new Map<string, number>()
  const referenceTypes = new Map<string, number>()
  const listenIDs = new Map<string, string>()
  const referenceIDs = new Map<string, string>()
  for (const record of capture) {
    listenTypes.set(record.type, (listenTypes.get(record.type) ?? 0) + 1)
    if (isEventRecord(record) && record.eventIDHash) listenIDs.set(`${record.instanceId}:${record.eventIDHash}`, record.type)
    perInstance[record.instanceId] ??= { listen: {}, reference: {}, listenIDs: new Set(), referenceIDs: new Set(), paired: 0, listenOnly: 0, referenceOnly: 0 }
    perInstance[record.instanceId]!.listen[record.type] = (perInstance[record.instanceId]!.listen[record.type] ?? 0) + 1
    if (isEventRecord(record) && record.eventIDHash) perInstance[record.instanceId]!.listenIDs.add(record.eventIDHash)
  }
  for (const record of reference) {
    const type = String(record.type)
    if (type !== "observer.error") referenceTypes.set(type, (referenceTypes.get(type) ?? 0) + 1)
    if (typeof record.eventIDHash === "string") referenceIDs.set(`${String(record.instanceId)}:${record.eventIDHash}`, type)
    perInstance[String(record.instanceId)] ??= { listen: {}, reference: {}, listenIDs: new Set(), referenceIDs: new Set(), paired: 0, listenOnly: 0, referenceOnly: 0 }
    perInstance[String(record.instanceId)]!.reference[type] = (perInstance[String(record.instanceId)]!.reference[type] ?? 0) + 1
    if (typeof record.eventIDHash === "string") perInstance[String(record.instanceId)]!.referenceIDs.add(record.eventIDHash)
  }
  let paired = 0
  for (const [id, type] of listenIDs) {
    if (referenceIDs.has(id)) {
      paired += 1
      if (type === "observer.error") fail("capture contains an observer.error record")
    }
  }
  for (const instance of Object.keys(perInstance)) {
    const entry = perInstance[instance]!
    entry.paired = 0
    for (const id of entry.listenIDs) if (entry.referenceIDs.has(id)) entry.paired += 1
    entry.listenOnly = entry.listenIDs.size - entry.paired
    entry.referenceOnly = entry.referenceIDs.size - entry.paired
  }
  if (paired < 5) fail(`paired listen/subscribe observations are too few: ${paired}`)
  const executionStartIDs = new Set(capture.filter((record): record is CapturedEvent => isEventRecord(record) && record.type === "session.execution.started" && record.eventIDHash !== null).map((record) => record.eventIDHash))
  const referenceRealTypes = new Set([...referenceTypes.keys()])
  report.coverage = {
    listenTypes: listenTypes.size,
    referenceRealTypes: referenceRealTypes.size,
    distinctExecutionStartIDs: executionStartIDs.size,
    observerErrors: reference.filter((record) => record.type === "observer.error").length,
    paired,
    perInstance,
  }
  report.types = { listen: Object.fromEntries(listenTypes), reference: Object.fromEntries(referenceTypes) }

  const has = (type: string): boolean => (listenTypes.get(type) ?? 0) > 0
  const interruptions = capture.filter((record): record is CapturedEvent => isEventRecord(record) && record.type === "session.execution.interrupted" && record.values.reason === "user")
  const scenarios: Array<{ name: string; ok: boolean }> = [
    { name: "startup mid-task running", ok: Boolean(startup) },
    { name: "turn started", ok: has("session.execution.started") },
    { name: "turn succeeded", ok: has("session.execution.succeeded") },
    { name: "turn failed", ok: has("session.execution.failed") },
    { name: "turn cancelled by user", ok: interruptions.length > 0 },
    { name: "permission wait and reply", ok: has("permission.asked") && has("permission.replied") },
    { name: "compaction start and end", ok: has("session.compaction.started") && has("session.compaction.ended") },
    { name: "tool call", ok: has("session.tool.called") },
    { name: "form observed and closed", ok: has("form.created") && (has("form.cancelled") || has("form.replied")) },
    { name: "location shutdown", ok: has("location.shutdown") },
    { name: "cleanup", ok: false },
    { name: "explicit disconnect", ok: false },
    { name: "reload re-ran setup", ok: reload?.reloadReranSetup === true },
    { name: "reconnect", ok: false },
  ]

  // ------------------------------------------------------------- publications
  const publication = readJsonl("publication.jsonl")
  const PUBLICATION_KEYS = new Set([
    "v",
    "at",
    "instanceId",
    "pid",
    "attempt",
    "live",
    "sessionHash",
    "selector",
    "fence",
    "ready",
    "nonce",
    "cmd",
    "evt",
    "activity",
    "rpcOk",
    "durationMs",
    "code",
    "timestampProvenance",
    "modelProvenance",
  ])
  for (const record of publication) {
    for (const key of Object.keys(record)) if (!PUBLICATION_KEYS.has(key)) fail(`publication.jsonl has an unexpected key ${key}`)
    if (record.v !== 1) fail("publication record v must be 1")
    stringField(record, "at", "publication", ISO)
    stringField(record, "instanceId", "publication", UUID)
    numberField(record, "pid", "publication", true)
    if (!ATTEMPTS.has(String(record.attempt))) fail(`publication attempt has an invalid enum: ${String(record.attempt)}`)
    booleanField(record, "live", "publication")
    if (record.sessionHash !== undefined && (typeof record.sessionHash !== "string" || !HASH.test(record.sessionHash))) fail("publication.sessionHash must be a hash")
    if (record.selector !== undefined && !["route", "event"].includes(String(record.selector))) fail("publication.selector has an invalid enum")
    if (record.fence !== undefined) numberField(record, "fence", "publication", true)
    if (record.ready !== undefined) booleanField(record, "ready", "publication")
    if (record.nonce !== undefined && (typeof record.nonce !== "string" || !UUID.test(record.nonce))) fail("publication.nonce must be a UUID")
    if (record.cmd !== undefined && record.cmd !== "SET_ACTIVITY") fail("publication.cmd must be SET_ACTIVITY")
    if (record.evt !== undefined && record.evt !== null && record.evt !== "ERROR") fail("publication.evt must be null or ERROR")
    if (record.rpcOk !== undefined) booleanField(record, "rpcOk", "publication")
    if (record.durationMs !== undefined) numberField(record, "durationMs", "publication", true)
    if (record.code !== undefined && (typeof record.code !== "string" || !CODES.has(record.code))) fail("publication.code has an invalid enum")
    if (record.timestampProvenance !== undefined) {
      const provenance = record.timestampProvenance
      if (isObject(provenance) && "refusal" in provenance) {
        if (provenance.refusal !== "timestamp-unavailable") fail("timestamp refusal has an invalid enum")
      } else {
        const p = shape(provenance, "publication.timestampProvenance", ["seconds", "sourceField", "originalValue", "originalUnits", "conversion", "committed", "anchorCommitted"])
        if (p) {
          numberField(p, "seconds", "timestampProvenance", true)
          if (p.sourceField !== "session.message.list[].type=user.time.created") fail("timestampProvenance.sourceField is wrong")
          numberField(p, "originalValue", "timestampProvenance", true)
          if (p.originalUnits !== "milliseconds since Unix epoch") fail("timestampProvenance.originalUnits is wrong")
          if (p.conversion !== "floor(ms/1000)") fail("timestampProvenance.conversion is wrong")
          booleanField(p, "committed", "timestampProvenance")
          booleanField(p, "anchorCommitted", "timestampProvenance")
          if (typeof p.seconds === "number" && typeof p.originalValue === "number" && p.seconds !== Math.floor(p.originalValue / 1000)) {
            fail("timestampProvenance is not floor(originalValue / 1000)")
          }
        }
      }
    }
    if (record.modelProvenance !== undefined) {
      const model = shape(record.modelProvenance, "publication.modelProvenance", ["selected", "executed", "agent", "sessionCost", "reportedCost", "tokens"])
      if (model) {
        validateModel(model.selected, "modelProvenance.selected")
        validateModel(model.executed, "modelProvenance.executed")
        if (model.agent !== null) stringField(model, "agent", "modelProvenance")
        for (const key of ["sessionCost", "reportedCost"]) {
          if (model[key] !== null && (typeof model[key] !== "number" || !Number.isFinite(model[key]))) fail(`modelProvenance.${key} must be a number or null`)
        }
        validateTokens(model.tokens, "modelProvenance.tokens")
      }
    }
  }

  // -------------------------------------------------------- publisher timeline
  const publisherFiles = existsSync(dir) ? readdirSync(dir).filter((name) => /^publisher-[a-zA-Z0-9-]+\.jsonl$/.test(name)) : []
  if (publisherFiles.length < 2) fail(`expected publisher logs from two instances, found ${publisherFiles.length}`)
  const publisherEvents: Json[] = []
  for (const name of publisherFiles) {
    for (const record of readJsonl(name)) {
      const event = shape(record, name, ["v", "kind", "atMs", "instanceId", "pid", "generation"], ["fence", "previousFence", "reason", "code", "snapshotKind"])
      if (!event) continue
      if (event.v !== 1) fail(`${name}.v must be 1`)
      if (!PUBLISHER_KINDS.has(String(event.kind))) fail(`${name} has an invalid kind`)
      numberField(event, "atMs", name, true)
      stringField(event, "instanceId", name, UUID)
      numberField(event, "pid", name, true)
      stringField(event, "generation", name, UUID)
      if (event.fence !== undefined) numberField(event, "fence", name, true)
      if (event.previousFence !== undefined) numberField(event, "previousFence", name, true)
      if (event.reason !== undefined && !PUBLISHER_REASONS.has(String(event.reason))) fail(`${name}.reason has an invalid enum`)
      if (event.code !== undefined && !PUBLISHER_CODES.has(String(event.code))) fail(`${name}.code has an invalid enum`)
      if (event.kind === "snapshot" && !["startup-mid-task", "manual-snapshot"].includes(String(event.snapshotKind))) fail(`${name}.snapshotKind is invalid`)
      publisherEvents.push(event)
    }
  }
  publisherEvents.sort((a, b) => Number(a.atMs) - Number(b.atMs))

  interface Interval {
    instanceId: string
    fence: number
    start: number
    end: number
    revokedAt?: number
  }
  const intervals: Interval[] = []
  let current: { instanceId: string; fence: number; start: number } | null = null
  const ownerInstances = new Set<string>()
  let highestFence = 0
  for (const event of publisherEvents) {
    const kind = String(event.kind)
    const at = Number(event.atMs)
    const instanceId = String(event.instanceId)
    const fence = typeof event.fence === "number" ? event.fence : undefined
    if (kind === "acquire") {
      if (current) fail("overlapping owners: acquire while another owner is live")
      if (fence === undefined) fail("acquire without fence")
      else {
        if (fence <= highestFence) fail(`fence did not increase: ${fence} after ${highestFence}`)
        highestFence = Math.max(highestFence, fence)
        current = { instanceId, fence, start: at }
        ownerInstances.add(instanceId)
      }
    } else if (kind === "takeover") {
      if (!current) fail("takeover without a current owner")
      else {
        if (current.instanceId === instanceId) fail("takeover by the same owner")
        if (event.previousFence !== current.fence) fail("takeover previousFence does not match the current owner")
        if (fence === undefined || fence <= current.fence) fail("takeover did not move the fence forward")
        else {
          intervals.push({ instanceId: current.instanceId, fence: current.fence, start: current.start, end: at })
          current = { instanceId, fence, start: at }
          ownerInstances.add(instanceId)
          highestFence = Math.max(highestFence, fence)
        }
      }
    } else if (kind === "release") {
      if (!current) fail("release without a current owner")
      else if (current.instanceId !== instanceId || (fence !== undefined && current.fence !== fence)) fail("release by a non-owner or wrong fence")
      else {
        intervals.push({ instanceId, fence: current.fence, start: current.start, end: at })
        current = null
      }
    } else if (kind === "renew" || kind === "critical") {
      if (!current || current.instanceId !== instanceId || (fence !== undefined && current.fence !== fence)) fail(`${kind} by a non-owner or stale fence`)
    } else if (kind === "revoke") {
      const interval = intervals.find((entry) => entry.instanceId === instanceId && entry.fence === fence)
      if (interval) interval.revokedAt = at
      else if (current?.instanceId === instanceId && current.fence === fence) {
        intervals.push({ instanceId, fence, start: current.start, end: at, revokedAt: at })
        current = null
      } else fail("revoke does not match an ownership interval")
    }
  }
  if (current) intervals.push({ instanceId: current.instanceId, fence: current.fence, start: current.start, end: Number.POSITIVE_INFINITY })
  if (ownerInstances.size < 2) fail("fewer than two instances ever owned the lease")
  if (!publisherEvents.some((event) => event.kind === "takeover")) fail("no fenced takeover was observed")
  if (!publisherEvents.some((event) => event.kind === "revoke")) fail("no revoked owner was observed")
  const ownerAt = (at: number): Interval | null => intervals.find((interval) => interval.start <= at && at < interval.end) ?? null

  // ---------------------------------------------------------- write ownership
  const successes: Json[] = []
  for (const record of publication) {
    const attempt = String(record.attempt)
    const at = Date.parse(String(record.at))
    const nonce = typeof record.nonce === "string" ? record.nonce : undefined
    const isWrite = attempt === "command-publish" || attempt === "disconnect-command" || attempt === "disconnect"
    const refused = typeof record.code === "string"
    if (record.attempt === "cleanup") scenarios[10]!.ok = true
    if (attempt === "disconnect-command") scenarios[11]!.ok = true
    if (attempt === "ready") {
      if (record.ready !== true) fail("ready record does not assert readiness")
      continue
    }
    if (attempt === "cleanup" || attempt === "cleanup-close" || attempt === "socket-close" || attempt === "socket-error" || attempt === "revoked" || attempt === "coordination-start") continue
    if (!Number.isFinite(at)) {
      fail("publication record has an unparseable at")
      continue
    }
    if (refused && nonce) fail("a refused operation nevertheless enqueued a nonce")
    if (nonce) {
      const owner = ownerAt(at)
      if (!owner) fail(`SET_ACTIVITY at ${String(record.at)} was not inside an ownership interval`)
      else {
        if (owner.instanceId !== record.instanceId) fail("SET_ACTIVITY was enqueued by an instance that did not own the lease")
        if (owner.revokedAt !== undefined && at >= owner.revokedAt) fail("SET_ACTIVITY was enqueued by a revoked owner")
        if (typeof record.fence !== "number" || owner.fence !== record.fence) fail("SET_ACTIVITY fence does not match the owner's fence")
      }
      if (record.cmd !== "SET_ACTIVITY") fail("enqueued record is not SET_ACTIVITY")
    }
    if (record.rpcOk === true) {
      if (!nonce) fail("acknowledged SET_ACTIVITY has no nonce")
      if (record.evt !== null) fail("acknowledged SET_ACTIVITY did not have evt=null")
      if (!nonce || !isWrite) fail("acknowledgment is not attached to a publish/clear attempt")
      if (attempt === "command-publish") {
        if (!isObject(record.timestampProvenance) || "refusal" in record.timestampProvenance) fail("acknowledged write has no timestamp provenance")
        if (!isObject(record.modelProvenance)) fail("acknowledged write has no model provenance")
        const activity = isObject(record.activity) ? record.activity : null
        if (!activity) fail("acknowledged SET_ACTIVITY has no activity")
        else {
          const validation = validateActivity(activity)
          if (!validation.ok) fail(`published payload is not the fixed M0 payload: ${validation.problems.join("; ")}`)
        }
        if (typeof record.sessionHash !== "string") fail("acknowledged SET_ACTIVITY has no session identity")
        successes.push(record)
      } else if (attempt === "disconnect-command" && record.activity !== undefined) {
        fail("clear acknowledgment must not carry an activity")
      }
    }
  }
  if (!publication.some((record) => record.attempt === "ready" && record.ready === true)) fail("no READY handshake is recorded")
  if (successes.length < 5) fail(`expected at least five acknowledged SET_ACTIVITY writes, found ${successes.length}`)

  const bySession = new Map<string, Json[]>()
  for (const record of successes) {
    if (!isObject(record.timestampProvenance) || "refusal" in record.timestampProvenance) continue
    const sessionHash = String(record.sessionHash)
    const list = bySession.get(sessionHash) ?? []
    list.push(record)
    bySession.set(sessionHash, list)
    const activity = record.activity as Json
    const provenance = record.timestampProvenance
    if (!isObject(provenance) || "refusal" in provenance) {
      fail("acknowledged write has no timestamp provenance")
      continue
    }
    const start = isObject(activity.timestamps) ? activity.timestamps.start : undefined
    if (provenance.seconds !== start) fail("published timestamp does not match provenance")
    if (provenance.committed === true && provenance.anchorCommitted !== true) fail("a committed anchor was not marked committed on acknowledgment")
    if (provenance.committed === false && provenance.anchorCommitted !== true) fail("first acknowledged write did not commit its anchor")
    const model = isObject(activity.assets) ? activity.assets : null
    const modelProvenance = isObject(record.modelProvenance) ? record.modelProvenance : null
    const executed = modelProvenance && isObject(modelProvenance.executed) ? modelProvenance.executed : null
    if (!executed || typeof executed.providerID !== "string" || typeof executed.id !== "string") fail("acknowledged write lacks executed-model provenance")
    else if (model?.small_text !== `Model: ${executed.providerID}/${executed.id}`) fail("small_text does not match the executed model")
  }
  let hasFrozenRepeat = false
  for (const [sessionHash, group] of bySession) {
    const starts = new Set(group.map((record) => (record.timestampProvenance as Json).seconds))
    if (starts.size !== 1) fail(`session ${sessionHash} published more than one timestamp anchor`)
    const times = group.map((record) => Date.parse(String(record.at))).sort((a, b) => a - b)
    for (let i = 1; i < times.length; i += 1) {
      if ((times[i] as number) - (times[i - 1] as number) >= 4000) hasFrozenRepeat = true
    }
    const first = group.find((record) => (record.timestampProvenance as Json).committed === false)
    if (!first) notice(`session ${sessionHash} started from a stored anchor rather than a first successful publication`)
  }
  if (!hasFrozenRepeat) fail("no same-session repeat was at least 4 seconds apart")
  for (const record of successes) {
    if (record.attempt !== "disconnect-command" && record.activity === undefined) fail("successful publication has no activity")
  }

  // --------------------------------------------------------------- reconnect
  const reconnect =
    Object.values(perInstance).some((entry) => (entry.reference["server.connected"] ?? 0) >= 2) ||
    publication.some((record) => record.attempt === "socket-close") && publication.some((record) => record.attempt === "ready" && typeof record.instanceId === "string" && publication.some((close) => close.attempt === "socket-close" && close.instanceId === record.instanceId))
  if (!reconnect) fail("no reconnect evidence (same-instance server.connected twice or re-READY)")
  scenarios[13]!.ok = reconnect
  for (const scenario of scenarios) if (!scenario.ok) fail(`scenario not observed: ${scenario.name}`)
  report.scenarios = Object.fromEntries(scenarios.map((scenario) => [scenario.name, scenario.ok]))

  // ------------------------------------------------------------------ summary
  report.host = run?.host
  report.locality = locality
  report.canaries = { tokens: canaryTokens.length, filesScanned: scanned.length, leaked: leaked.length }
  report.fences = { intervals: intervals.length, highest: highestFence, instances: ownerInstances.size }
  report.publication = { attempts: publication.length, successful: successes.length, sessions: bySession.size }
  report.failures = failures
  report.notices = notices
  return { failures, notices, report }
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "")
  if (!process.argv[2] || !existsSync(dir)) {
    console.error("usage: bun run scripts/m0-evidence.ts <evidence-dir>")
    process.exit(2)
  }
  const result = validateEvidence(dir)
  console.log(JSON.stringify(result.report, null, 2))
  if (result.failures.length > 0) {
    console.error(`\nM0 evidence: FAIL (${result.failures.length})`)
    for (const failure of result.failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log("\nM0 evidence: PASS")
  for (const message of result.notices) console.log(`  note: ${message}`)
}
