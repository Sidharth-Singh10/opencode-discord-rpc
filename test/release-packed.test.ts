import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { FakeDiscord } from "./fake-discord.js"

/**
 * Packed-artifact acceptance for release mode. The package is built and packed
 * once, then extracted into an isolated node_modules and loaded through its
 * published "./tui" export. This is a synthetic host and fake Discord IPC, not
 * a live OpenCode or Discord session.
 */
const REPO = resolve(import.meta.dir, "..")
const LAB = mkdtempSync("/tmp/opencode/release-packed-")
const INSTALLED = join(LAB, "installed")
const PACKAGE = join(INSTALLED, "node_modules", "opencode-presence-discord")
const HARNESS = join(REPO, "test", "harness", "release-host-process.ts")

afterAll(() => {
  rmSync(LAB, { recursive: true, force: true })
})

function run(command: string[], cwd = REPO, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

async function pack(): Promise<void> {
  run(["bun", "run", "build"])
  const manifest = JSON.parse(run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", LAB]))
  const entry = Array.isArray(manifest) ? manifest[0] : Object.values(manifest as Record<string, { filename?: string }>)[0]
  const filename = entry?.filename
  if (typeof filename !== "string") throw new Error("npm pack produced no filename")
  mkdirSync(PACKAGE, { recursive: true })
  run(["tar", "-xzf", join(LAB, filename), "-C", PACKAGE, "--strip-components=1"])
  // Host packages stay external in the bundle, exactly as for a real install.
  mkdirSync(join(INSTALLED, "node_modules"), { recursive: true })
  symlinkSync(join(REPO, "node_modules", "@opencode"), join(INSTALLED, "node_modules", "@opencode"), "dir")
}

class Host {
  private seq = 0
  private replies = new Map<number, (value: any) => void>()
  private proc: ReturnType<typeof Bun.spawn>
  readonly ready: Promise<void>
  constructor(socket: string, runtimeDir: string) {
    this.proc = Bun.spawn([process.execPath, HARNESS, INSTALLED, runtimeDir], {
      env: { ...process.env, DISCORD_IPC_PATH: socket },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    this.ready = new Promise((resolveReady, rejectReady) => {
      void (async () => {
        let buffer = ""
        for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
          buffer += new TextDecoder().decode(chunk)
          let end
          while ((end = buffer.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffer.slice(0, end))
            buffer = buffer.slice(end + 1)
            if (message.ready) resolveReady()
            else { this.replies.get(message.id)?.(message); this.replies.delete(message.id) }
          }
        }
        rejectReady(new Error("release host exited before ready"))
      })().catch(rejectReady)
    })
  }
  call(action: string): Promise<any> {
    const id = ++this.seq
    const reply = new Promise((resolveReply) => this.replies.set(id, resolveReply))
    ;(this.proc.stdin as any).write(JSON.stringify({ id, action }) + "\n")
    return reply
  }
  async stop(): Promise<void> {
    if (this.proc.exitCode === null) {
      await this.call("dispose")
      ;(this.proc.stdin as any).end()
      await this.proc.exited
    }
  }
}

function payload(frame: { payload: unknown }): Record<string, any> {
  return frame.payload as Record<string, any>
}

describe("packed release artifact", () => {
  test("loads from ./tui, publishes generic activity and clears on dispose", async () => {
    await pack()
    expect(existsSync(join(PACKAGE, "dist", "tui.js"))).toBe(true)
    expect(readdirSync(PACKAGE)).not.toContain("test")
    const fake = new FakeDiscord({ path: join(LAB, "discord.sock") })
    await fake.start()
    const runtimeDir = join(LAB, "runtime")
    const host = new Host(fake.path, runtimeDir)
    try {
      await host.ready
      const published = await host.call("publish")
      expect(published.ok).toBe(true)
      await fake.waitFor((frame) => payload(frame)?.cmd === "SET_ACTIVITY" && payload(frame)?.args?.activity)

      const activity = payload(fake.activityFrames()[0]!).args.activity
      expect(activity.details).toBe("Using OpenCode")
      expect(activity.state).toBe("GPT-6.1 Sol · Working")
      expect(activity.assets.small_text).toBe("Model: GPT-6.1 Sol")
      expect(activity.timestamps.start).toBe(1_790_000_000)

      const frames = JSON.stringify(fake.frames)
      for (const privateValue of ["PRIVATE_PROMPT", "PRIVATE_ANSWER", "PRIVATE_AGENT", "PRIVATE_SELECTED", "PRIVATE_PROVIDER"]) {
        expect(frames).not.toContain(privateValue)
      }
      expect(frames).not.toContain("/home/")
      expect(existsSync(join(runtimeDir, "evidence"))).toBe(false)
      expect(existsSync(join(PACKAGE, "evidence"))).toBe(false)

      const doctor = await host.call("doctor")
      expect(doctor.ok).toBe(true)
      expect(doctor.toasts.join("\n")).toContain("Model sharing: reviewed labels only")
      expect(doctor.toasts.join("\n")).toContain("Card: Using OpenCode — GPT-6.1 Sol · Working")
      expect(doctor.toasts.join("\n")).not.toContain("/home/")

      await host.call("dispose")
      await fake.waitFor((frame) => payload(frame)?.cmd === "SET_ACTIVITY" && payload(frame)?.args?.activity === undefined)
    } finally {
      await host.stop()
      await fake.stop()
    }
  }, 120_000)
})
