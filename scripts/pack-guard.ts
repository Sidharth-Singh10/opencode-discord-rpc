/**
 * Build-before-pack protection. Runs after the build and refuses to pack a
 * stale entrypoint, a mis-shaped package or a bundle that contains known
 * test-only controls.
 *
 * This is a heuristic M0 guard, not dependency-graph enforcement. A metafile
 * check that proves the full externalised dependency graph is an M1 obligation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "..")
const failures: string[] = []

function fail(message: string): void {
  failures.push(message)
}

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, unknown>

if (pkg.version !== "0.0.1") fail(`version must be 0.0.1 before packing, got ${String(pkg.version)}`)
if (pkg.bin !== undefined) fail("bin must be absent: dist/cli.js is not built")
if (pkg.peerDependencies !== undefined) fail("peerDependencies must be absent while no JSX is rendered")

const exportsMap = pkg.exports as Record<string, unknown> | undefined
if (!exportsMap) fail("exports is missing")
else {
  const keys = Object.keys(exportsMap)
  if (keys.length !== 1 || keys[0] !== "./tui") fail(`exports must contain only "./tui", got ${keys.join(", ")}`)
  if (exportsMap["./tui"] !== "./dist/tui.js") fail('exports["./tui"] must be "./dist/tui.js"')
}

const deps = pkg.dependencies as Record<string, string> | undefined
if (!deps || deps["@opencode/plugin"] !== "2.3.0") fail('dependencies["@opencode/plugin"] must be pinned to "2.3.0"')

const entry = join(repo, "dist", "tui.js")
if (!existsSync(entry)) fail("dist/tui.js is missing; run the build first")
else {
  const entryStat = statSync(entry)
  if (entryStat.size < 1000) fail(`dist/tui.js is suspiciously small (${entryStat.size} bytes)`)
  const entryMtime = entryStat.mtimeMs
  const sources = readdirSync(join(repo, "src"), { recursive: true })
    .map((name) => String(name))
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => join(repo, "src", name))
  for (const source of sources) {
    if (statSync(source).mtimeMs > entryMtime + 1) fail(`${source} is newer than dist/tui.js; rebuild before packing`)
  }
  const text = readFileSync(entry, "utf8")
  if (text.includes("jsxDEV") || text.includes("solid-js/jsx")) fail("dist/tui.js contains JSX runtime output")
  if (text.includes("holdCriticalMs") || text.includes("onCriticalEnter") || text.includes("M0_HOLD_CRITICAL")) {
    fail("dist/tui.js contains a test-only control path")
  }
  if (text.includes("test/harness") || text.includes("publisher-process.ts")) fail("dist/tui.js references the test harness")
}

if (failures.length > 0) {
  console.error("pack-guard: refusing to pack")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log("pack-guard: entrypoint present and current; package shape and test-hook scan OK (heuristic M0 check)")
