/**
 * Regenerates docs/M0-evidence.json from a real verification run.
 *
 * Usage: bun run scripts/m0-record.ts <fresh-lab-directory>
 *
 * The lab must be absent or empty. Every command below is executed for real;
 * no verification number is typed by hand. Logs are copied into a new
 * docs/evidence/<run>/ directory so that every evidence pointer resolves inside
 * the repository instead of depending on a temporary directory surviving. The
 * packed tarball itself is written once into artifacts/ (never /tmp) and is
 * retained with its bundle, checksums and pack manifest.
 *
 * This records the M0 transmission spike. It does not accept M0 and does not
 * publish anything.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
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

const startedStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
const runDirName = `run-${startedStamp}`
const logs = join(lab, "logs")
const evidenceDocs = join(repo, "docs", "evidence")
const evidenceRun = join(evidenceDocs, runDirName)
const artifacts = join(repo, "artifacts")
const artifactsDist = join(artifacts, "dist")
const extracted = join(artifacts, "extracted")
const installed = join(lab, "installed")
const packed = join(lab, "packed")
const fixtureDir = join(lab, "fixture")
if (existsSync(evidenceRun) && readdirSync(evidenceRun).length > 0) {
  console.error(`refusing existing evidence run directory: ${evidenceRun}`)
  process.exit(2)
}
for (const dir of [lab, logs, artifacts, artifactsDist, evidenceRun, installed, packed, extracted, fixtureDir]) mkdirSync(dir, { recursive: true })

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
const expectedTarball = join(artifacts, "opencode-presence-discord-0.0.1.tgz")
if (existsSync(expectedTarball)) throw new Error(`refusing to repack an existing artifact: ${expectedTarball}`)
const pack = record("pack", ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts])
const packJson = JSON.parse(pack.stdout.trim()) as unknown
const packInfo = (Array.isArray(packJson) ? packJson[0] : Object.values(packJson as Record<string, unknown>)[0]) as Record<string, unknown> | undefined
if (!packInfo || typeof packInfo.filename !== "string") throw new Error("npm pack did not report a filename")
const tarball = join(artifacts, packInfo.filename)
if (tarball !== expectedTarball) throw new Error(`unexpected tarball name: ${tarball}`)
const artifactBytes = statSync(tarball).size
const artifactSha256 = sha256(tarball)
const entries = typeof packInfo.entryCount === "number" ? packInfo.entryCount : Array.isArray(packInfo.files) ? packInfo.files.length : -1
if (entries < 1) throw new Error("npm pack did not report package entries")

// The verified bundle ships next to the tarball, not only in the gitignored build dir.
writeFileSync(join(artifactsDist, "tui.js"), readFileSync(bundlePath))
const artifactBundleSha256 = sha256(join(artifactsDist, "tui.js"))
if (artifactBundleSha256 !== bundleSha256) throw new Error("retained bundle differs from the built bundle")

const install = record("install", ["npm", "install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", tarball, "solid-js@1.9.13"])
const installedBundle = join(installed, "node_modules", "opencode-presence-discord", "dist", "tui.js")
if (!existsSync(installedBundle)) throw new Error("installed package has no dist/tui.js")
const installedBundleSha256 = sha256(installedBundle)

const extract = record("extract", ["tar", "-xzf", tarball, "-C", extracted])
const extractedBundle = join(extracted, "package", "dist", "tui.js")
const extractedBundleSha256 = sha256(extractedBundle)
const installedBundleMatchesTarball = installedBundleSha256 === extractedBundleSha256
const bundleMatchesTarball = bundleSha256 === extractedBundleSha256
if (!installedBundleMatchesTarball || !bundleMatchesTarball) {
  throw new Error("bundle, extracted and installed bytes differ")
}

const extractedFiles = readdirSync(extracted, { recursive: true })
  .map((name) => `extracted/${String(name)}`)
  .filter((name) => statSync(join(artifacts, name)).isFile())
  .sort()
writeFileSync(join(artifacts, "SHA256SUMS"), [
  `${artifactSha256}  ${packInfo.filename}`,
  `${artifactBundleSha256}  dist/tui.js`,
  ...[...new Set(extractedFiles)].map((name) => `${sha256(join(artifacts, name))}  ${name}`),
].join("\n") + "\n")
writeFileSync(join(artifacts, "pack.json"), JSON.stringify({
  commit: head,
  branch,
  packedAt: new Date().toISOString(),
  command: "npm pack --ignore-scripts --json --pack-destination artifacts",
  npmPack: packInfo,
}, null, 2) + "\n")
writeFileSync(join(artifacts, "README.md"), [
  "The packed `opencode-presence-discord@0.0.1` tarball retained from a single clean-tree pack, with the bundle it contains and their checksums.",
  "Re-verify: `cd artifacts && sha256sum -c SHA256SUMS && test \"$(tar -tzf opencode-presence-discord-0.0.1.tgz | wc -l)\" -eq 29 && cmp extracted/package/dist/tui.js dist/tui.js`.",
].join("\n") + "\n")

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
for (const name of readdirSync(logs)) writeFileSync(join(evidenceRun, name), readFileSync(join(logs, name)))
writeFileSync(join(evidenceRun, "packed-results.json"), readFileSync(packedResultsPath))
writeFileSync(join(evidenceRun, "packed-groups.txt"), packedGroups.map((name) => `${name}\n`).join(""))

const relativeLog = (name: string): string => `docs/evidence/${runDirName}/${name}`
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
    ephemeral: true,
    availability: "ephemeral lab used to run the commands; not retained and not an evidence pointer",
    evidenceDir: `docs/evidence/${runDirName}/`,
    logsMirroredTo: `docs/evidence/${runDirName}/`,
  },
  disclosures: {
    harnessModelIdentity: "opencode/deepseek-v4.1-flash-free is a harness test identity, not an executed model. Live evidence is real host, scripted inference.",
    liveEvidenceKind: "real host, scripted inference",
    liveEvidenceAvailable: false,
    liveEvidenceUnavailableReason: "the historical live labs were removed from /tmp; no live material is retained",
    retainedInRepo: `docs/evidence/${runDirName}/ (this run) and the earlier flat docs/evidence/*.log mirror`,
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
    "artifacts/README.md", "artifacts/SHA256SUMS", "artifacts/pack.json",
  ],
  artifact: {
    path: `artifacts/${packInfo.filename}`,
    sha256: artifactSha256,
    bytes: artifactBytes,
    immutableAfterPacking: true,
    bundlePath: "artifacts/dist/tui.js",
    bundleBytes,
    bundleSha256,
    installedBundleSha256,
    extractedBundleSha256,
    extractedPath: "artifacts/extracted/package",
    checksums: "artifacts/SHA256SUMS",
    packManifest: "artifacts/pack.json",
    artifactReadme: "artifacts/README.md",
    installedBundleMatchesTarball,
    bundleMatchesTarball,
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
    clearRefused: {
      tested: true,
      scenario: "disconnect-clear-refused-under-held-write-lock",
      mechanism: "external SQLite writer lock held by the test harness; the bundle contains no test hook",
      result: "the production disconnect path reaches clear-refused with a ready socket and a live owner, and enqueues no frame",
      log: relativeLog("packed.log"),
    },
    realModelHostAttempt: {
      complete: false,
      blocker: "OpenCode free-model daily quota exhausted; no paid model selected; the attempt lab is unavailable",
      evidenceAvailable: false,
      identityDisclosure: "opencode/deepseek-v4.1-flash-free is a harness test identity, not an executed model",
    },
    realHostScriptedModel: {
      kind: "real host, scripted inference: historical real OpenCode 2.3.0 host and real Discord IPC with LOCAL SCRIPTED inference, NOT real DeepSeek inference",
      evidenceAvailable: false,
      reason: "the historical live labs were removed from /tmp; not evidence for this tarball",
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
    generatedLab: "ephemeral; not retained",
    evidenceRun: `docs/evidence/${runDirName}/`,
    artifactRetained: `artifacts/${packInfo.filename}`,
    publishedToNpm: false,
    assetsEdited: false,
    userConfigEdited: false,
    serviceEdited: false,
    note: "Packed scenarios create and remove their own runtime stores; the harness stops child hosts and fake Discord endpoints in its finally block.",
  },
}

writeFileSync(join(evidenceRun, "run-summary.json"), JSON.stringify(evidence, null, 2) + "\n")
writeFileSync(join(repo, "docs", "M0-evidence.json"), JSON.stringify(evidence, null, 2) + "\n")

console.log(JSON.stringify({
  lab,
  evidenceRun: `docs/evidence/${runDirName}/`,
  head,
  artifact: `artifacts/${packInfo.filename}`,
  artifactSha256,
  bundleBytes,
  bundleSha256,
  entries,
  tests: testCounts,
  validatorSuite: validatorCounts,
  packedGroups: packedGroups.length,
  packedStatus: packedResults.status,
  audit: { vulnerabilities: Number(vulnerabilityMatch[1]), moderate: Number(vulnerabilityMatch[2]) },
}, null, 2))
