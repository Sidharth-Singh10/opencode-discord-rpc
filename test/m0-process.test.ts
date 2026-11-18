import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { FakeDiscord } from "./fake-discord.js"

const labRoot = "/tmp/opencode"
mkdirSync(labRoot, { recursive: true })

const REPO = resolve(import.meta.dir, "..")
const HARNESS = join(REPO, "test", "harness", "publisher-process.ts")

interface EventRecord {
  atMs: number
  pid: number
  kind: string
  status?: string
  fence?: number | null
  previousFence?: number
  reason?: string
  action?: string
  ok?: boolean
  evt?: string | null
  event?: string
}

interface Child {
  name: string
  proc: ReturnType<typeof Bun.spawn>
  eventsFile: string
  actionFile: string
  criticalFile: string
}

const children: Child[] = []
const fakes: FakeDiscord[] = []
const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(labRoot, `${prefix}-`))
  dirs.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function readEvents(child: Child): EventRecord[] {
  if (!existsSync(child.eventsFile)) return []
  const records: EventRecord[] = []
  for (const line of readFileSync(child.eventsFile, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as EventRecord)
    } catch {
      // A line can be mid-write; the next poll will see it complete.
    }
  }
  return records
}

async function waitEvent(child: Child, predicate: (event: EventRecord) => boolean, timeoutMs = 20_000): Promise<EventRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = readEvents(child).find(predicate)
    if (found) return found
    await sleep(50)
  }
  const observed = readEvents(child)
    .map((event) => `${event.kind}:${event.status ?? event.reason ?? ""}`)
    .join(", ")
  throw new Error(`timed out waiting for ${child.name}; observed: ${observed}`)
}

async function spawnChild(base: string, name: string, socketPath: string, extraEnv: Record<string, string> = {}): Promise<Child> {
  const eventsFile = join(base, `${name}.jsonl`)
  const actionFile = join(base, `${name}.action`)
  const criticalFile = join(base, `${name}.critical`)
  writeFileSync(eventsFile, "")
  writeFileSync(actionFile, "")
  const proc = Bun.spawn([process.execPath, HARNESS], {
    cwd: REPO,
    env: {
      ...process.env,
      M0_RUNTIME: join(base, "runtime"),
      M0_SOCKET: socketPath,
      M0_EVENTS: eventsFile,
      M0_ACTION: actionFile,
      M0_CRITICAL_FILE: criticalFile,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const child = { name, proc, eventsFile, actionFile, criticalFile }
  children.push(child)
  return child
}

async function startFake(): Promise<{ fake: FakeDiscord; socketPath: string }> {
  const dir = tempDir("m0-proc")
  const socketPath = join(dir, "discord-ipc-0")
  const fake = new FakeDiscord({ path: socketPath })
  await fake.start()
  fakes.push(fake)
  return { fake, socketPath }
}

function kill(child: Child, signal: NodeJS.Signals): void {
  try {
    process.kill(child.proc.pid, signal)
  } catch {
    // Already exited.
  }
}

afterEach(async () => {
  for (const child of children) kill(child, "SIGKILL")
  await sleep(50)
  for (const child of children) {
    try {
      child.proc.kill()
    } catch {
      // Already gone.
    }
  }
  children.length = 0
  for (const fake of fakes) await fake.stop()
  fakes.length = 0
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe("publisher process isolation", () => {
  test(
    "two instances, one publisher, fenced takeover after kill -KILL",
    async () => {
      const { fake, socketPath } = await startFake()
      const base = tempDir("m0-kill")

      const a = await spawnChild(base, "a", socketPath)
      const acquiredA = await waitEvent(a, (event) => event.kind === "start" && event.status === "acquired")
      expect(acquiredA.fence).toBe(1)

      const b = await spawnChild(base, "b", socketPath)
      const acquiredB = await waitEvent(b, (event) => event.kind === "start")
      expect(acquiredB.status).toBe("contended")

      // Exactly one publisher: A is the only process with an acquired lease.
      const aTakeover = readEvents(a).filter((event) => event.kind === "publisher" && event.event === "takeover")
      expect(aTakeover).toHaveLength(0)
      expect(fake.activityFrames()).toHaveLength(0)

      kill(a, "SIGKILL")
      await a.proc.exited

      const takeover = await waitEvent(b, (event) => event.kind === "publisher" && event.event === "takeover", 20_000)
      expect(takeover.fence).toBeGreaterThan(acquiredA.fence ?? 0)

      writeFileSync(b.actionFile, "publish")
      const reply = await waitEvent(b, (event) => event.kind === "rpc-reply" && event.action === "publish")
      expect(reply.evt).toBeNull()

      const frames = fake.activityFrames()
      expect(frames).toHaveLength(1)
      const payload = frames[0]?.payload as { args: { pid: number; activity: { details: string; timestamps: { start: number } } } }
      expect(payload.args.pid).toBe(b.proc.pid)
      expect(payload.args.activity.details).toBe("M0 transmission test")
      expect(Number.isInteger(payload.args.activity.timestamps.start)).toBe(true)
    },
    60_000,
  )

  test(
    "suspend/resume: takeover happens, resumed owner is revoked and cannot clear",
    async () => {
      const { fake, socketPath } = await startFake()
      const base = tempDir("m0-suspend")

      const a = await spawnChild(base, "a", socketPath)
      const acquiredA = await waitEvent(a, (event) => event.kind === "start" && event.status === "acquired")
      const b = await spawnChild(base, "b", socketPath)
      await waitEvent(b, (event) => event.kind === "start" && event.status === "contended")

      kill(a, "SIGSTOP")
      const takeover = await waitEvent(b, (event) => event.kind === "publisher" && event.event === "takeover", 20_000)
      expect(takeover.fence).toBeGreaterThan(acquiredA.fence ?? 0)

      kill(a, "SIGCONT")
      await waitEvent(a, (event) => event.kind === "revoked", 10_000)

      writeFileSync(a.actionFile, "clear")
      const rejected = await waitEvent(a, (event) => event.kind === "critical-result" && event.action === "clear", 10_000)
      expect(rejected.ok).toBe(false)
      expect(["not-owner", "revoked"]).toContain(rejected.reason ?? "")

      // No clear and no activity frame from the revoked owner.
      expect(fake.activityFrames()).toHaveLength(0)

      writeFileSync(b.actionFile, "publish")
      await waitEvent(b, (event) => event.kind === "rpc-reply" && event.action === "publish", 10_000)
      const frames = fake.activityFrames()
      expect(frames).toHaveLength(1)
      expect((frames[0]?.payload as { args: { pid: number } }).args.pid).toBe(b.proc.pid)
    },
    60_000,
  )

  test(
    "suspend inside the critical section delays takeover but preserves safety",
    async () => {
      const { fake, socketPath } = await startFake()
      const base = tempDir("m0-critical")

      const a = await spawnChild(base, "a", socketPath, { M0_HOLD_CRITICAL_MS: "6000" })
      const acquiredA = await waitEvent(a, (event) => event.kind === "start" && event.status === "acquired")

      writeFileSync(a.actionFile, "hold")
      const deadline = Date.now() + 10_000
      while (!existsSync(a.criticalFile) && Date.now() < deadline) await sleep(20)
      expect(existsSync(a.criticalFile)).toBe(true)

      kill(a, "SIGSTOP")
      const b = await spawnChild(base, "b", socketPath)
      await waitEvent(b, (event) => event.kind === "start")

      // Well past the 10 s stale window: the held transaction blocks takeover.
      await sleep(12_000)
      expect(readEvents(b).some((event) => event.kind === "publisher" && (event.event === "takeover" || event.event === "acquire") || event.kind === "start" && event.status === "takeover")).toBe(false)

      kill(a, "SIGCONT")
      const completed = await waitEvent(a, (event) => event.kind === "critical-result" && event.action === "hold", 10_000)
      expect(completed.ok).toBe(true)

      // A held the lock throughout and is still the owner; B never took over.
      expect(readEvents(b).some((event) => event.kind === "publisher" && event.event === "takeover")).toBe(false)

      kill(a, "SIGKILL")
      const takeover = await waitEvent(b, (event) => event.kind === "publisher" && event.event === "takeover", 20_000)
      expect(takeover.fence).toBeGreaterThan(acquiredA.fence ?? 0)

      const framesBefore = fake.activityFrames().length
      writeFileSync(b.actionFile, "publish")
      await waitEvent(b, (event) => event.kind === "rpc-reply" && event.action === "publish", 10_000)
      expect(fake.activityFrames().length).toBe(framesBefore + 1)
    },
    90_000,
  )
})
