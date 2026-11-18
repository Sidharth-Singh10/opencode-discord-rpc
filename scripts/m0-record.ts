/**
 * Regenerates docs/M0-evidence.json from a real verification run.
 *
 * Usage: bun run scripts/m0-record.ts <fresh-lab-directory>
 *
 * The lab must be absent or empty. Every command below is executed for real;
 * no verification number is typed by hand. Logs are copied into
 * docs/evidence/ so that every evidence pointer resolves inside the repository
 * instead of depending on a temporary directory surviving.
 *
 * This records the M0 transmission spike. It does not accept M0 and does not
 * publish anything.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { makeEvidenceFixture } from "../test/fixtures/m0-evidence.js"

const repo = resolve(import.meta.dir, "..")
const labArg = process.argv[2]
if (!labArg) {
  console.error("usage: bun run scripts/m0-record.ts <fresh-lab-directory>")
  process.exit(2)
}
const lab = resolve(labArg)
if (existsSync(lab) && readdirSync(lab).length > 0) {
  console.error(`refusing non-empty lab directory: ${lab}`)
  process.exit(2)
}

const logs = join(lab, "logs")
const evidenceDocs = join(repo, "docs", "evidence")
const packDir = join(lab, "pack")
const installed = join(lab, "installed")
const packed = join(lab, "packed")
const extracted = join(lab, "extracted")
const fixtureDir = join(lab, "fixture")
for (const dir of [lab, logs, packDir, installed, packed, extracted, fixtureDir]) mkdirSync(dir, { recursive: true })

const bun = process.execPath
const env = { ...process.env, PATH: `${dirname(bun)}:${process.env.PATH ?? ""}` }

interface Step {
  code: number
  stdout: string
  stderr: string
  log: string
}

function record(name: string, argv: string[], options: { cwd?: string; allowFailure?: boolean } = {}): Step {
  const result = Bun.spawnSync(argv, { cwd: options.cwd ?? repo, env, stdout: "pipe", stderr: "pipe" })
  const stdout = result.stdout?.toString() ?? ""
  const stderr = result.stderr?.toString() ?? ""
  const log = `${name}.log`
  writeFileSync(join(logs, log), stdout + stderr)
  const code = result.exitCode ?? -1
  if (code !== 0 && !options.allowFailure) throw new Error(`${name} failed with exit ${code}; see ${join(logs, log)}`)
  return { code, stdout, stderr, log }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function mustMatch(text: string, pattern: RegExp, label: string): RegExpMatchArray {
  const match = pattern.exec(text)
  if (!match) throw new Error(`could not parse ${label} from command output`)
  return match
}

function parseTests(stdout: string, label: string): { pass: number; fail: number; assertions: number; files: number } {
  return {
    pass: Number(mustMatch(stdout, /(\d+) pass/, `${label} pass count`)[1]),
    fail: Number(mustMatch(stdout, /(\d+) fail/, `${label} fail count`)[1]),
    assertions: Number(mustMatch(stdout, /(\d+) expect\(\) calls/, `${label} assertion count`)[1]),
    files: Number(mustMatch(stdout, /Ran \d+ tests across (\d+) files?/, `${label} file count`)[1]),
  }
}

// ---------------------------------------------------------------- source gate
const head = record("git-head", ["git", "rev-parse", "HEAD"]).stdout.trim()
const branch = record("git-branch", ["git", "branch", "--show-current"]).stdout.trim()
const status = record("git-status", ["git", "status", "--porcelain"]).stdout
if (status.trim().length > 0) throw new Error("working tree is not clean; commit source changes before recording evidence")
const diffCheck = record("git-diff-check", ["git", "diff", "--check"], { allowFailure: true })
if (diffCheck.code !== 0) throw new Error("git diff --check failed")

// ------------------------------------------------------------------ commands
const typecheck = record("typecheck", [bun, "run", "typecheck"])
const tests = record("test", [bun, "test"])
const testCounts = parseTests(tests.stdout + tests.stderr, "bun test")
if (testCounts.fail !== 0) throw new Error("bun test reported failures")

const build = record("build", [bun, "run", "build"])
const modules = Number(mustMatch(build.stdout + build.stderr, /Bundled (\d+) modules/, "build module count")[1])
const bundlePath = join(repo, "dist", "tui.js")
const bundleBytes = statSync(bundlePath).size
const bundleSha256 = sha256(bundlePath)

const packGuard = record("pack-guard", [bun, "run", "scripts/pack-guard.ts"])
const pack = record("pack", ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", packDir])
const packJson = JSON.parse(pack.stdout.trim()) as unknown
const packInfo = (Array.isArray(packJson) ? packJson[0] : Object.values(packJson as Record<string, unknown>)[0]) as Record<string, unknown> | undefined
if (!packInfo || typeof packInfo.filename !== "string") throw new Error("npm pack did not report a filename")
const tarball = join(packDir, packInfo.filename)
const artifactBytes = statSync(tarball).size
const artifactSha256 = sha256(tarball)
const entries = typeof packInfo.entryCount === "number" ? packInfo.entryCount : Array.isArray(packInfo.files) ? packInfo.files.length : -1
if (entries < 1) throw new Error("npm pack did not report package entries")

const install = record("install", ["npm", "install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", tarball, "solid-js@1.9.13"])
const installedBundle = join(installed, "node_modules", "opencode-presence-discord", "dist", "tui.js")
if (!existsSync(installedBundle)) throw new Error("installed package has no dist/tui.js")
const installedBundleSha256 = sha256(installedBundle)

const extract = record("extract", ["tar", "-xzf", tarball, "-C", extracted])
const extractedBundle = join(extracted, "package", "dist", "tui.js")
const extractedBundleSha256 = sha256(extractedBundle)
const installedBundleMatchesTarball = installedBundleSha256 === extractedBundleSha256

const validatorSuite = record("validator-suite", [bun, "test", "test/validator.test.ts"])
const validatorCounts = parseTests(validatorSuite.stdout + validatorSuite.stderr, "validator suite")
if (validatorCounts.fail !== 0) throw new Error("validator fixture suite reported failures")

makeEvidenceFixture(fixtureDir)
const positiveFixture = record("validator-positive", [bun, "run", "scripts/m0-evidence.ts", fixtureDir])
const validatorReportText = positiveFixture.stdout.slice(0, positiveFixture.stdout.indexOf("\nM0 evidence:"))
const validatorReport = JSON.parse(validatorReportText) as Record<string, any>

const packedRun = record("packed", [bun, "test/harness/packed-entrypoint.ts", installed, packed])
const packedResultsPath = join(packed, "results.json")
const packedResults = JSON.parse(readFileSync(packedResultsPath, "utf8")) as { status?: string; results?: Record<string, string> }
if (packedResults.status !== "PASS") throw new Error(`packed harness did not finish PASS (status ${String(packedResults.status)})`)
const packedGroups = Object.keys(packedResults.results ?? {})
if (packedGroups.length === 0 || packedGroups.some((name) => packedResults.results?.[name] !== "PASS")) {
  throw new Error("packed harness has a non-PASS scenario group")
}
const packedLine = mustMatch(packedRun.stdout + packedRun.stderr, /Packed entrypoint: (\d+) scenarios PASS/, "packed scenario count")

const audit = record("audit", [bun, "audit"], { allowFailure: true })
const auditText = audit.stdout + audit.stderr
const vulnerabilityMatch = mustMatch(auditText, /(\d+) vulnerabilities \((\d+) (moderate|high|critical|low)\)/, "audit summary")
const auditAdvisories: Array<{ severity: string; package: string; id: string }> = []
const auditLines = auditText.split("\n")
let currentPackage = "unknown"
for (const line of auditLines) {
  const header = /^([\w@/.-]+)@([\d.]+)(?:, .*)?$/.exec(line.trim())
  if (header) currentPackage = header[1]!
  const advisory = /^(\w+): .* - https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(line.trim())
  if (advisory) auditAdvisories.push({ severity: advisory[1]!, package: currentPackage, id: advisory[2]! })
}
const lockText = readFileSync(join(repo, "bun.lock"), "utf8")
const lockLines = lockText.split("\n")
const picomatchLine = lockLines.findIndex((line) => line.includes('"picomatch": ["picomatch@'))
const picomatchVersion = picomatchLine >= 0 ? /"picomatch@([^"]+)"/.exec(lockLines[picomatchLine] ?? "")?.[1] ?? null : null

// ------------------------------------------------------------- evidence docs
rmSync(evidenceDocs, { recursive: true, force: true })
mkdirSync(evidenceDocs, { recursive: true })
for (const name of readdirSync(logs)) writeFileSync(join(evidenceDocs, name), readFileSync(join(logs, name)))
writeFileSync(join(evidenceDocs, "packed-results.json"), readFileSync(packedResultsPath))
writeFileSync(join(evidenceDocs, "packed-groups.txt"), packedGroups.map((name) => `${name}\n`).join(""))

const relativeLog = (name: string): string => `docs/evidence/${name}`
const generatedAt = new Date().toISOString()
const evidence = {
  milestone: "M0",
  gate: "NOT ACCEPTED",
  acceptanceOwner: "Jury",
  generatedAt,
  generatedBy: "scripts/m0-record.ts from a real fresh run; no number hand-edited",
  source: {
    branch,
    headAtRunStart: head,
    workingTreeCleanAtRunStart: true,
    typecheck: "bun run typecheck",
    tests: "bun test",
    build: "bun run build",
  },
  lab: {
    path: lab,
    availability: "present at generation time; /tmp is not durable",
    logsMirroredTo: "docs/evidence/",
  },
  files: [
    "src/discord/ipc.ts", "src/m0/capture.ts", "src/m0/probe.ts",
    "src/m0/publisher.ts", "src/m0/sanitize.ts", "src/tui.tsx",
    "scripts/m0-evidence.ts", "scripts/m0-record.ts", "scripts/pack-guard.ts",
    "test/evidence-privacy.test.ts", "test/identity-vocabulary.test.ts",
    "test/inspection.test.ts", "test/ipc-correlation.test.ts", "test/m0.test.ts",
    "test/validator.test.ts", "test/fixtures/m0-evidence.ts",
    "test/harness/packed-entrypoint.ts", "test/harness/packed-host-process.ts",
    "docs/M0.md", "docs/M0-evidence.json",
  ],
  artifact: {
    path: tarball,
    sha256: artifactSha256,
    bytes: artifactBytes,
    immutableAfterPacking: true,
    bundleBytes,
    bundleSha256,
    installedBundleSha256,
    extractedBundleSha256,
    installedBundleMatchesTarball,
    bundleMatchesTarball: bundleSha256 === extractedBundleSha256,
    entries,
    publishedToNpm: false,
    assetsEdited: false,
  },
  repair: {
    J1: "Runtime projection before every sink; finite metadata vocabulary; fixed event categories and diagnostics. Agent names are shape-admitted, not reviewed: a lowercase secret-shaped agent may reach 0600 evidence but never the Discord payload.",
    J2: "Serialized publication through ACK/reconciliation; durable intent before enqueue; synchronous owner/fence check and enqueue; unresolved ACK retry and conflict refusal.",
    J3: "Unique correlated operations; duplicate/contradictory terminals rejected; two sessions and both unknown-session/identity refusals required.",
    J4: "Whole-array validation including sparse entries, IPv6 normalization, mixed-address refusal.",
    J5: "Pending connection ownership; immediate close and continuation invalidation; sink drain/close.",
    J6: "Unknown identity refuses publication and enrichment; no shared unknown anchor namespace.",
    J7: "No pruning added; M1-ANCHOR-GC follow-up documented.",
  },
  verification: {
    typecheck: { exitCode: typecheck.code, log: relativeLog(typecheck.log) },
    tests: { exitCode: tests.code, ...testCounts, log: relativeLog(tests.log) },
    build: { exitCode: build.code, modules, log: relativeLog(build.log) },
    packGuard: { exitCode: packGuard.code, heuristic: true, log: relativeLog(packGuard.log) },
    pack: { exitCode: pack.code, log: relativeLog(pack.log), tarball: tarball.split("/").at(-1) },
    install: { exitCode: install.code, log: relativeLog(install.log) },
    extract: { exitCode: extract.code, log: relativeLog(extract.log) },
    positiveValidatorFixture: {
      exitCode: positiveFixture.code,
      kind: "synthetic complete fixture",
      uniqueAcknowledged: validatorReport.publication?.successful ?? null,
      sessions: validatorReport.publication?.sessions ?? null,
      snapshots: validatorReport.snapshots?.count ?? null,
      paired: validatorReport.coverage?.paired ?? null,
      log: relativeLog(positiveFixture.log),
    },
    validatorFixtureSuite: { exitCode: validatorSuite.code, ...validatorCounts, log: relativeLog(validatorSuite.log) },
    packedEntrypoint: {
      exitCode: packedRun.code,
      kind: "synthetic Context and fake Discord; actual installed export, sockets, SQLite and processes",
      scenarioGroups: Number(packedLine[1]),
      groups: packedGroups,
      status: packedResults.status,
      log: relativeLog("packed.log"),
      results: relativeLog("packed-results.json"),
      groupsFile: relativeLog("packed-groups.txt"),
    },
    dependencyAudit: {
      exitCode: audit.code,
      vulnerabilities: Number(vulnerabilityMatch[1]),
      moderate: Number(vulnerabilityMatch[2]),
      high: auditAdvisories.some((entry) => entry.severity === "high") ? 1 : 0,
      advisories: auditAdvisories,
      newDependencies: false,
      observedReachableInM0: false,
      withdrawnAdvisories: [
        {
          id: "GHSA-fc5q-39xc-vjpf",
          package: "picomatch",
          version: picomatchVersion,
          lockLocation: picomatchLine >= 0 ? `bun.lock:${picomatchLine + 1}` : null,
          withdrawnOn: "2026-11-18",
          status: "withdrawn advisory, package still present",
          patchedVersion: null,
        },
      ],
      followUp: "M1-DEPENDENCY-AUDIT",
      reviewBy: "2026-11-25",
      log: relativeLog("audit.log"),
    },
    gitDiffCheck: { exitCode: diffCheck.code, log: relativeLog(diffCheck.log) },
    realModelHostAttempt: {
      complete: false,
      blocker: "OpenCode free-model daily quota exhausted; no paid model selected; the attempt lab is unavailable",
      evidenceAvailable: false,
    },
    realHostScriptedModel: {
      kind: "historical real OpenCode 2.3.0 host and real Discord IPC with LOCAL SCRIPTED inference, NOT real DeepSeek inference",
      evidenceAvailable: false,
      reason: "LIVE_LAB /tmp/opencode/discord-rpc-replacement.pWy7O6 was removed; not evidence for this tarball",
    },
  },
  scope: {
    zeroConnectionRefusals: "Claimed only for refusals reached before the socket opens. In-transaction enqueue-not-owner/revoked/busy refusals and a post-continue precheck refusal can occur with the socket already open.",
    agentEvidenceBoundary: "Agent names are shape-admitted (^[a-z][a-z0-9._-]{0,63}$), so a lowercase secret-shaped token can be persisted to 0600 evidence; it is never sent to Discord.",
    remote: { status: "descoped", integration: "unverified", claimed: false },
    idleStatusAbsence: "sampled, not universal",
    visualReplacementArtifact: "human check open",
    anchorRetention: "unbounded qualified-session anchors and unresolved intent until an explicit M1 retention/GC policy",
    crashRecovery: "pending intent preserves anchor; an ACK lost before persistence is not claimed durably committed",
  },
  cleanup: {
    generatedLab: lab,
    publishedToNpm: false,
    assetsEdited: false,
    userConfigEdited: false,
    serviceEdited: false,
    note: "Packed scenarios create and remove their own runtime stores; the harness stops child hosts and fake Discord endpoints in its finally block.",
  },
}

writeFileSync(join(evidenceDocs, "run-summary.json"), JSON.stringify(evidence, null, 2) + "\n")
writeFileSync(join(repo, "docs", "M0-evidence.json"), JSON.stringify(evidence, null, 2) + "\n")

console.log(JSON.stringify({
  lab,
  head,
  artifactSha256,
  bundleBytes,
  bundleSha256,
  tests: testCounts,
  validatorSuite: validatorCounts,
  packedGroups: packedGroups.length,
  packedStatus: packedResults.status,
  audit: { vulnerabilities: Number(vulnerabilityMatch[1]), moderate: Number(vulnerabilityMatch[2]) },
}, null, 2))
