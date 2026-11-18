// src/tui.tsx
import { randomUUID as randomUUID4 } from "node:crypto";
import { join as join4 } from "node:path";
import { tmpdir } from "node:os";
import { Plugin } from "@opencode/plugin/tui";

// src/m0/capture.ts
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/m0/probe.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, hostname, platform } from "node:os";

// src/discord/presence.ts
var CLIENT_ID = "1572459187873783838";
var M0_DETAILS = "M0 transmission test";
var M0_STATE = "M0 · events observed";
var M0_LARGE_IMAGE = "state-working";
var M0_LARGE_TEXT = "OpenCode — Working";
var M0_SMALL_IMAGE = "badge-model";
function buildActivity(model, timestampSeconds) {
  if (!Number.isSafeInteger(timestampSeconds)) {
    throw new Error(`timestamps.start must be an integer Unix second, got ${String(timestampSeconds)}`);
  }
  if (!model.providerID || !model.id) {
    throw new Error("model provider and id are required for small_text");
  }
  return {
    details: M0_DETAILS,
    state: M0_STATE,
    assets: {
      large_image: M0_LARGE_IMAGE,
      large_text: M0_LARGE_TEXT,
      small_image: M0_SMALL_IMAGE,
      small_text: `Model: ${model.providerID}/${model.id}`
    },
    timestamps: { start: timestampSeconds }
  };
}
function validateActivity(value) {
  const problems = [];
  if (!value || typeof value !== "object")
    return { ok: false, problems: ["activity is not an object"] };
  const activity = value;
  if (activity.details !== M0_DETAILS)
    problems.push(`details must be exactly ${JSON.stringify(M0_DETAILS)}`);
  if (activity.state !== M0_STATE)
    problems.push(`state must be exactly ${JSON.stringify(M0_STATE)}`);
  if ("largeImageKey" in activity || "smallImageKey" in activity)
    problems.push("non-native image key field present");
  const assets = activity.assets;
  if (!assets || typeof assets !== "object") {
    problems.push("assets is missing");
  } else {
    const record = assets;
    if (record.large_image !== M0_LARGE_IMAGE)
      problems.push(`assets.large_image must be ${M0_LARGE_IMAGE}`);
    if (record.large_text !== M0_LARGE_TEXT)
      problems.push(`assets.large_text must be ${M0_LARGE_TEXT}`);
    if (record.small_image !== M0_SMALL_IMAGE)
      problems.push(`assets.small_image must be ${M0_SMALL_IMAGE}`);
    if (typeof record.small_text !== "string" || !/^Model: [^/]+\/.+$/.test(record.small_text)) {
      problems.push("assets.small_text must read 'Model: <provider>/<model>'");
    }
  }
  const timestamps = activity.timestamps;
  if (!timestamps || typeof timestamps !== "object") {
    problems.push("timestamps is missing");
  } else {
    const start = timestamps.start;
    if (!Number.isSafeInteger(start))
      problems.push("timestamps.start must be an integer Unix second");
    else if (start < 1e9)
      problems.push("timestamps.start is not a plausible Unix second");
  }
  return { ok: problems.length === 0, problems };
}

// src/m0/sanitize.ts
var HASH = /^[0-9a-f]{16}$/;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
var VERSION = /^[0-9]+(\.[0-9]+){0,3}$/;
var MODEL_IDS = new Set(["deepseek-v4.1-flash", "deepseek-v4.1-flash-free"]);
var PROVIDER_IDS = new Set(["opencode", "opencode-go"]);
var VARIANTS = new Set(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
var BUILTIN_AGENTS = new Set(["build", "plan", "general", "compaction", "explore"]);
var AGENT_ID = /^[a-z][a-z0-9._-]{0,63}$/;
function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function safeModelID(value) {
  return typeof value === "string" && MODEL_IDS.has(value) ? value : null;
}
function safeProviderID(value) {
  return typeof value === "string" && PROVIDER_IDS.has(value) ? value : null;
}
function safeVariant(value) {
  return typeof value === "string" && VARIANTS.has(value) ? value : null;
}
function safeAgent(value) {
  if (typeof value !== "string")
    return null;
  if (BUILTIN_AGENTS.has(value))
    return value;
  return AGENT_ID.test(value) ? value : null;
}
function safeVersion(value) {
  return typeof value === "string" && VERSION.test(value) ? value : null;
}
function safeIso(value) {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}
function safeHash(value) {
  return typeof value === "string" && HASH.test(value) ? value : null;
}
function safeUuid(value) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}
function safeInt(value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function safeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}
function readModel(value) {
  const model = asObject(value);
  if (!model)
    return { ok: false, code: "executed-model-unknown" };
  const id = safeModelID(model.id);
  if (!id)
    return { ok: false, code: "executed-model-unknown" };
  const providerID = safeProviderID(model.providerID);
  if (!providerID)
    return { ok: false, code: "executed-provider-unknown" };
  if (model.variant === undefined || model.variant === null)
    return { ok: true, model: { id, providerID } };
  const variant = safeVariant(model.variant);
  if (!variant)
    return { ok: false, code: "executed-variant-unknown" };
  return { ok: true, model: { id, providerID, variant } };
}
function sanitizeModel(value) {
  const result = readModel(value);
  return result.ok ? result.model : null;
}
function sanitizeTokens(value) {
  const tokens = asObject(value);
  if (!tokens)
    return null;
  const input = safeInt(tokens.input, 0);
  const output = safeInt(tokens.output, 0);
  const reasoning = safeInt(tokens.reasoning, 0);
  const cacheRead = safeInt(tokens.cacheRead, 0);
  const cacheWrite = safeInt(tokens.cacheWrite, 0);
  if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null)
    return null;
  return { input, output, reasoning, cacheRead, cacheWrite };
}
var SESSION_ERROR_CODES = new Set([
  "session-sync-failed",
  "session-status-failed",
  "session-cost-failed",
  "model-selection-unavailable",
  "message-sync-failed"
]);
var STATUSES = ["idle", "running"];
var TIMESTAMP_ERRORS = ["timestamp-missing", "timestamp-invalid", "timestamp-implausible", "timestamp-future"];
function sanitizeInspection(value) {
  const inspection = asObject(value);
  if (!inspection)
    return null;
  const observedAt = safeIso(inspection.observedAt);
  const sessionIDHash = inspection.sessionIDHash === null ? null : safeHash(inspection.sessionIDHash);
  const found = typeof inspection.found === "boolean" ? inspection.found : null;
  const status = inspection.status === null ? null : safeEnum(inspection.status, STATUSES);
  const sessionCost = inspection.sessionCost === null ? null : safeNumber(inspection.sessionCost);
  const reportedCost = inspection.reportedCost === null ? null : safeNumber(inspection.reportedCost);
  const tokens = inspection.tokens === null ? null : sanitizeTokens(inspection.tokens);
  const selectedModel = inspection.selectedModel === null ? null : sanitizeModel(inspection.selectedModel);
  const executedModel = inspection.executedModel === null ? null : sanitizeModel(inspection.executedModel);
  const agent = inspection.agent === null ? null : safeAgent(inspection.agent);
  const messageCount = safeInt(inspection.messageCount, 0);
  const latestUserMessageAtMs = inspection.latestUserMessageAtMs === null ? null : safeInt(inspection.latestUserMessageAtMs, 1);
  const latestUserMessageSource = inspection.latestUserMessageSource === null ? null : inspection.latestUserMessageSource === "session.message.list[].type=user.time.created" ? inspection.latestUserMessageSource : null;
  const candidateTimestampSeconds = inspection.candidateTimestampSeconds === null ? null : safeInt(inspection.candidateTimestampSeconds, 1);
  const candidateTimestampError = inspection.candidateTimestampError === null ? null : safeEnum(inspection.candidateTimestampError, TIMESTAMP_ERRORS);
  const timestampOriginalUnits = inspection.timestampOriginalUnits === null ? null : inspection.timestampOriginalUnits === "milliseconds since Unix epoch (converted with floor(ms/1000))" ? inspection.timestampOriginalUnits : null;
  const errorCodes = Array.isArray(inspection.errorCodes) ? inspection.errorCodes.filter((code) => typeof code === "string" && SESSION_ERROR_CODES.has(code)) : [];
  if (observedAt === null || found === null || messageCount === null)
    return null;
  return {
    observedAt,
    sessionIDHash,
    found,
    status,
    sessionCost,
    reportedCost,
    tokens,
    selectedModel,
    executedModel,
    agent,
    messageCount,
    latestUserMessageAtMs,
    latestUserMessageSource,
    candidateTimestampSeconds,
    candidateTimestampError,
    timestampOriginalUnits,
    errorCodes
  };
}
var LOCALITY_CLASSES = ["local", "remote", "unknown"];
var ENRICHMENT = ["allowed", "refused"];
var LOCALITY_REASONS = ["host-and-urls-match", "host-mismatch", "url-not-loopback", "identity-incomplete", "server-info-unavailable"];
function sanitizeLocality(value) {
  const locality = asObject(value);
  if (!locality)
    return null;
  const klass = safeEnum(locality.class, LOCALITY_CLASSES);
  const enrichment = safeEnum(locality.enrichment, ENRICHMENT);
  const reason = safeEnum(locality.reason, LOCALITY_REASONS);
  const fingerprint = locality.serverFingerprint === null ? null : safeHash(locality.serverFingerprint);
  const observedAt = safeIso(locality.observedAt);
  const evidence = asObject(locality.evidence);
  if (!klass || !enrichment || !reason || !observedAt || !evidence)
    return null;
  if (klass !== "local" && enrichment !== "refused")
    return null;
  if (klass === "local" && (enrichment !== "allowed" || !fingerprint))
    return null;
  const method = safeEnum(evidence.method, ["server.info", "none"]);
  const hostnamePresent = safeBoolean(evidence.hostnamePresent);
  const hostnameMatches = evidence.hostnameMatches === null ? null : safeBoolean(evidence.hostnameMatches);
  const urlCount = safeInt(evidence.urlCount, 0);
  const allUrlsLoopback = evidence.allUrlsLoopback === null ? null : safeBoolean(evidence.allUrlsLoopback);
  if (!method || hostnamePresent === null || urlCount === null)
    return null;
  return {
    class: klass,
    enrichment,
    reason,
    serverFingerprint: fingerprint,
    evidence: { method, hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback },
    observedAt
  };
}
function sanitizeProbeStage(value, net) {
  const stage = asObject(value);
  if (!stage)
    return null;
  const ok = safeBoolean(stage.ok);
  if (ok === null)
    return null;
  const result = { ok };
  if (net) {
    const createConnection = safeBoolean(stage.createConnection);
    if (createConnection === null)
      return null;
    result.createConnection = createConnection;
  }
  if (stage.code !== undefined) {
    const code = safeEnum(stage.code, ["import-failed", "probe-failed", "select-mismatch"]);
    if (code)
      result.code = code;
  }
  if (stage.selectOne !== undefined) {
    const selectOne = safeInt(stage.selectOne);
    if (selectOne !== null)
      result.selectOne = selectOne;
  }
  return result;
}
function sanitizeProbe(value) {
  const probe = asObject(value);
  if (!probe)
    return null;
  const observedAt = safeIso(probe.observedAt);
  const host = asObject(probe.host);
  const imports = asObject(probe.imports);
  const sqlite = asObject(probe.sqlite);
  if (!observedAt || !host || !imports || !sqlite)
    return null;
  const version = safeVersion(host.version);
  const channel = safeEnum(host.channel, ["latest", "dev", "canary", "test", "unknown"]);
  const kind = safeEnum(host.kind, ["bun", "node", "unknown"]);
  const platform = safeEnum(host.platform, ["linux", "darwin", "win32", "freebsd", "openbsd", "unknown"]);
  const arch = safeEnum(host.arch, ["x64", "arm64", "arm", "ia32", "unknown"]);
  const pid = safeInt(host.pid, 0);
  if (!version || !channel || !kind || !platform || !arch || pid === null)
    return null;
  const safeHost = { version, channel, kind, platform, arch, pid };
  for (const key of ["bun", "node"]) {
    if (host[key] !== undefined) {
      const v = safeVersion(host[key]);
      if (v)
        safeHost[key] = v;
    }
  }
  const net = sanitizeProbeStage(imports.net, true);
  const bun = sanitizeProbeStage(imports["bun:sqlite"], false);
  const node = sanitizeProbeStage(imports["node:sqlite"], false);
  if (!net || !bun || !node)
    return null;
  const usable = safeBoolean(sqlite.usable);
  const sqliteKind = safeEnum(sqlite.kind, ["bun:sqlite", "node:sqlite"]);
  if (usable === null || !sqliteKind)
    return null;
  const safeSqlite = { usable, kind: sqliteKind };
  if (sqlite.selectOne !== undefined) {
    const selectOne = safeInt(sqlite.selectOne);
    if (selectOne !== null)
      safeSqlite.selectOne = selectOne;
  }
  return { observedAt, host: safeHost, imports: { net, "bun:sqlite": bun, "node:sqlite": node }, sqlite: safeSqlite };
}
function sanitizeRun(value) {
  const run = asObject(value);
  if (!run)
    return null;
  const runId = safeUuid(run.runId);
  const instanceId = safeUuid(run.instanceId);
  const startedAt = safeIso(run.startedAt);
  const probe = sanitizeProbe({ observedAt: run.startedAt, host: run.host, imports: run.imports, sqlite: run.sqlite });
  const locality = sanitizeLocality(run.locality);
  const options = asObject(run.options);
  if (!runId || !instanceId || !startedAt || !probe || !locality || !options)
    return null;
  const capture = safeBoolean(options.capture);
  const live = safeBoolean(options.live);
  const captureReference = safeBoolean(options.captureReference);
  if (capture === null || live === null || captureReference === null)
    return null;
  return {
    v: 1,
    runId,
    instanceId,
    pluginId: "opencode-presence-discord",
    packageVersion: "0.0.1",
    startedAt,
    host: probe.host,
    sqlite: probe.sqlite,
    imports: probe.imports,
    locality,
    options: { capture, live, captureReference },
    discordSocket: safeEnum(run.discordSocket, ["env", "default"]) ?? "default"
  };
}
function sanitizeAnchor(value) {
  const anchor = asObject(value);
  if (!anchor)
    return null;
  const seconds = safeInt(anchor.seconds, 1e9);
  const sourceCreatedMs = safeInt(anchor.sourceCreatedMs, 1);
  const committedMs = safeInt(anchor.committedMs, 0);
  if (seconds === null || sourceCreatedMs === null || committedMs === null || seconds !== Math.floor(sourceCreatedMs / 1000))
    return null;
  return { seconds, sourceCreatedMs, committedMs };
}
function sanitizeOwnerRow(value) {
  const row = asObject(value);
  if (!row)
    return null;
  const instanceId = safeUuid(row.instanceId);
  const pid = safeInt(row.pid, 0);
  const generation = safeUuid(row.generation);
  const fence = safeInt(row.fence, 0);
  const acquiredMs = safeInt(row.acquiredMs, 0);
  const heartbeatMs = safeInt(row.heartbeatMs, 0);
  if (!instanceId || pid === null || !generation || fence === null || acquiredMs === null || heartbeatMs === null)
    return null;
  return { instanceId, pid, generation, fence, acquiredMs, heartbeatMs };
}
function sanitizeAcquisition(value) {
  const acquisition = asObject(value);
  if (!acquisition)
    return null;
  const status = safeEnum(acquisition.status, ["acquired", "renewed", "takeover", "contended", "revoked", "error"]);
  if (!status)
    return null;
  const result = { status };
  if (acquisition.fence !== undefined) {
    const fence = safeInt(acquisition.fence, 0);
    if (fence !== null)
      result.fence = fence;
  }
  if (acquisition.code !== undefined) {
    const code = safeEnum(acquisition.code, ["store-unavailable", "closed", "contended", "acquire-failed", "renew-failed", "release-failed", "critical-failed"]);
    if (code)
      result.code = code;
  }
  if (acquisition.reason !== undefined) {
    const reason = safeEnum(acquisition.reason, ["fence-changed", "owner-row-gone", "release-fence-mismatch", "fence-mismatch"]);
    if (reason)
      result.reason = reason;
  }
  if (acquisition.previous !== undefined) {
    const previous = sanitizeOwnerRow(acquisition.previous);
    if (previous)
      result.previous = previous;
  }
  if (acquisition.owner !== undefined) {
    const owner = sanitizeOwnerRow(acquisition.owner);
    if (owner)
      result.owner = owner;
  }
  return result;
}
function sanitizeSnapshot(value) {
  const snapshot = asObject(value);
  if (!snapshot)
    return null;
  const at = safeIso(snapshot.at);
  const runId = safeUuid(snapshot.runId);
  const instanceId = safeUuid(snapshot.instanceId);
  const pid = safeInt(snapshot.pid, 0);
  const generation = safeUuid(snapshot.generation);
  const kind = safeEnum(snapshot.kind, ["startup-mid-task", "manual-snapshot"]);
  if (!at || !runId || !instanceId || pid === null || !generation || !kind)
    return null;
  const inspection = snapshot.inspection === null ? null : sanitizeInspection(snapshot.inspection);
  if (snapshot.inspection !== null && !inspection)
    return null;
  const selector = snapshot.selector === null ? null : asObject(snapshot.selector);
  const safeSelector = selector === null ? null : {
    reason: safeEnum(selector.reason, ["route", "event", "most-recent"]),
    sessionHash: safeHash(selector.sessionHash)
  };
  if (selector !== null && (!safeSelector?.reason || !safeSelector.sessionHash))
    return null;
  const anchor = snapshot.anchor === null ? null : sanitizeAnchor(snapshot.anchor);
  if (snapshot.anchor !== null && !anchor)
    return null;
  const ownership = asObject(snapshot.ownership);
  const safeOwnerRow = ownership && ownership.ownerRow !== null ? sanitizeOwnerRow(ownership.ownerRow) : null;
  const safeOwnership = ownership && !(ownership.ownerRow !== null && safeOwnerRow === null) ? {
    isOwner: safeBoolean(ownership.isOwner),
    fence: safeInt(ownership.fence, 0),
    revoked: safeBoolean(ownership.revoked),
    ownerRow: safeOwnerRow
  } : null;
  if (ownership && (safeOwnership?.isOwner === null || safeOwnership?.fence === null || safeOwnership?.revoked === null))
    return null;
  const acquisition = snapshot.acquisition === null ? null : sanitizeAcquisition(snapshot.acquisition);
  if (snapshot.acquisition !== null && !acquisition)
    return null;
  const locality = sanitizeLocality(snapshot.locality);
  const probe = sanitizeProbe(snapshot.probe);
  const captureEnabled = safeBoolean(snapshot.captureEnabled);
  const live = safeBoolean(snapshot.live);
  if (!locality || !probe || captureEnabled === null || live === null)
    return null;
  return {
    v: 1,
    kind,
    at,
    runId,
    instanceId,
    pid,
    generation,
    selector: safeSelector,
    inspection,
    anchor,
    ownership: safeOwnership,
    acquisition,
    locality,
    probe,
    captureEnabled,
    live
  };
}
var SELECTORS = ["route", "event"];
var ATTEMPTS = ["ready", "socket-close", "socket-error", "command-publish", "disconnect-command", "disconnect", "revoked", "cleanup", "cleanup-close", "coordination-start"];
var PHASES = ["lifecycle", "pre-enqueue", "enqueued", "post-enqueue", "acknowledged"];
var CODES = [
  "live-disabled",
  "identity-unknown",
  "no-coordinator",
  "no-observed-session",
  "session-unreadable",
  "executed-model-unknown",
  "executed-provider-unknown",
  "executed-variant-unknown",
  "executed-agent-unknown",
  "timestamp-unavailable",
  "payload-invalid",
  "anchor-conflict",
  "anchor-persist-failed",
  "not-owner",
  "connect-failed",
  "enqueue-busy",
  "enqueue-not-owner",
  "enqueue-revoked",
  "enqueue-no-store",
  "enqueue-error",
  "enqueue-rejected",
  "rpc-rejected",
  "rpc-timeout",
  "rpc-closed",
  "clear-refused",
  "no-socket",
  "socket-closed",
  "socket-error",
  "publisher-revoked",
  "cleanup"
];
function sanitizeTimestampProvenance(value) {
  const provenance = asObject(value);
  if (!provenance)
    return null;
  if (provenance.refusal !== undefined) {
    return provenance.refusal === "timestamp-unavailable" ? { refusal: "timestamp-unavailable" } : null;
  }
  const seconds = safeInt(provenance.seconds, 1e9);
  const originalValue = safeInt(provenance.originalValue, 1);
  const committed = safeBoolean(provenance.committed);
  const anchorCommitted = safeBoolean(provenance.anchorCommitted);
  if (seconds === null || originalValue === null || committed === null || anchorCommitted === null)
    return null;
  if (provenance.sourceField !== "session.message.list[].type=user.time.created")
    return null;
  if (provenance.originalUnits !== "milliseconds since Unix epoch")
    return null;
  if (provenance.conversion !== "floor(ms/1000)")
    return null;
  if (seconds !== Math.floor(originalValue / 1000))
    return null;
  return {
    seconds,
    sourceField: provenance.sourceField,
    originalValue,
    originalUnits: provenance.originalUnits,
    conversion: provenance.conversion,
    committed,
    anchorCommitted
  };
}
function sanitizeModelProvenance(value) {
  const model = asObject(value);
  if (!model)
    return null;
  return {
    selected: model.selected === null ? null : sanitizeModel(model.selected),
    executed: model.executed === null ? null : sanitizeModel(model.executed),
    agent: model.agent === null ? null : safeAgent(model.agent),
    sessionCost: model.sessionCost === null ? null : safeNumber(model.sessionCost),
    reportedCost: model.reportedCost === null ? null : safeNumber(model.reportedCost),
    tokens: model.tokens === null ? null : sanitizeTokens(model.tokens)
  };
}
function sanitizeActivity(value) {
  const validation = validateActivity(value);
  if (!validation.ok)
    return null;
  const activity = value;
  const assets = activity.assets;
  const timestamps = activity.timestamps;
  const match = typeof assets.small_text === "string" ? /^Model: ([^/]+)\/([^/]+)$/.exec(assets.small_text) : null;
  if (!match || !sanitizeModel({ providerID: match[1], id: match[2] }))
    return null;
  return {
    details: "M0 transmission test",
    state: "M0 · events observed",
    assets: {
      large_image: "state-working",
      large_text: "OpenCode — Working",
      small_image: "badge-model",
      small_text: assets.small_text
    },
    timestamps: { start: timestamps.start }
  };
}
function sanitizePublication(value) {
  const record = asObject(value);
  if (!record)
    return null;
  const at = safeIso(record.at);
  const instanceId = safeUuid(record.instanceId);
  const pid = safeInt(record.pid, 0);
  const attempt = safeEnum(record.attempt, ATTEMPTS);
  const phase = safeEnum(record.phase, PHASES);
  const live = safeBoolean(record.live);
  if (!at || !instanceId || pid === null || !attempt || !phase || live === null)
    return null;
  const result = { v: 1, at, instanceId, pid, attempt, phase, live };
  if (record.sessionHash !== undefined) {
    const hash = safeHash(record.sessionHash);
    if (!hash)
      return null;
    result.sessionHash = hash;
  }
  if (record.selector !== undefined) {
    const selector = safeEnum(record.selector, SELECTORS);
    if (!selector)
      return null;
    result.selector = selector;
  }
  if (record.fence !== undefined) {
    const fence = safeInt(record.fence, 0);
    if (fence === null)
      return null;
    result.fence = fence;
  }
  if (record.ready !== undefined) {
    const ready = safeBoolean(record.ready);
    if (ready === null)
      return null;
    result.ready = ready;
  }
  if (record.nonce !== undefined) {
    const nonce = safeUuid(record.nonce);
    if (!nonce)
      return null;
    result.nonce = nonce;
  }
  if (record.cmd !== undefined) {
    if (record.cmd !== "SET_ACTIVITY")
      return null;
    result.cmd = "SET_ACTIVITY";
  }
  if (record.evt !== undefined) {
    if (record.evt !== null && record.evt !== "ERROR")
      return null;
    result.evt = record.evt;
  }
  if (record.activity !== undefined) {
    const activity = sanitizeActivity(record.activity);
    if (!activity)
      return null;
    result.activity = activity;
  }
  if (record.rpcOk !== undefined) {
    const ok = safeBoolean(record.rpcOk);
    if (ok === null)
      return null;
    result.rpcOk = ok;
  }
  if (record.durationMs !== undefined) {
    const duration = safeInt(record.durationMs, 0);
    if (duration === null)
      return null;
    result.durationMs = duration;
  }
  if (record.code !== undefined) {
    const code = safeEnum(record.code, CODES);
    if (!code)
      return null;
    result.code = code;
  }
  if (record.timestampProvenance !== undefined) {
    const provenance = sanitizeTimestampProvenance(record.timestampProvenance);
    if (!provenance)
      return null;
    result.timestampProvenance = provenance;
  }
  if (record.modelProvenance !== undefined) {
    const model = sanitizeModelProvenance(record.modelProvenance);
    if (!model)
      return null;
    result.modelProvenance = model;
  }
  return result;
}
var PUBLISHER_KINDS = ["acquire", "renew", "takeover", "contended", "release", "revoke", "critical", "error", "snapshot", "cleanup"];
var PUBLISHER_ERRORS = ["store-unavailable", "closed", "contended", "acquire-failed", "renew-failed", "release-failed", "critical-failed"];
var PUBLISHER_REASONS = ["fence-changed", "owner-row-gone", "release-fence-mismatch", "fence-mismatch", "busy", "cleanup"];
function sanitizePublisherEvent(value) {
  const event = asObject(value);
  if (!event)
    return null;
  const kind = safeEnum(event.kind, PUBLISHER_KINDS);
  const atMs = safeInt(event.atMs, 0);
  const instanceId = safeUuid(event.instanceId);
  const pid = safeInt(event.pid, 0);
  const generation = safeUuid(event.generation);
  if (!kind || atMs === null || !instanceId || pid === null || !generation)
    return null;
  const result = { v: 1, kind, atMs, instanceId, pid, generation };
  if (event.fence !== undefined) {
    const fence = safeInt(event.fence, 0);
    if (fence !== null)
      result.fence = fence;
  }
  if (event.previousFence !== undefined) {
    const fence = safeInt(event.previousFence, 0);
    if (fence !== null)
      result.previousFence = fence;
  }
  if (event.reason !== undefined) {
    const reason = safeEnum(event.reason, PUBLISHER_REASONS);
    if (reason)
      result.reason = reason;
  }
  if (event.code !== undefined) {
    const code = safeEnum(event.code, PUBLISHER_ERRORS);
    if (code)
      result.code = code;
  }
  if (event.snapshotKind !== undefined) {
    const kindValue = safeEnum(event.snapshotKind, ["startup-mid-task", "manual-snapshot"]);
    if (kindValue)
      result.snapshotKind = kindValue;
  }
  return result;
}

// src/m0/probe.ts
async function importModule(specifier) {
  try {
    const mod = await import(specifier);
    return { ok: true, mod };
  } catch {
    return { ok: false, code: "import-failed" };
  }
}
function bunBackend(mod) {
  return {
    kind: "bun:sqlite",
    open(path) {
      const db = new mod.Database(path, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 50");
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...params) => {
          db.query(sql).run(...params);
        },
        get: (sql, ...params) => db.query(sql).get(...params),
        all: (sql, ...params) => db.query(sql).all(...params),
        close: () => db.close()
      };
    }
  };
}
function nodeBackend(mod) {
  return {
    kind: "node:sqlite",
    open(path) {
      const db = new mod.DatabaseSync(path);
      db.exec("PRAGMA busy_timeout = 50");
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...params) => {
          db.prepare(sql).run(...params);
        },
        get: (sql, ...params) => db.prepare(sql).get(...params),
        all: (sql, ...params) => db.prepare(sql).all(...params),
        close: () => db.close()
      };
    }
  };
}
function probeSqliteModule(kind, mod) {
  try {
    const backend = kind === "bun:sqlite" ? bunBackend(mod) : nodeBackend(mod);
    const db = backend.open(":memory:");
    try {
      db.exec("CREATE TABLE probe (value INTEGER NOT NULL)");
      db.run("INSERT INTO probe (value) VALUES (?)", 1);
      const row = db.get("SELECT value FROM probe LIMIT 1");
      return { ok: row?.value === 1, selectOne: row?.value, ...row?.value === 1 ? {} : { code: "select-mismatch" } };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, code: "probe-failed" };
  }
}
async function probeRuntime(context) {
  const netImport = await importModule("node:net");
  const netCreate = netImport.ok && typeof netImport.mod.createConnection === "function";
  const { backend, bun: bunStage, node: nodeStage } = await loadSqliteBackend();
  const versions = process.versions;
  const kind = versions.bun ? "bun" : versions.node ? "node" : "unknown";
  const report = {
    observedAt: new Date().toISOString(),
    host: {
      version: safeVersion(context.app?.version) ?? "0.0.0",
      channel: safeEnum(context.app?.channel, ["latest", "dev", "canary", "test"]) ?? "unknown",
      kind,
      ...versions.bun ? { bun: versions.bun } : {},
      ...versions.node ? { node: versions.node } : {},
      platform: platform(),
      arch: arch(),
      pid: process.pid
    },
    imports: {
      net: { ok: netImport.ok && netCreate, createConnection: netCreate, ...netImport.ok ? {} : { code: netImport.code } },
      "bun:sqlite": bunStage,
      "node:sqlite": nodeStage
    },
    sqlite: {
      usable: backend !== null,
      ...backend ? { kind: backend.kind } : {},
      ...bunStage.selectOne !== undefined ? { selectOne: bunStage.selectOne } : nodeStage.selectOne !== undefined ? { selectOne: nodeStage.selectOne } : {}
    }
  };
  return { report, backend };
}
async function loadSqliteBackend() {
  const bunImport = await importModule("bun:sqlite");
  const nodeSqliteImport = await importModule("node:sqlite");
  const bunStage = bunImport.ok ? probeSqliteModule("bun:sqlite", bunImport.mod) : { ok: false, code: bunImport.code };
  const nodeStage = nodeSqliteImport.ok ? probeSqliteModule("node:sqlite", nodeSqliteImport.mod) : { ok: false, code: nodeSqliteImport.code };
  if (bunStage.ok && bunImport.ok) {
    return { backend: bunBackend(bunImport.mod), bun: bunStage, node: nodeStage };
  }
  if (nodeStage.ok && nodeSqliteImport.ok) {
    return { backend: nodeBackend(nodeSqliteImport.mod), bun: bunStage, node: nodeStage };
  }
  return { backend: null, bun: bunStage, node: nodeStage };
}
function loadPseudonymSalt(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true, mode: 448 });
  const path = join(runtimeDir, "pseudonym.salt");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0)
      return existing;
  } catch {}
  try {
    writeFileSync(path, `${randomUUID()}
`, { mode: 384, flag: "wx" });
  } catch {}
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return randomUUID();
  }
}
function sessionAnchorKey(classification, sessionID) {
  if (classification.class !== "local" || typeof classification.serverFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(classification.serverFingerprint))
    return null;
  return createHash("sha256").update("local").update("\x00").update(classification.serverFingerprint).update("\x00").update(sessionID).digest("hex");
}
function pseudonym(salt, value) {
  return createHash("sha256").update(salt).update("\x00").update(value).digest("hex").slice(0, 16);
}
function localHostname() {
  return hostname();
}
function normalizeHostname(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
function isLoopbackHost(value) {
  const host = normalizeHostname(value).toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
function fingerprintIdentity(serverHostname, urls) {
  return createHash("sha256").update(serverHostname).update("\x00").update([...urls].sort().join("\x00")).digest("hex").slice(0, 16);
}
async function classifyLocality(context) {
  const local = normalizeHostname(localHostname());
  const observedAt = new Date().toISOString();
  const unknown = (reason, hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback) => ({
    class: "unknown",
    enrichment: "refused",
    reason,
    serverFingerprint: null,
    evidence: { method: reason === "server-info-unavailable" ? "none" : "server.info", hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback },
    observedAt
  });
  let info;
  try {
    info = await context.client.server.info({});
  } catch {
    return unknown("server-info-unavailable", false, null, 0, null);
  }
  const hostname = typeof info?.hostname === "string" && info.hostname.length > 0 && info.hostname === info.hostname.trim() ? info.hostname : null;
  const rawURLs = info?.urls;
  const hostnamePresent = hostname !== null;
  const hostnameMatches = hostname === null ? null : normalizeHostname(hostname).toLowerCase() === local.toLowerCase();
  const urlCount = Array.isArray(rawURLs) ? rawURLs.length : 0;
  const completeArray = Array.isArray(rawURLs) && rawURLs.length > 0;
  const entriesValid = completeArray && Array.from(rawURLs).every((entry) => typeof entry === "string" && entry.length > 0 && entry === entry.trim());
  const parsed = entriesValid ? rawURLs.map((entry) => {
    try {
      const url = new URL(entry);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }) : [];
  const allParsed = entriesValid && parsed.every((url) => url !== null);
  const allUrlsLoopback = allParsed ? parsed.every((url) => url !== null && isLoopbackHost(url.hostname)) : completeArray ? false : null;
  if (!hostnamePresent || !completeArray || !entriesValid || !allParsed) {
    return unknown("identity-incomplete", hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback);
  }
  if (hostnameMatches !== true || allUrlsLoopback !== true) {
    return {
      class: "remote",
      enrichment: "refused",
      reason: hostnameMatches !== true ? "host-mismatch" : "url-not-loopback",
      serverFingerprint: fingerprintIdentity(hostname, rawURLs),
      evidence: { method: "server.info", hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback },
      observedAt
    };
  }
  return {
    class: "local",
    enrichment: "allowed",
    reason: "host-and-urls-match",
    serverFingerprint: fingerprintIdentity(hostname, rawURLs),
    evidence: { method: "server.info", hostnamePresent, hostnameMatches, urlCount, allUrlsLoopback },
    observedAt
  };
}
function toUnixSeconds(createdMs) {
  if (createdMs === null)
    return { code: "timestamp-missing" };
  if (!Number.isFinite(createdMs) || createdMs <= 0)
    return { code: "timestamp-invalid" };
  const seconds = Math.floor(createdMs / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1e9)
    return { code: "timestamp-implausible" };
  if (seconds > Math.floor(Date.now() / 1000) + 300)
    return { code: "timestamp-future" };
  return { seconds };
}
async function inspectSession(context, sessionID, salt) {
  const errors = [];
  const inspection = {
    observedAt: new Date().toISOString(),
    sessionIDHash: pseudonym(salt, sessionID),
    found: false,
    status: null,
    sessionCost: null,
    reportedCost: null,
    tokens: null,
    selectedModel: null,
    executedModel: null,
    executedModelCode: null,
    agent: null,
    agentCode: null,
    messageCount: 0,
    latestUserMessageAtMs: null,
    latestUserMessageSource: null,
    candidateTimestampSeconds: null,
    candidateTimestampError: null,
    timestampOriginalUnits: null,
    errorCodes: errors
  };
  let info = context.data.session.get(sessionID);
  if (!info) {
    try {
      await context.data.session.sync(sessionID);
      info = context.data.session.get(sessionID);
    } catch {
      errors.push("session-sync-failed");
    }
  }
  if (!info) {
    errors.push("session.get returned no session");
    return inspection;
  }
  inspection.found = true;
  try {
    inspection.status = context.data.session.status(sessionID);
  } catch {
    errors.push("session-status-failed");
  }
  try {
    inspection.sessionCost = safeNumber(context.data.session.cost(sessionID));
  } catch {
    errors.push("session-cost-failed");
  }
  inspection.reportedCost = safeNumber(info.cost);
  if (info.tokens) {
    inspection.tokens = sanitizeTokens({
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cacheRead: info.tokens.cache.read,
      cacheWrite: info.tokens.cache.write
    });
  }
  try {
    const current = context.ui.model.current();
    if (current)
      inspection.selectedModel = sanitizeModel({ id: current.modelID, providerID: current.providerID, ...current.variant ? { variant: current.variant } : {} });
  } catch {
    errors.push("model-selection-unavailable");
  }
  if (!inspection.selectedModel && info.model) {
    inspection.selectedModel = sanitizeModel({ id: info.model.id, providerID: info.model.providerID, ...info.model.variant ? { variant: info.model.variant } : {} });
  }
  let messages = context.data.session.message.list(sessionID);
  if (messages.length === 0) {
    try {
      await context.data.session.message.sync(sessionID);
      messages = context.data.session.message.list(sessionID);
    } catch {
      errors.push("message-sync-failed");
    }
  }
  inspection.messageCount = messages.length;
  for (let index = messages.length - 1;index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type !== "assistant")
      continue;
    const executed = readModel(message.model);
    inspection.executedModel = executed.ok ? executed.model : null;
    inspection.executedModelCode = executed.ok ? null : executed.code;
    inspection.agent = safeAgent(message.agent);
    inspection.agentCode = inspection.agent === null ? "executed-agent-unknown" : null;
    break;
  }
  for (let index = messages.length - 1;index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type !== "user")
      continue;
    const created = safeInt(message.time?.created, 1);
    if (created !== null) {
      inspection.latestUserMessageAtMs = created;
      inspection.latestUserMessageSource = "session.message.list[].type=user.time.created";
    }
    break;
  }
  const timestamp = toUnixSeconds(inspection.latestUserMessageAtMs);
  if ("code" in timestamp) {
    inspection.candidateTimestampError = timestamp.code;
  } else {
    inspection.candidateTimestampSeconds = timestamp.seconds;
    inspection.timestampOriginalUnits = "milliseconds since Unix epoch (converted with floor(ms/1000))";
  }
  return inspection;
}
function currentSession(context, lastEventSession) {
  try {
    const route = context.ui.router.current();
    if (route.type === "session")
      return { sessionID: route.sessionID, reason: "route", updatedAt: Date.now() };
  } catch {}
  const sessions = context.data.session.list();
  const located = sessions.filter((session) => {
    if (!session.time.archived)
      return true;
    return false;
  });
  if (lastEventSession && located.some((session) => session.id === lastEventSession)) {
    return { sessionID: lastEventSession, reason: "event", updatedAt: Date.now() };
  }
  const mostRecent = located.sort((a, b) => b.time.updated - a.time.updated)[0];
  if (mostRecent)
    return { sessionID: mostRecent.id, reason: "most-recent", updatedAt: mostRecent.time.updated };
  return null;
}

// src/m0/capture.ts
var DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

class EvidenceLog {
  dir;
  runId;
  maxBytes;
  sinks = new Map;
  ready = null;
  closed = false;
  closing = null;
  constructor(options) {
    this.dir = options.dir;
    this.runId = options.runId;
    this.maxBytes = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  }
  init() {
    if (!this.ready) {
      this.ready = mkdir(this.dir, { recursive: true, mode: 448 }).then(() => {
        return;
      });
    }
    return this.ready;
  }
  async writeJson(name, value) {
    if (this.closed)
      return;
    const safe = projectEvidence(name, value);
    if (!safe)
      return;
    const file = this.guardName(name);
    const content = JSON.stringify(safe, null, 2) + `
`;
    const sink = this.sink(file);
    sink.chain = sink.chain.then(() => writeFile(join2(this.dir, file), content, { mode: 384 })).catch(() => {});
    await sink.chain;
  }
  append(name, entry) {
    if (this.closed)
      return;
    const safe = projectEvidence(name, entry);
    if (!safe)
      return;
    const file = this.guardName(name);
    let serialized;
    try {
      serialized = JSON.stringify(safe);
    } catch {
      return;
    }
    if (serialized === undefined)
      return;
    const line = serialized + `
`;
    const sink = this.sink(file);
    if (sink.bytes + Buffer.byteLength(line) > this.maxBytes) {
      sink.dropped += 1;
      if (!sink.overflowNoted) {
        sink.overflowNoted = true;
        const marker = JSON.stringify({ v: 1, atMs: Date.now(), type: "capture.overflow", file, maxBytes: this.maxBytes }) + `
`;
        sink.bytes += Buffer.byteLength(marker);
        sink.chain = sink.chain.then(() => this.appendRaw(file, marker)).catch(() => {});
      }
      return;
    }
    sink.bytes += Buffer.byteLength(line);
    sink.chain = sink.chain.then(() => this.appendRaw(file, line)).catch(() => {});
  }
  dropped(name) {
    return this.sinks.get(this.guardName(name))?.dropped ?? 0;
  }
  async close() {
    this.closed = true;
    this.closing ??= Promise.all([...this.sinks.values()].map((sink) => sink.chain)).then(() => {
      return;
    });
    await this.closing;
  }
  sink(file) {
    let sink = this.sinks.get(file);
    if (!sink) {
      sink = { chain: this.init(), bytes: 0, dropped: 0, overflowNoted: false };
      this.sinks.set(file, sink);
    }
    return sink;
  }
  appendRaw(file, line) {
    return appendFile(join2(this.dir, file), line, { mode: 384 });
  }
  guardName(name) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes(".."))
      throw new Error(`unsafe evidence file name: ${name}`);
    return name;
  }
}
var PRIMITIVE_TYPES = new Set(["string", "number", "boolean", "object", "array", "null"]);
var SAFE_PATH = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;
var KNOWN_TYPES = new Set([
  "agent.updated",
  "command.updated",
  "form.cancelled",
  "form.created",
  "form.replied",
  "integration.updated",
  "location.shutdown",
  "model.updated",
  "permission.asked",
  "permission.replied",
  "plugin.updated",
  "project.updated",
  "provider.updated",
  "reference.updated",
  "server.connected",
  "session.agent.selected",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.compaction.started",
  "session.created",
  "session.deleted",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.idle",
  "session.inbox.cancelled",
  "session.inbox.delivered",
  "session.inbox.delivery.changed",
  "session.inbox.enqueued",
  "session.instructions.updated",
  "session.message.content.updated",
  "session.metadata.updated",
  "session.model.selected",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.reasoning.started",
  "session.renamed",
  "session.retry.scheduled",
  "session.status",
  "session.step.ended",
  "session.step.failed",
  "session.step.first-token",
  "session.step.started",
  "session.step.streamed",
  "session.text.delta",
  "session.text.ended",
  "session.text.started",
  "session.tool.called",
  "session.tool.failed",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.input.started",
  "session.tool.progress",
  "session.tool.success",
  "session.usage.updated",
  "session.viewed",
  "shell.created",
  "shell.deleted",
  "shell.exited",
  "skill.updated",
  "websearch.updated"
]);
var EVENT_SHAPES = {
  "session.execution.started": ["data.sessionID"],
  "session.execution.succeeded": ["data.sessionID"],
  "session.execution.failed": ["data.sessionID"],
  "session.execution.interrupted": ["data.sessionID", "data.reason"],
  "session.idle": ["data.sessionID"],
  "session.status": ["data.sessionID", "data.status.type", "data.status.attempt"],
  "session.compaction.started": ["data.sessionID", "data.reason"],
  "session.compaction.ended": ["data.sessionID", "data.reason"],
  "session.compaction.failed": ["data.sessionID", "data.reason"],
  "session.retry.scheduled": ["data.sessionID", "data.attempt", "data.at"],
  "session.model.selected": ["data.sessionID", "data.model.providerID", "data.model.id"],
  "session.agent.selected": ["data.sessionID", "data.agentID"],
  "session.tool.called": ["data.sessionID", "data.executed"],
  "session.tool.success": ["data.sessionID", "data.executed"],
  "session.tool.failed": ["data.sessionID", "data.executed"],
  "permission.asked": ["data.id", "data.sessionID", "data.action"],
  "permission.replied": ["data.sessionID", "data.requestID", "data.reply.type"],
  "form.created": ["data.form.id", "data.form.sessionID"],
  "form.replied": ["data.id", "data.sessionID"],
  "form.cancelled": ["data.id", "data.sessionID"],
  "location.shutdown": [],
  "server.connected": []
};
var COMMON_SHAPE = ["id", "type", "created", "durable", "location", "data"];
var HASH2 = /^[0-9a-f]{16}$/;
var ERROR_CODES = new Set(["capture-start-failed", "capture-listen-failed", "capture-invalid", "snapshot-startup-failed"]);
function primitiveType(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  return typeof value;
}
function readPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return;
    current = current[part];
  }
  return current;
}
function structuralFields(event) {
  const type = typeof event.type === "string" ? event.type : "";
  const fields = [];
  for (const path of COMMON_SHAPE) {
    const value = readPath(event, path);
    if (value !== undefined)
      fields.push([path, primitiveType(value)]);
  }
  for (const path of EVENT_SHAPES[type] ?? []) {
    const value = readPath(event, path);
    if (value !== undefined)
      fields.push([path, primitiveType(value)]);
  }
  return fields;
}
function allowedValues(type, data) {
  const values = {};
  const status = data.status;
  const reply = data.reply;
  const model = data.model;
  if (type === "session.status") {
    if (status?.type === "idle" || status?.type === "retry")
      values.status = status.type;
    if (typeof status?.attempt === "number" && Number.isInteger(status.attempt) && status.attempt >= 0 && status.attempt <= 100)
      values.attempt = status.attempt;
  }
  if (type === "session.execution.interrupted" && ["user", "shutdown", "superseded", "inactivity"].includes(String(data.reason))) {
    values.reason = String(data.reason);
  }
  if ((type === "session.compaction.started" || type === "session.compaction.ended" || type === "session.compaction.failed") && ["auto", "manual"].includes(String(data.reason))) {
    values.reason = String(data.reason);
  }
  if (type === "session.retry.scheduled") {
    if (typeof data.attempt === "number" && Number.isInteger(data.attempt) && data.attempt >= 0 && data.attempt <= 100)
      values.attempt = data.attempt;
    if (typeof data.at === "number" && Number.isSafeInteger(data.at))
      values.at = data.at;
  }
  if (type === "permission.replied" && ["once", "always", "reject"].includes(String(reply?.type))) {
    values.reply = String(reply?.type);
  }
  if (type === "session.model.selected") {
    const providerID = safeProviderID(model?.providerID);
    const modelID = safeModelID(model?.id);
    if (providerID)
      values.providerID = providerID;
    if (modelID)
      values.modelID = modelID;
  }
  if (type === "session.agent.selected") {
    const agentID = safeAgent(data.agentID);
    if (agentID)
      values.agentID = agentID;
  }
  if ((type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") && typeof data.executed === "boolean") {
    values.executed = data.executed;
  }
  return values;
}
var VALUE_KEYS_BY_TYPE = {
  "session.status": ["status", "attempt"],
  "session.execution.interrupted": ["reason"],
  "session.compaction.started": ["reason"],
  "session.compaction.ended": ["reason"],
  "session.compaction.failed": ["reason"],
  "session.retry.scheduled": ["attempt", "at"],
  "permission.replied": ["reply"],
  "session.model.selected": ["providerID", "modelID"],
  "session.agent.selected": ["agentID"],
  "session.tool.called": ["executed"],
  "session.tool.success": ["executed"],
  "session.tool.failed": ["executed"]
};
var CAPTURE_KEYS = new Set(["v", "seq", "atMs", "source", "instanceId", "type", "eventIDHash", "sessionHash", "locationHash", "eventCreatedMs", "fields", "values"]);
var ERROR_KEYS = new Set(["v", "seq", "atMs", "source", "instanceId", "type", "code"]);
function validateCaptureRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value;
  if (record.v !== 1 || typeof record.atMs !== "number" || !Number.isSafeInteger(record.atMs))
    return false;
  if (record.source !== "listen" && record.source !== "subscribe")
    return false;
  if (!safeUuid(record.instanceId) && record.instanceId !== "instance")
    return false;
  if (typeof record.type !== "string")
    return false;
  if (ERROR_KEYS.has("code") && "code" in record) {
    for (const key of Object.keys(record))
      if (!ERROR_KEYS.has(key))
        return false;
    return record.seq === 0 && (ERROR_TYPES.has(record.type) || record.type === "event.other") && typeof record.code === "string" && ERROR_CODES.has(record.code);
  }
  if (!KNOWN_TYPES.has(record.type) && record.type !== "event.other")
    return false;
  for (const key of Object.keys(record))
    if (!CAPTURE_KEYS.has(key))
      return false;
  if (record.seq === undefined || typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 0)
    return false;
  for (const key of ["eventIDHash", "sessionHash", "locationHash"]) {
    const hash = record[key];
    if (hash !== null && (typeof hash !== "string" || !HASH2.test(hash)))
      return false;
  }
  if (record.eventCreatedMs !== null && (typeof record.eventCreatedMs !== "number" || !Number.isSafeInteger(record.eventCreatedMs)))
    return false;
  const allowedPaths = new Set([...COMMON_SHAPE, ...EVENT_SHAPES[record.type] ?? []]);
  if (!Array.isArray(record.fields))
    return false;
  for (const field of record.fields) {
    if (!Array.isArray(field) || field.length !== 2)
      return false;
    if (typeof field[0] !== "string" || !SAFE_PATH.test(field[0]) || !allowedPaths.has(field[0]))
      return false;
    if (typeof field[1] !== "string" || !PRIMITIVE_TYPES.has(field[1]))
      return false;
  }
  if (!record.values || typeof record.values !== "object" || Array.isArray(record.values))
    return false;
  const allowedValueKeys = new Set(VALUE_KEYS_BY_TYPE[record.type] ?? []);
  for (const [key, value] of Object.entries(record.values)) {
    if (!allowedValueKeys.has(key))
      return false;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      return false;
    if (typeof value === "number" && !Number.isFinite(value))
      return false;
    if (typeof value === "string" && key === "providerID" && !safeProviderID(value))
      return false;
    if (typeof value === "string" && key === "modelID" && !safeModelID(value))
      return false;
    if (typeof value === "string" && key === "agentID" && !safeAgent(value))
      return false;
    if (typeof value === "string" && key === "reason" && !["user", "shutdown", "superseded", "inactivity", "auto", "manual"].includes(value))
      return false;
    if (typeof value === "string" && key === "status" && !["idle", "retry"].includes(value))
      return false;
    if (typeof value === "string" && key === "reply" && !["once", "always", "reject"].includes(value))
      return false;
  }
  return true;
}
function captureEvent(event, source, seq, salt, now = Date.now(), instanceId = "instance") {
  if (!event || typeof event !== "object" || Array.isArray(event))
    return null;
  const record = event;
  if (typeof record.type !== "string" || record.type.length === 0)
    return null;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
  const form = data.form;
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : typeof form?.sessionID === "string" ? form.sessionID : null;
  const location = record.location;
  const eventID = typeof record.id === "string" ? record.id : null;
  const createdAt = typeof record.created === "number" && Number.isSafeInteger(record.created) ? record.created : null;
  const type = KNOWN_TYPES.has(record.type) ? record.type : "event.other";
  const captured = {
    v: 1,
    seq,
    atMs: now,
    source,
    instanceId,
    type,
    eventIDHash: eventID ? pseudonym(salt, eventID) : null,
    sessionHash: sessionID ? pseudonym(salt, sessionID) : null,
    locationHash: location && typeof location.directory === "string" ? pseudonym(salt, location.directory) : null,
    eventCreatedMs: createdAt,
    fields: structuralFields({ ...record, type }),
    values: allowedValues(type, data)
  };
  return validateCaptureRecord(captured) ? captured : null;
}
function referenceRecord(captured) {
  return {
    v: captured.v,
    seq: captured.seq,
    atMs: captured.atMs,
    source: captured.source,
    type: captured.type,
    eventIDHash: captured.eventIDHash,
    sessionHash: captured.sessionHash,
    locationHash: captured.locationHash,
    instanceId: captured.instanceId,
    eventCreatedMs: captured.eventCreatedMs
  };
}
function captureReference(event, seq, salt, now = Date.now(), instanceId = "instance") {
  const captured = captureEvent(event, "subscribe", seq, salt, now, instanceId);
  return captured ? referenceRecord(captured) : null;
}
var ERROR_TYPES = new Set(["command.registration.failed", "capture.start.failed", "capture.listen.error", "snapshot.startup.failed", "observer.error"]);
function errorRecord(type, code, instanceId, source = "listen") {
  const safeCode = ERROR_CODES.has(code) ? code : "capture-invalid";
  const safeType = ERROR_TYPES.has(type) ? type : "event.other";
  return { v: 1, seq: 0, atMs: Date.now(), source, instanceId: safeUuid(instanceId) ?? "instance", type: safeType, code: safeCode };
}
function projectEvidence(name, value) {
  if (name === "probe.json")
    return sanitizeProbe(value);
  if (name === "locality.json")
    return sanitizeLocality(value);
  if (name === "run.json")
    return sanitizeRun(value);
  if (name === "snapshot.json" || /^snapshot-[0-9a-f-]+\.json$/i.test(name))
    return sanitizeSnapshot(value);
  if (name === "publication.jsonl")
    return sanitizePublication(value);
  if (/^publisher-[0-9a-f-]+\.jsonl$/i.test(name))
    return sanitizePublisherEvent(value);
  if (name === "capture.jsonl" && validateCaptureRecord(value)) {
    if ("code" in value)
      return errorRecord(value.type, value.code, value.instanceId, value.source);
    return {
      v: 1,
      seq: value.seq,
      atMs: value.atMs,
      source: value.source,
      instanceId: value.instanceId,
      type: value.type,
      eventIDHash: value.eventIDHash,
      sessionHash: value.sessionHash,
      locationHash: value.locationHash,
      eventCreatedMs: value.eventCreatedMs,
      fields: value.fields.map(([path, type]) => [path, type]),
      values: Object.fromEntries(Object.entries(value.values))
    };
  }
  if (name === "reference.jsonl" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value;
    if (record.source !== "subscribe")
      return null;
    if ("code" in record) {
      const diagnostic = record;
      return validateCaptureRecord(diagnostic) && "code" in diagnostic ? errorRecord(diagnostic.type, diagnostic.code, diagnostic.instanceId, "subscribe") : null;
    }
    const allowed = new Set(["v", "seq", "atMs", "source", "instanceId", "type", "eventIDHash", "sessionHash", "locationHash", "eventCreatedMs"]);
    if (Object.keys(record).some((key) => !allowed.has(key)))
      return null;
    const full = { ...record, fields: [], values: {} };
    return validateCaptureRecord(full) ? referenceRecord(full) : null;
  }
  return null;
}
function startCapture(log, options) {
  let listenSeq = 0;
  let referenceSeq = 0;
  const abort = new AbortController;
  let stopped = false;
  const referenceTask = (async () => {
    if (!options.reference)
      return;
    try {
      for await (const event of options.context.client.event.subscribe({ signal: abort.signal })) {
        if (stopped)
          break;
        referenceSeq += 1;
        const record = captureReference(event, referenceSeq, options.salt, Date.now(), options.instanceId);
        if (record)
          log.append("reference.jsonl", record);
      }
    } catch {
      if (!stopped)
        log.append("reference.jsonl", errorRecord("observer.error", "capture-listen-failed", options.instanceId, "subscribe"));
    }
  })();
  return {
    onListen(event) {
      if (stopped)
        return;
      listenSeq += 1;
      const captured = captureEvent(event, "listen", listenSeq, options.salt, Date.now(), options.instanceId);
      if (captured)
        log.append("capture.jsonl", captured);
    },
    onReference(event) {
      if (stopped)
        return;
      referenceSeq += 1;
      const record = captureReference(event, referenceSeq, options.salt, Date.now(), options.instanceId);
      if (record)
        log.append("reference.jsonl", record);
    },
    notify(type, code) {
      if (stopped)
        return;
      log.append("capture.jsonl", errorRecord(type, code, options.instanceId));
    },
    referenceTask,
    stop() {
      stopped = true;
      abort.abort();
    },
    async flush() {
      await log.close();
    }
  };
}

// src/m0/publisher.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync as mkdirSync2, openSync, statSync } from "node:fs";
import { join as join3 } from "node:path";
var OWNER_COLUMNS = "instance_id, pid, generation, fence, acquired_ms, heartbeat_ms";
var SESSION_KEY = /^[0-9a-f]{64}$/;

class Publisher {
  identity;
  dbPath;
  options;
  db = null;
  storeReady = false;
  timer = null;
  owned = false;
  fence = 0;
  revoked = false;
  closed = false;
  paused = false;
  unpersisted = new Map;
  constructor(options) {
    this.options = {
      runtimeDir: options.runtimeDir,
      backend: options.backend,
      heartbeatMs: options.heartbeatMs ?? 2000,
      staleMs: options.staleMs ?? 1e4,
      tickMs: options.tickMs ?? 2000,
      now: options.now ?? Date.now,
      onEvent: options.onEvent,
      onRevoked: options.onRevoked
    };
    const identity = options.identity ?? { instanceId: randomUUID2(), pid: process.pid, generation: randomUUID2() };
    this.identity = { instanceId: identity.instanceId, pid: identity.pid, generation: identity.generation };
    this.dbPath = join3(options.runtimeDir, "publisher.sqlite");
  }
  get isOwner() {
    return this.owned && !this.revoked;
  }
  get currentFence() {
    return this.fence;
  }
  get isRevoked() {
    return this.revoked;
  }
  get isPaused() {
    return this.paused;
  }
  start() {
    if (this.closed)
      return { status: "error", code: "closed" };
    this.armTimer();
    if (!this.openStore())
      return { status: "error", code: "store-unavailable" };
    return this.tryAcquire();
  }
  tick() {
    if (this.closed || this.revoked || this.paused)
      return null;
    if (!this.openStore())
      return { status: "error", code: "store-unavailable" };
    this.retryPersistence();
    const result = this.owned ? this.renew() : this.tryAcquire();
    if (result.status === "revoked")
      this.revoke(result.reason);
    return result;
  }
  criticalPublish(sessionKey, intended, enqueue) {
    if (!SESSION_KEY.test(sessionKey))
      return { ok: false, reason: "anchor-conflict" };
    if (!Number.isSafeInteger(intended.seconds) || intended.seconds < 1e9 || !Number.isSafeInteger(intended.sourceCreatedMs) || intended.seconds !== Math.floor(intended.sourceCreatedMs / 1000)) {
      return { ok: false, reason: "anchor-conflict" };
    }
    if (!this.storeReady || !this.db)
      return { ok: false, reason: "no-store" };
    if (this.revoked || this.closed)
      return { ok: false, reason: "revoked" };
    const acknowledged = this.unpersisted.get(sessionKey);
    if (acknowledged && (acknowledged.seconds !== intended.seconds || acknowledged.sourceCreatedMs !== intended.sourceCreatedMs))
      return { ok: false, reason: "anchor-conflict" };
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      return { ok: false, reason: "busy" };
    }
    try {
      const owner = this.readOwner();
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK");
        this.emit({ kind: "critical", reason: "fence-mismatch", fence: owner?.fence });
        this.revoke("fence-mismatch");
        return { ok: false, reason: "not-owner" };
      }
      const committed = this.readAnchorRow(sessionKey);
      const pending = this.readPendingRow(sessionKey);
      if (committed && (committed.seconds !== intended.seconds || committed.sourceCreatedMs !== intended.sourceCreatedMs)) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "anchor-conflict" };
      }
      if (pending && (pending.seconds !== intended.seconds || pending.sourceCreatedMs !== intended.sourceCreatedMs)) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "anchor-pending" };
      }
      if (!committed && !pending) {
        this.db.run("INSERT INTO anchor_pending (session_key, seconds, source_created_ms, intent_ms) VALUES (?, ?, ?, ?)", sessionKey, intended.seconds, intended.sourceCreatedMs, this.options.now());
      }
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.emit({ kind: "error", code: "critical-failed" });
      return { ok: false, reason: "error" };
    }
    return this.criticalEnqueue(() => {
      const committed = this.readAnchorRow(sessionKey);
      const pending = this.readPendingRow(sessionKey);
      if (!committed && !pending || [committed, pending].some((row) => row && (row.seconds !== intended.seconds || row.sourceCreatedMs !== intended.sourceCreatedMs))) {
        throw new Error("anchor conflict");
      }
      return enqueue();
    });
  }
  criticalEnqueue(enqueue) {
    if (!this.storeReady || !this.db)
      return { ok: false, reason: "no-store" };
    if (this.revoked || this.closed)
      return { ok: false, reason: "revoked" };
    let enqueued = null;
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      return { ok: false, reason: "busy" };
    }
    try {
      const owner = this.readOwner();
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK");
        this.emit({ kind: "critical", reason: "fence-mismatch", fence: owner?.fence });
        this.revoke("fence-mismatch");
        return { ok: false, reason: "not-owner" };
      }
      this.db.run("UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1 AND instance_id = ? AND fence = ?", this.options.now(), this.identity.instanceId, this.fence);
      const value = enqueue();
      enqueued = { value };
      this.db.exec("COMMIT");
      this.emit({ kind: "critical", fence: this.fence });
      return { ok: true, value, fence: this.fence };
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.emit({ kind: "error", code: "critical-failed" });
      if (enqueued) {
        this.emit({ kind: "critical", fence: this.fence });
        return { ok: true, value: enqueued.value, fence: this.fence };
      }
      return { ok: false, reason: "error" };
    }
  }
  release() {
    if (!this.storeReady || !this.db || !this.owned || this.revoked) {
      this.disarmTimer();
      return false;
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const owner = this.readOwner();
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK");
        this.revoke("release-fence-mismatch");
        return false;
      }
      this.db.run("DELETE FROM owner WHERE singleton = 1 AND instance_id = ? AND fence = ?", this.identity.instanceId, this.fence);
      this.db.exec("COMMIT");
      this.emit({ kind: "release", fence: this.fence });
      this.owned = false;
      this.paused = true;
      this.disarmTimer();
      return true;
    } catch {
      this.emit({ kind: "error", code: "release-failed" });
      return false;
    }
  }
  resume() {
    if (this.closed || this.revoked)
      return null;
    if (!this.openStore())
      return { status: "error", code: "store-unavailable" };
    this.paused = false;
    this.armTimer();
    return this.owned ? this.renew() : this.tryAcquire();
  }
  stop() {
    if (this.closed)
      return;
    this.disarmTimer();
    if (this.owned && !this.revoked)
      this.release();
    this.closed = true;
    this.storeReady = false;
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }
  ownerSnapshot() {
    if (!this.storeReady || !this.db)
      return null;
    try {
      return this.readOwner();
    } catch {
      return null;
    }
  }
  readAnchor(sessionKey) {
    if (!SESSION_KEY.test(sessionKey) || !this.openStore() || !this.db)
      return null;
    try {
      return this.readAnchorRow(sessionKey);
    } catch {
      return null;
    }
  }
  readAnchorState(sessionKey) {
    if (!SESSION_KEY.test(sessionKey) || !this.openStore() || !this.db) {
      return { committed: null, pending: null, acknowledgedUnpersisted: null };
    }
    try {
      return {
        committed: this.readAnchorRow(sessionKey),
        pending: this.readPendingRow(sessionKey),
        acknowledgedUnpersisted: this.unpersisted.get(sessionKey) ?? null
      };
    } catch {
      return { committed: null, pending: null, acknowledgedUnpersisted: this.unpersisted.get(sessionKey) ?? null };
    }
  }
  markAcknowledged(sessionKey, seconds, sourceCreatedMs) {
    if (!SESSION_KEY.test(sessionKey))
      return { ok: false, code: "anchor-persist-failed" };
    if (!Number.isSafeInteger(seconds) || seconds < 1e9 || !Number.isSafeInteger(sourceCreatedMs) || seconds !== Math.floor(sourceCreatedMs / 1000)) {
      return { ok: false, code: "anchor-persist-failed" };
    }
    const existing = this.unpersisted.get(sessionKey);
    if (existing && (existing.seconds !== seconds || existing.sourceCreatedMs !== sourceCreatedMs))
      return { ok: false, code: "anchor-conflict" };
    this.unpersisted.set(sessionKey, { seconds, sourceCreatedMs });
    return this.persistAcknowledged(sessionKey);
  }
  persistAcknowledged(sessionKey) {
    const acknowledged = this.unpersisted.get(sessionKey);
    if (!acknowledged)
      return { ok: false, code: "anchor-persist-failed" };
    if (!this.openStore() || !this.db)
      return { ok: false, code: "anchor-persist-failed" };
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      return { ok: false, code: "anchor-persist-failed" };
    }
    try {
      const committed = this.readAnchorRow(sessionKey);
      const pending = this.readPendingRow(sessionKey);
      if (pending && (pending.seconds !== acknowledged.seconds || pending.sourceCreatedMs !== acknowledged.sourceCreatedMs)) {
        this.db.exec("ROLLBACK");
        return { ok: false, code: "anchor-conflict" };
      }
      if (committed) {
        if (committed.seconds !== acknowledged.seconds || committed.sourceCreatedMs !== acknowledged.sourceCreatedMs) {
          this.db.exec("ROLLBACK");
          return { ok: false, code: "anchor-conflict" };
        }
        this.db.run("DELETE FROM anchor_pending WHERE session_key = ?", sessionKey);
        this.db.exec("COMMIT");
        this.unpersisted.delete(sessionKey);
        return { ok: true, stored: committed };
      }
      this.db.run("INSERT INTO anchor (session_key, seconds, source_created_ms, committed_ms) VALUES (?, ?, ?, ?)", sessionKey, acknowledged.seconds, acknowledged.sourceCreatedMs, this.options.now());
      const stored = this.readAnchorRow(sessionKey);
      if (!stored || stored.seconds !== acknowledged.seconds || stored.sourceCreatedMs !== acknowledged.sourceCreatedMs) {
        this.db.exec("ROLLBACK");
        return { ok: false, code: "anchor-persist-failed" };
      }
      this.db.run("DELETE FROM anchor_pending WHERE session_key = ?", sessionKey);
      this.db.exec("COMMIT");
      this.unpersisted.delete(sessionKey);
      return { ok: true, stored };
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      return { ok: false, code: "anchor-persist-failed" };
    }
  }
  retryPersistence() {
    for (const key of [...this.unpersisted.keys()])
      this.persistAcknowledged(key);
  }
  readAnchorRow(sessionKey) {
    if (!this.db)
      return null;
    const row = this.db.get("SELECT seconds, source_created_ms, committed_ms FROM anchor WHERE session_key = ?", sessionKey);
    if (!row || !Number.isSafeInteger(row.seconds) || !Number.isSafeInteger(row.source_created_ms))
      return null;
    return { seconds: row.seconds, sourceCreatedMs: row.source_created_ms, committedMs: row.committed_ms };
  }
  readPendingRow(sessionKey) {
    if (!this.db)
      return null;
    const row = this.db.get("SELECT seconds, source_created_ms, intent_ms FROM anchor_pending WHERE session_key = ?", sessionKey);
    if (!row || !Number.isSafeInteger(row.seconds) || !Number.isSafeInteger(row.source_created_ms))
      return null;
    return { seconds: row.seconds, sourceCreatedMs: row.source_created_ms, intentMs: row.intent_ms };
  }
  openStore() {
    if (this.storeReady && this.db)
      return true;
    if (this.closed)
      return false;
    try {
      this.prepareRuntimeDir();
      this.db = this.options.backend.open(this.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.initSchema();
      this.storeReady = true;
      return true;
    } catch {
      try {
        this.db?.close();
      } catch {}
      this.db = null;
      this.storeReady = false;
      this.emit({ kind: "error", code: "store-unavailable" });
      return false;
    }
  }
  prepareRuntimeDir() {
    mkdirSync2(this.options.runtimeDir, { recursive: true, mode: 448 });
    const stat = lstatSync(this.options.runtimeDir);
    if (stat.isSymbolicLink())
      throw new Error("unsafe runtime dir");
    if (!stat.isDirectory())
      throw new Error("unsafe runtime dir");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid)
      throw new Error("unsafe runtime dir ownership");
    if ((stat.mode & 63) !== 0) {
      chmodSync(this.options.runtimeDir, 448);
      const tightened = statSync(this.options.runtimeDir);
      if ((tightened.mode & 63) !== 0)
        throw new Error("unsafe runtime dir mode");
    }
    try {
      const dbStat = lstatSync(this.dbPath);
      if (dbStat.isSymbolicLink())
        throw new Error("unsafe coordination file");
      if (!dbStat.isFile())
        throw new Error("unsafe coordination file");
      if (uid !== undefined && dbStat.uid !== uid)
        throw new Error("unsafe coordination ownership");
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT")
        throw error;
      const fd = openSync(this.dbPath, "wx", 384);
      closeSync(fd);
    }
  }
  initSchema() {
    if (!this.db)
      throw new Error("no db");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        generation TEXT NOT NULL,
        fence INTEGER NOT NULL,
        acquired_ms INTEGER NOT NULL,
        heartbeat_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor (
        session_key TEXT PRIMARY KEY,
        seconds INTEGER NOT NULL,
        source_created_ms INTEGER NOT NULL,
        committed_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor_pending (
        session_key TEXT PRIMARY KEY,
        seconds INTEGER NOT NULL,
        source_created_ms INTEGER NOT NULL,
        intent_ms INTEGER NOT NULL
      );
    `);
    this.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", "fence", "0");
  }
  armTimer() {
    this.disarmTimer();
    this.timer = setInterval(() => {
      this.tick();
    }, this.options.tickMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      this.timer.unref?.();
    }
  }
  disarmTimer() {
    if (this.timer)
      clearInterval(this.timer);
    this.timer = null;
  }
  tryAcquire() {
    if (!this.db)
      return { status: "error", code: "store-unavailable" };
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      this.emit({ kind: "contended", reason: "busy" });
      return { status: "contended", fence: -1, owner: { instanceId: "", pid: 0, generation: "", fence: -1, acquiredMs: 0, heartbeatMs: 0 } };
    }
    try {
      const now = this.options.now();
      const owner = this.readOwner();
      if (!owner) {
        const fence = this.nextFence();
        this.db.run(`INSERT INTO owner (singleton, ${OWNER_COLUMNS}) VALUES (1, ?, ?, ?, ?, ?, ?)`, this.identity.instanceId, this.identity.pid, this.identity.generation, fence, now, now);
        this.db.exec("COMMIT");
        this.owned = true;
        this.fence = fence;
        this.emit({ kind: "acquire", fence });
        return { status: "acquired", fence };
      }
      if (owner.instanceId === this.identity.instanceId && owner.generation === this.identity.generation) {
        this.db.run("UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1", now);
        this.db.exec("COMMIT");
        this.owned = true;
        this.fence = owner.fence;
        this.emit({ kind: "renew", fence: owner.fence });
        return { status: "renewed", fence: owner.fence };
      }
      if (now - owner.heartbeatMs >= this.options.staleMs) {
        const fence = this.nextFence();
        this.db.run("UPDATE owner SET instance_id = ?, pid = ?, generation = ?, fence = ?, acquired_ms = ?, heartbeat_ms = ? WHERE singleton = 1", this.identity.instanceId, this.identity.pid, this.identity.generation, fence, now, now);
        this.db.exec("COMMIT");
        this.owned = true;
        this.fence = fence;
        this.emit({ kind: "takeover", fence, previousFence: owner.fence });
        return { status: "takeover", fence, previous: owner };
      }
      this.db.exec("COMMIT");
      this.owned = false;
      this.emit({ kind: "contended", fence: owner.fence });
      return { status: "contended", fence: owner.fence, owner };
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.emit({ kind: "error", code: "acquire-failed" });
      return { status: "error", code: "acquire-failed" };
    }
  }
  renew() {
    if (!this.db)
      return { status: "error", code: "store-unavailable" };
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      return { status: "error", code: "contended" };
    }
    try {
      const owner = this.readOwner();
      if (!this.matches(owner)) {
        this.db.exec("ROLLBACK");
        return { status: "revoked", reason: owner ? "fence-changed" : "owner-row-gone" };
      }
      this.db.run("UPDATE owner SET heartbeat_ms = ? WHERE singleton = 1", this.options.now());
      this.db.exec("COMMIT");
      this.emit({ kind: "renew", fence: this.fence });
      return { status: "renewed", fence: this.fence };
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.emit({ kind: "error", code: "renew-failed" });
      return { status: "error", code: "renew-failed" };
    }
  }
  revoke(reason) {
    if (this.revoked)
      return;
    this.revoked = true;
    this.owned = false;
    this.disarmTimer();
    this.emit({ kind: "revoke", reason, fence: this.fence });
    try {
      this.options.onRevoked?.(reason);
    } catch {}
  }
  readOwner() {
    if (!this.db)
      return null;
    const row = this.db.get(`SELECT ${OWNER_COLUMNS} FROM owner WHERE singleton = 1`);
    if (!row)
      return null;
    return {
      instanceId: row.instance_id,
      pid: row.pid,
      generation: row.generation,
      fence: row.fence,
      acquiredMs: row.acquired_ms,
      heartbeatMs: row.heartbeat_ms
    };
  }
  matches(owner) {
    return owner !== null && owner.instanceId === this.identity.instanceId && owner.generation === this.identity.generation && owner.fence === this.fence;
  }
  nextFence() {
    if (!this.db)
      throw new Error("no db");
    const row = this.db.get("SELECT value FROM meta WHERE key = ?", "fence");
    const current = row ? Number.parseInt(row.value, 10) : 0;
    const fence = (Number.isFinite(current) ? current : 0) + 1;
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "fence", String(fence));
    return fence;
  }
  emit(event) {
    const full = {
      ...event,
      atMs: this.options.now(),
      instanceId: this.identity.instanceId,
      pid: this.identity.pid,
      generation: this.identity.generation
    };
    try {
      this.options.onEvent?.(full);
    } catch {}
  }
}

// src/discord/ipc.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { createConnection } from "node:net";
var OPCODE = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
};

class DiscordIpcError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "DiscordIpcError";
    this.code = code;
  }
}
function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(opcode, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

class FrameDecoder {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > 4 * 1024 * 1024)
        throw new DiscordIpcError(`frame length ${length} exceeds the M0 bound`);
      if (this.buffer.length < 8 + length)
        break;
      const body = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        throw new DiscordIpcError("frame body is not valid JSON");
      }
      frames.push({ opcode, payload });
    }
    return frames;
  }
  get pendingBytes() {
    return this.buffer.length;
  }
}

class DiscordIpc {
  path;
  options;
  socket = null;
  decoder = new FrameDecoder;
  pending = new Map;
  ready = false;
  closed = false;
  closeReason = null;
  readyResolve = null;
  readyReject = null;
  closeNotified = false;
  constructor(options) {
    this.path = options.path;
    this.options = {
      clientId: options.clientId,
      connectTimeoutMs: options.connectTimeoutMs ?? 5000,
      responseTimeoutMs: options.responseTimeoutMs ?? 5000,
      onClose: options.onClose,
      onError: options.onError
    };
  }
  get isReady() {
    return this.ready && !this.closed;
  }
  get isClosed() {
    return this.closed;
  }
  get pendingRpcCount() {
    return this.pending.size;
  }
  async connect() {
    if (this.socket)
      throw new DiscordIpcError("connection already started");
    this.closed = false;
    this.closeReason = null;
    this.ready = false;
    this.decoder = new FrameDecoder;
    const socket = createConnection(this.path);
    this.socket = socket;
    socket.setNoDelay(true);
    const readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(() => {
      this.fail(new DiscordIpcError(`Discord IPC did not become READY within ${this.options.connectTimeoutMs}ms`, "ETIMEDOUT"));
      socket.destroy();
    }, this.options.connectTimeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      timer.unref?.();
    }
    socket.on("connect", () => {
      this.writeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: this.options.clientId });
    });
    socket.on("data", (chunk) => {
      this.handleData(chunk);
    });
    socket.on("error", (error) => {
      this.fail(error);
    });
    socket.on("close", () => {
      this.fail(new DiscordIpcError(this.closeReason ?? "Discord IPC socket closed", "ECLOSED"));
    });
    try {
      await readyPromise;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (!this.ready)
      throw new DiscordIpcError(this.closeReason ?? "Discord IPC closed before READY", "ECLOSED");
  }
  enqueueSetActivity(pid, activity) {
    return this.enqueue("SET_ACTIVITY", { pid, activity });
  }
  enqueueClearActivity(pid) {
    return this.enqueue("SET_ACTIVITY", { pid });
  }
  enqueue(cmd, args) {
    if (!this.ready || !this.socket || this.closed)
      throw new DiscordIpcError("Discord IPC is not ready", "ENOTREADY");
    const nonce = randomUUID3();
    const payload = { cmd, args, nonce };
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new DiscordIpcError(`no RPC response for ${cmd} within ${this.options.responseTimeoutMs}ms`, "ETIMEDOUT"));
      }, this.options.responseTimeoutMs);
      if (typeof timer === "object" && timer && "unref" in timer) {
        timer.unref?.();
      }
      this.pending.set(nonce, { resolve, reject, timer, cmd });
    });
    reply.catch(() => {});
    this.writeFrame(OPCODE.FRAME, payload);
    return { nonce, reply };
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    this.ready = false;
    const error = new DiscordIpcError("Discord IPC closed locally", "ECLOSED");
    this.settleReady(error);
    this.failPending(error);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners("close");
      socket.destroy();
    }
    this.onClosed("closed locally");
  }
  destroy(reason) {
    if (this.closed)
      return;
    this.closed = true;
    this.ready = false;
    const error = new DiscordIpcError(reason, "ECLOSED");
    this.settleReady(error);
    this.failPending(error);
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.onClosed(reason);
  }
  writeFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed)
      throw new DiscordIpcError("Discord IPC socket is gone", "ECLOSED");
    this.socket.write(encodeFrame(opcode, payload));
  }
  handleData(chunk) {
    if (this.closed)
      return;
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.socket?.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === OPCODE.PING) {
        try {
          this.writeFrame(OPCODE.PONG, frame.payload);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      if (frame.opcode === OPCODE.PONG)
        continue;
      if (frame.opcode === OPCODE.CLOSE) {
        const reason = describePayload(frame.payload) ?? "Discord sent CLOSE";
        this.closeReason = reason;
        this.ready = false;
        this.failPending(new DiscordIpcError(reason, "ECLOSED"));
        this.socket?.destroy();
        continue;
      }
      if (frame.opcode !== OPCODE.FRAME)
        continue;
      this.handleFrame(frame.payload);
    }
  }
  handleFrame(payload) {
    if (!payload || typeof payload !== "object")
      return;
    const message = payload;
    if (message.evt === "READY" && message.cmd === "DISPATCH" && !message.nonce) {
      this.ready = true;
      this.readyResolve?.();
      return;
    }
    if (message.evt === "ERROR") {
      const error = new DiscordIpcError(`Discord RPC error: ${describeError(message.data)}`, "ERPC");
      if (message.nonce) {
        this.rejectNonce(message.nonce, error);
      } else {
        this.options.onError?.(error);
      }
      return;
    }
    if (message.nonce) {
      const pending = this.pending.get(message.nonce);
      if (pending && message.cmd === pending.cmd && message.evt === null) {
        this.pending.delete(message.nonce);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  }
  rejectNonce(nonce, error) {
    const pending = this.pending.get(nonce);
    if (!pending) {
      this.options.onError?.(error);
      return;
    }
    this.pending.delete(nonce);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  failPending(error) {
    for (const [nonce, pending] of this.pending) {
      this.pending.delete(nonce);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
  settleReady(error) {
    const reject = this.readyReject;
    this.readyReject = null;
    this.readyResolve = null;
    reject?.(error);
  }
  fail(error) {
    if (this.closed)
      return;
    this.ready = false;
    this.settleReady(error);
    this.options.onError?.(error);
    this.failPending(error);
    this.closeReason = this.closeReason ?? error.message;
    this.onClosed(this.closeReason);
  }
  onClosed(reason) {
    if (this.closeNotified)
      return;
    this.closeNotified = true;
    this.options.onClose?.(reason);
  }
}
function describePayload(payload) {
  if (!payload || typeof payload !== "object")
    return null;
  const record = payload;
  if (typeof record.message === "string")
    return record.message;
  if (record.data && typeof record.data.message === "string")
    return record.data.message;
  return null;
}
function describeError(data) {
  if (!data || typeof data !== "object")
    return "unknown error";
  const record = data;
  if (typeof record.code === "number" && typeof record.message === "string")
    return `${record.code}: ${record.message}`;
  if (typeof record.message === "string")
    return record.message;
  return "unknown error";
}

// src/tui.tsx
var PACKAGE_VERSION = "0.0.1";
var PLUGIN_ID = "opencode-presence-discord";
function optionBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function optionString(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}
function resolveOptions(context) {
  const raw = context.options?.m0 ?? {};
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  const defaultRuntime = xdgRuntime ? join4(xdgRuntime, "opencode-presence-discord") : join4(tmpdir(), "opencode-presence-discord");
  const runtimeDir = optionString(raw.runtimeDir, defaultRuntime);
  return {
    capture: optionBoolean(raw.capture, false),
    live: optionBoolean(raw.live, false),
    captureReference: optionBoolean(raw.captureReference, true),
    evidenceDir: optionString(raw.evidenceDir, join4(runtimeDir, "evidence")),
    runtimeDir
  };
}
function discordSocketPath() {
  if (process.env.DISCORD_IPC_PATH)
    return process.env.DISCORD_IPC_PATH;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (runtime)
    return join4(runtime, "discord-ipc-0");
  if (uid !== undefined)
    return `/run/user/${uid}/discord-ipc-0`;
  return join4(tmpdir(), "discord-ipc-0");
}
function timestamp() {
  return new Date().toISOString();
}
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (code === "ETIMEDOUT")
      return "rpc-timeout";
    if (code === "ECLOSED")
      return "rpc-closed";
    if (code === "ERPC")
      return "rpc-rejected";
  }
  return "connect-failed";
}
var tui_default = Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    const runId = randomUUID4();
    const options = resolveOptions(context);
    const salt = loadPseudonymSalt(options.runtimeDir);
    const log = new EvidenceLog({ dir: options.evidenceDir, runId });
    const instanceId = randomUUID4();
    const generation = randomUUID4();
    const startedAt = timestamp();
    const writeJson = async (name, value) => {
      if (disposed || disposing)
        return;
      try {
        await log.writeJson(name, value);
      } catch {}
    };
    let disposed = false;
    let disposing = false;
    const publishRecord = (record) => {
      if (disposed || disposing)
        return;
      const phase = record.phase ?? (["ready", "socket-close", "socket-error", "revoked", "cleanup", "cleanup-close", "coordination-start", "disconnect"].includes(record.attempt) ? "lifecycle" : record.nonce ? record.rpcOk === true ? "acknowledged" : "post-enqueue" : "pre-enqueue");
      const safe = sanitizePublication({ ...record, phase });
      if (safe)
        log.append("publication.jsonl", safe);
    };
    await log.init();
    const { report: runtimeProbe, backend } = await probeRuntime(context);
    const safeProbe = sanitizeProbe(runtimeProbe) ?? { observedAt: new Date(0).toISOString(), host: { version: "0.0.0", channel: "unknown", kind: "unknown", platform: "unknown", arch: "unknown", pid: 0 }, imports: { net: { ok: false, createConnection: false }, "bun:sqlite": { ok: false }, "node:sqlite": { ok: false } }, sqlite: { usable: false, kind: "bun:sqlite" } };
    await writeJson("probe.json", safeProbe);
    const locality = await classifyLocality(context);
    await writeJson("locality.json", sanitizeLocality(locality) ?? null);
    const rawRun = {
      v: 1,
      runId,
      instanceId,
      pluginId: PLUGIN_ID,
      packageVersion: PACKAGE_VERSION,
      startedAt,
      host: runtimeProbe.host,
      sqlite: runtimeProbe.sqlite,
      imports: runtimeProbe.imports,
      locality,
      options: { capture: options.capture, live: options.live, captureReference: options.captureReference },
      discordSocket: process.env.DISCORD_IPC_PATH ? "env" : "default"
    };
    await writeJson("run.json", sanitizeRun(rawRun) ?? null);
    let ipc = null;
    let capture = null;
    let publisher = null;
    let acquisition = null;
    let lastSessionID = null;
    let cleanupDone = false;
    const publisherLog = (event) => {
      if (disposed)
        return;
      const safe = sanitizePublisherEvent({ v: 1, ...event });
      if (safe)
        log.append(`publisher-${instanceId}.jsonl`, safe);
    };
    if (backend) {
      publisher = new Publisher({
        runtimeDir: options.runtimeDir,
        backend,
        identity: { instanceId, pid: process.pid, generation },
        onEvent: publisherLog,
        onRevoked: () => {
          publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "revoked", live: options.live, code: "publisher-revoked" });
          if (ipc) {
            ipc.destroy("publisher lease revoked");
            ipc = null;
          }
        }
      });
      try {
        acquisition = publisher.start();
      } catch {
        publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "coordination-start", live: options.live, code: "no-coordinator" });
      }
    }
    const closeIpc = (code, attempt = "cleanup-close") => {
      if (!ipc)
        return;
      ipc.close();
      ipc = null;
      publishRecord({
        v: 1,
        at: timestamp(),
        instanceId,
        pid: process.pid,
        attempt,
        live: options.live,
        code
      });
    };
    const connectIpc = async () => {
      if (ipc?.isReady)
        return ipc;
      if (ipc) {
        ipc.close();
        ipc = null;
      }
      if (disposed || disposing)
        throw new Error("disposed");
      const connection = new DiscordIpc({
        path: discordSocketPath(),
        clientId: CLIENT_ID,
        onClose: () => {
          publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "socket-close", live: options.live, code: "socket-closed" });
        },
        onError: () => {
          publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "socket-error", live: options.live, code: "socket-error" });
        }
      });
      ipc = connection;
      try {
        await connection.connect();
      } catch (error) {
        if (ipc === connection)
          ipc = null;
        connection.close();
        throw error;
      }
      if (disposed || disposing) {
        if (ipc === connection)
          ipc = null;
        connection.close();
        throw new Error("disposed");
      }
      publishRecord({ v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "ready", live: options.live, ready: true });
      return connection;
    };
    const snapshot = async (kind) => {
      if (disposed || disposing)
        return {};
      const observed = currentSession(context, lastSessionID);
      let inspection = null;
      let anchor = null;
      if (observed) {
        inspection = await inspectSession(context, observed.sessionID, salt);
        if (disposed || disposing)
          return {};
        const key = sessionAnchorKey(locality, observed.sessionID);
        if (publisher && key)
          anchor = publisher.readAnchor(key);
      }
      const document = {
        v: 1,
        kind,
        at: timestamp(),
        runId,
        instanceId,
        pid: process.pid,
        generation,
        selector: observed ? { reason: observed.reason, sessionHash: pseudonym(salt, observed.sessionID) } : null,
        inspection,
        anchor,
        ownership: publisher ? { isOwner: publisher.isOwner, fence: publisher.currentFence, revoked: publisher.isRevoked, ownerRow: publisher.ownerSnapshot() } : null,
        acquisition,
        locality,
        probe: { observedAt: runtimeProbe.observedAt, host: runtimeProbe.host, imports: runtimeProbe.imports, sqlite: runtimeProbe.sqlite },
        captureEnabled: options.capture,
        live: options.live
      };
      const safeDocument = sanitizeSnapshot(document);
      if (!safeDocument)
        return {};
      await writeJson(`snapshot-${instanceId}.json`, safeDocument);
      await writeJson("snapshot.json", safeDocument);
      const snapshotEvent = sanitizePublisherEvent({ v: 1, kind: "snapshot", atMs: Date.now(), instanceId, pid: process.pid, generation, snapshotKind: kind });
      if (snapshotEvent && !disposed)
        log.append(`publisher-${instanceId}.jsonl`, snapshotEvent);
      return safeDocument;
    };
    const toast = (message) => {
      if (disposed || disposing)
        return;
      try {
        context.ui.toast.show({ title: "Presence M0", message });
      } catch {}
    };
    let publicationChain = Promise.resolve();
    const serialized = (fn) => {
      const next = publicationChain.then(fn, fn);
      publicationChain = next.then(() => {
        return;
      }, () => {
        return;
      });
      return next;
    };
    const publish = (attempt) => serialized(() => publishInner(attempt));
    const publishInner = async (attempt) => {
      const started = Date.now();
      const base = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt, phase: "pre-enqueue", live: options.live };
      const refuse = (code, extra = {}) => {
        publishRecord({ ...base, ...extra, code });
        if (!disposed && !disposing)
          toast(`Presence update refused: ${code}`);
      };
      if (!options.live)
        return refuse("live-disabled");
      if (!publisher)
        return refuse("no-coordinator");
      if (disposed || disposing)
        return;
      const observed = currentSession(context, lastSessionID);
      if (!observed || observed.reason === "most-recent")
        return refuse("no-observed-session");
      const sessionKey = sessionAnchorKey(locality, observed.sessionID);
      if (!sessionKey)
        return refuse("identity-unknown");
      let connection = null;
      try {
        for (let attemptIndex = 0;attemptIndex < 3; attemptIndex += 1) {
          if (disposed || disposing)
            return;
          const inspection = await inspectSession(context, observed.sessionID, salt);
          if (disposed || disposing)
            return;
          if (!inspection.found)
            return refuse("session-unreadable");
          if (!inspection.executedModel)
            return refuse(inspection.executedModelCode ?? "executed-model-unknown");
          if (!inspection.agent)
            return refuse(inspection.agentCode ?? "executed-agent-unknown");
          const state = publisher.readAnchorState(sessionKey);
          const reserved = state.acknowledgedUnpersisted ?? state.committed ?? state.pending;
          const selected = reserved !== null ? { seconds: reserved.seconds, sourceCreatedMs: reserved.sourceCreatedMs, committed: state.committed !== null || state.acknowledgedUnpersisted !== null } : inspection.candidateTimestampSeconds !== null && inspection.latestUserMessageAtMs !== null ? { seconds: inspection.candidateTimestampSeconds, sourceCreatedMs: inspection.latestUserMessageAtMs, committed: false } : null;
          if (!selected)
            return refuse("timestamp-unavailable");
          const activity = buildActivity({ id: inspection.executedModel.id, providerID: inspection.executedModel.providerID }, selected.seconds);
          if (!sanitizeActivity(activity))
            return refuse("payload-invalid");
          const provenance = {
            seconds: selected.seconds,
            sourceField: "session.message.list[].type=user.time.created",
            originalValue: selected.sourceCreatedMs,
            originalUnits: "milliseconds since Unix epoch",
            conversion: "floor(ms/1000)",
            committed: selected.committed,
            anchorCommitted: false
          };
          const baseWithSession = {
            ...base,
            sessionHash: inspection.sessionIDHash ?? undefined,
            selector: observed.reason === "route" ? "route" : "event",
            fence: publisher.currentFence,
            timestampProvenance: provenance,
            modelProvenance: {
              selected: inspection.selectedModel,
              executed: inspection.executedModel,
              agent: inspection.agent,
              sessionCost: inspection.sessionCost,
              reportedCost: inspection.reportedCost,
              tokens: inspection.tokens
            }
          };
          if (!publisher.isOwner) {
            if (publisher.isPaused)
              publisher.resume();
            else
              publisher.tick();
          }
          if (!publisher.isOwner)
            return refuse("not-owner", baseWithSession);
          if (disposed || disposing)
            return;
          const conflicting = state.committed !== null && (state.committed.seconds !== selected.seconds || state.committed.sourceCreatedMs !== selected.sourceCreatedMs) || state.pending !== null && (state.pending.seconds !== selected.seconds || state.pending.sourceCreatedMs !== selected.sourceCreatedMs);
          if (conflicting)
            return refuse("anchor-conflict", baseWithSession);
          if (!connection) {
            try {
              connection = await connectIpc();
            } catch {
              return refuse("connect-failed", baseWithSession);
            }
          }
          if (!connection || disposed || disposing)
            return;
          const critical = publisher.criticalPublish(sessionKey, { seconds: selected.seconds, sourceCreatedMs: selected.sourceCreatedMs }, () => connection.enqueueSetActivity(process.pid, activity));
          if (!critical.ok) {
            if (critical.reason === "anchor-conflict" || critical.reason === "anchor-pending")
              continue;
            const code = critical.reason === "busy" ? "enqueue-busy" : critical.reason === "not-owner" ? "enqueue-not-owner" : critical.reason === "revoked" ? "enqueue-revoked" : critical.reason === "no-store" ? "enqueue-no-store" : "enqueue-error";
            return refuse(code, { ...baseWithSession, activity });
          }
          const request = critical.value;
          const enqueuedAt = timestamp();
          publishRecord({ ...baseWithSession, at: enqueuedAt, phase: "enqueued", fence: critical.fence, activity, nonce: request.nonce, cmd: "SET_ACTIVITY" });
          try {
            const reply = await request.reply;
            if (disposed || disposing)
              return;
            const ok = reply.evt !== "ERROR";
            if (!ok) {
              publishRecord({
                ...baseWithSession,
                at: enqueuedAt,
                phase: "post-enqueue",
                fence: critical.fence,
                activity,
                nonce: request.nonce,
                cmd: "SET_ACTIVITY",
                evt: "ERROR",
                rpcOk: false,
                code: "rpc-rejected",
                durationMs: Date.now() - started
              });
              toast("Discord rejected the presence update");
              return;
            }
            const commit = publisher.markAcknowledged(sessionKey, selected.seconds, selected.sourceCreatedMs);
            publishRecord({
              ...baseWithSession,
              at: enqueuedAt,
              phase: "acknowledged",
              fence: critical.fence,
              activity,
              nonce: request.nonce,
              cmd: "SET_ACTIVITY",
              evt: null,
              rpcOk: true,
              ...commit.ok ? {} : { code: commit.code },
              timestampProvenance: { ...provenance, anchorCommitted: commit.ok },
              durationMs: Date.now() - started
            });
            toast("Presence sent (RPC acknowledged)");
            return;
          } catch (error) {
            if (disposed || disposing)
              return;
            publishRecord({
              ...baseWithSession,
              at: enqueuedAt,
              phase: "post-enqueue",
              fence: critical.fence,
              activity,
              nonce: request.nonce,
              cmd: "SET_ACTIVITY",
              ...errorCode(error) === "rpc-rejected" ? { evt: "ERROR" } : {},
              rpcOk: false,
              code: errorCode(error),
              durationMs: Date.now() - started
            });
            toast("No RPC acknowledgment");
            return;
          }
        }
        return refuse("anchor-conflict");
      } finally {
        if (disposed && connection)
          connection.close();
      }
    };
    const disconnect = () => serialized(disconnectInner);
    const disconnectInner = async () => {
      if (disposed || disposing)
        return;
      const attempt = { v: 1, at: timestamp(), instanceId, pid: process.pid, attempt: "disconnect-command", live: options.live };
      if (options.live && ipc?.isReady && publisher?.isOwner) {
        const connection = ipc;
        const critical = publisher.criticalEnqueue(() => connection.enqueueClearActivity(process.pid));
        if (critical.ok) {
          publishRecord({ ...attempt, phase: "enqueued", fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY" });
          try {
            const reply = await critical.value.reply;
            const ok = reply.evt !== "ERROR";
            publishRecord({ ...attempt, phase: ok ? "acknowledged" : "post-enqueue", fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY", evt: ok ? null : "ERROR", rpcOk: ok, ...ok ? {} : { code: "rpc-rejected" } });
          } catch (error) {
            publishRecord({ ...attempt, phase: "post-enqueue", fence: critical.fence, nonce: critical.value.nonce, cmd: "SET_ACTIVITY", ...errorCode(error) === "rpc-rejected" ? { evt: "ERROR" } : {}, rpcOk: false, code: errorCode(error) });
          }
        } else {
          publishRecord({ ...attempt, code: "clear-refused" });
        }
      } else {
        publishRecord({ ...attempt, code: options.live ? "no-socket" : "live-disabled" });
      }
      if (disposed || disposing)
        return;
      closeIpc("no-socket", "disconnect");
      if (publisher)
        publisher.release();
      toast("Disconnected");
    };
    const runSubcommand = async (input, event) => {
      if (disposed || disposing)
        return;
      const raw = (input ?? event ?? "").trim();
      const command = raw.split(/\s+/)[0] ?? "";
      if (command === "snapshot") {
        const document = await snapshot("manual-snapshot");
        const inspection = document.inspection;
        toast(inspection?.found ? `Snapshot: ${inspection.status ?? "unknown"} · ${inspection.executedModel?.providerID ?? "?"}/${inspection.executedModel?.id ?? "?"}` : "Snapshot written: no session observed");
        return;
      }
      if (command === "publish") {
        await publish("command-publish");
        return;
      }
      if (command === "disconnect") {
        await disconnect();
        return;
      }
      toast("Usage: /presence-m0 snapshot | publish | disconnect");
    };
    try {
      context.keymap.layer(() => ({
        commands: [
          {
            id: "presence-m0",
            title: "Presence M0",
            description: "Discord presence transmission spike",
            group: "presence",
            bind: false,
            palette: true,
            slash: { name: "presence-m0", arguments: true },
            run: (input, event) => runSubcommand(input, typeof event === "string" ? event : undefined)
          },
          {
            id: "presence-m0-snapshot",
            title: "Presence M0: snapshot",
            group: "presence",
            bind: false,
            palette: true,
            run: () => runSubcommand("snapshot")
          },
          {
            id: "presence-m0-publish",
            title: "Presence M0: publish",
            group: "presence",
            bind: false,
            palette: true,
            run: () => runSubcommand("publish")
          },
          {
            id: "presence-m0-disconnect",
            title: "Presence M0: disconnect",
            group: "presence",
            bind: false,
            palette: true,
            run: () => runSubcommand("disconnect")
          }
        ]
      }));
    } catch (error) {
      log.append("capture.jsonl", errorRecord("command.registration.failed", "capture-invalid", instanceId));
    }
    const unsubscribe = context.data.listen(({ details }) => {
      if (disposed || disposing)
        return;
      const event = details;
      try {
        const data = event.data && typeof event.data === "object" ? event.data : {};
        if (typeof data.sessionID === "string")
          lastSessionID = data.sessionID;
        capture?.onListen(event);
      } catch (error) {
        capture?.notify("capture.listen.error", "capture-listen-failed");
      }
    });
    if (options.capture) {
      try {
        capture = startCapture(log, { salt, reference: options.captureReference, context, instanceId });
      } catch (error) {
        log.append("capture.jsonl", errorRecord("capture.start.failed", "capture-start-failed", instanceId));
      }
    }
    try {
      await snapshot("startup-mid-task");
    } catch (error) {
      log.append("capture.jsonl", errorRecord("snapshot.startup.failed", "snapshot-startup-failed", instanceId));
    }
    return async () => {
      if (cleanupDone)
        return;
      cleanupDone = true;
      disposing = true;
      const cleanupRecord = sanitizePublication({
        v: 1,
        at: timestamp(),
        instanceId,
        pid: process.pid,
        attempt: "cleanup",
        phase: "lifecycle",
        live: options.live,
        ...ipc ? { ready: ipc.isReady } : {}
      });
      if (cleanupRecord)
        log.append("publication.jsonl", cleanupRecord);
      if (ipc) {
        ipc.close();
        ipc = null;
      }
      try {
        unsubscribe();
      } catch {}
      if (capture) {
        capture.stop();
      }
      if (publisher) {
        if (publisher.isOwner && publisher.currentFence > 0) {
          const cleanupEvent = sanitizePublisherEvent({
            v: 1,
            kind: "cleanup",
            atMs: Date.now(),
            instanceId,
            pid: process.pid,
            generation: publisher.identity.generation,
            fence: publisher.currentFence,
            reason: "cleanup"
          });
          if (cleanupEvent)
            log.append(`publisher-${instanceId}.jsonl`, cleanupEvent);
        }
        publisher.stop();
      }
      disposed = true;
      if (capture)
        await Promise.race([capture.referenceTask, new Promise((resolve) => setTimeout(resolve, 500))]);
      if (capture) {
        await capture.flush();
      } else {
        await log.close();
      }
    };
  }
});
export {
  tui_default as default,
  resolveOptions
};
