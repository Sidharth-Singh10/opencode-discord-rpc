/**
 * bun test/harness/packed-entrypoint.ts <npm-install-prefix> <fresh-output-dir>
 * Synthetic Context + fake IPC, real installed package, SQLite and processes.
 * This is NOT a live OpenCode/Discord run.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { FakeDiscord } from "../fake-discord.js"

const [installation, output] = process.argv.slice(2).map((value) => resolve(value))
if (!installation || !output) throw new Error("installation and fresh output required")
// A rerun must never reuse a previous scenario tree: stale runtime SQLite
// stores and evidence would make prior acknowledgments look like this run's.
if (existsSync(output) && readdirSync(output).length > 0) {
  throw new Error(`refusing non-empty packed output directory: ${output}`)
}
mkdirSync(output, { recursive: true })
const children = new Set<Host>()
const endpoints = new Set<FakeDiscord>()
const results: Record<string, unknown> = {}
const resultsPath = join(output, "results.json")
// Replace any previous green result immediately and leave a terminal marker on
// failure, so a crashed rerun cannot be mistaken for a PASS.
function marker(status: "RUNNING" | "FAIL" | "PASS", details: Record<string, unknown> = {}): void {
  writeFileSync(resultsPath, JSON.stringify({ kind: "synthetic-packed-entrypoint", status, results, ...details }, null, 2) + "\n")
}
marker("RUNNING")
const delay = (ms: number) => Bun.sleep(ms)
async function until(fn: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout
  while (!fn()) {
    if (Date.now() >= end) throw new Error("condition timed out")
    await delay(20)
  }
}
function records(dir: string, file = "publication.jsonl"): any[] {
  try { return readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) }
  catch { return [] }
}
function evidenceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? evidenceFiles(join(dir, entry.name)) : /\.(json|jsonl)$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
class Host {
  readonly proc: ReturnType<typeof Bun.spawn>
  private seq = 0
  private replies = new Map<number, (value: any) => void>()
  readonly ready: Promise<void>
  constructor(readonly root: string, socket: string, identity = "local", metadata?: unknown) {
    mkdirSync(root, { recursive: true })
    this.proc = Bun.spawn([process.execPath, join(import.meta.dir, "packed-host-process.ts"), installation!, join(root, "runtime"), join(root, "evidence"), identity], {
      env: { ...process.env, DISCORD_IPC_PATH: socket, PACKED_HOST_METADATA: JSON.stringify(metadata ?? {}) },
      stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(root, `stderr-${Date.now()}.log`)),
    })
    children.add(this)
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
        rejectReady(new Error("host exited before ready"))
      })().catch(rejectReady)
    })
  }
  get evidence(): string { return join(this.root, "evidence") }
  call(action: string, value?: unknown, app?: unknown): Promise<any> {
    const id = ++this.seq
    const reply = new Promise((resolveReply) => this.replies.set(id, resolveReply))
    ;(this.proc.stdin as any).write(JSON.stringify({ id, action, value, app }) + "\n")
    return Promise.race([reply, delay(15_000).then(() => { throw new Error(`host command timeout: ${action}`) })])
  }
  db(): Database { return new Database(join(this.root, "runtime", "publisher.sqlite")) }
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return
    await this.call("dispose")
    ;(this.proc.stdin as any).end()
    await this.proc.exited
    children.delete(this)
  }
}
async function endpoint(name: string, options: Record<string, unknown> = {}): Promise<FakeDiscord> {
  const fake = new FakeDiscord({ path: join(output!, `${name}.sock`), ...options })
  endpoints.add(fake)
  await fake.start()
  return fake
}
async function host(name: string, fake: FakeDiscord, identity = "local", metadata?: unknown): Promise<Host> {
  const h = new Host(join(output!, name), fake.path, identity, metadata)
  await h.ready
  return h
}
function acks(h: Host): any[] { return records(h.evidence).filter((r) => r.attempt === "command-publish" && r.rpcOk === true) }
function starts(fake: FakeDiscord): number[] { return fake.activityFrames().map((frame: any) => frame.payload.args.activity?.timestamps.start).filter((v) => v !== undefined) }
function frozen(fake: FakeDiscord, seconds = 1_750_000_000): void { assert.deepEqual([...new Set(starts(fake))], [seconds]) }
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  results[name] = "PASS"
  console.log(`PASS ${name}`)
  marker("RUNNING")
}
try {
  await test("newest-assistant-identity-never-substitutes-supported-history", async () => {
    const fake = await endpoint("newest-assistant")
    const older = { type: "assistant", model: { id: "deepseek-v4.1-flash-free", providerID: "opencode" }, agent: "build" }
    const credential = { credentials: { token: "NEWEST_CREDENTIAL_CONTAINER", path: "/home/NEWEST_PRIVATE/file" } }
    const cases = [
      { name: "container-model", model: { ...older.model, id: credential }, agent: "plan", code: "executed-model-unknown" },
      { name: "unsupported-model", model: { ...older.model, id: "unsupported-newest-model" }, agent: "plan", code: "executed-model-unknown" },
      { name: "container-provider", model: { ...older.model, providerID: credential }, agent: "plan", code: "executed-provider-unknown" },
      { name: "unsupported-provider", model: { ...older.model, providerID: "unsupported-newest-provider" }, agent: "plan", code: "executed-provider-unknown" },
      { name: "container-variant", model: { ...older.model, variant: credential }, agent: "plan", code: "executed-variant-unknown" },
      { name: "unsupported-variant", model: { ...older.model, variant: "unsupported-newest-variant" }, agent: "plan", code: "executed-variant-unknown" },
      { name: "container-agent", model: older.model, agent: credential, code: "executed-agent-unknown" },
      { name: "agent-path", model: older.model, agent: "unsupported/newest-agent", code: "executed-agent-unknown" },
      { name: "agent-query", model: older.model, agent: "unsupported/newest-agent=value", code: "executed-agent-unknown" },
    ]
    const assertPrivate = (h: Host): void => {
      for (const file of evidenceFiles(h.evidence)) {
        const content = readFileSync(file, "utf8")
        for (const token of ["NEWEST_CREDENTIAL_CONTAINER", "/home/NEWEST_PRIVATE/file", "unsupported-newest-", "unsupported/newest-agent"]) {
          assert(!content.includes(token), `newest-assistant identity leaked in ${file}`)
        }
      }
    }
    for (const anchored of [false, true]) for (const identity of cases) {
      const h = await host(`newest-${identity.name}-${anchored ? "anchored" : "unanchored"}`, fake)
      if (anchored) {
        await h.call("publish")
        await until(() => acks(h).length === 1)
      }
      await h.call("set", { messages: [
          { type: "user", time: { created: 1_750_000_000_123 } },
          older,
          { type: "assistant", model: identity.model, agent: identity.agent },
          { type: "user", time: { created: 1_750_000_010_123 } },
        ], agent: "build" })
      await h.call("snapshot")
      const connectionsBefore = fake.connections
      const framesBefore = fake.activityFrames().length
      assert.equal((await h.call("publish")).ok, true)
      await until(() => records(h.evidence).some((r) => r.code === identity.code))
      const publication = records(h.evidence).filter((r) => r.attempt === "command-publish").at(-1)
      assert.equal(publication.code, identity.code)
      assert.equal(publication.phase, "pre-enqueue")
      assert.equal(publication.nonce, undefined)
      assert.equal(acks(h).length, anchored ? 1 : 0)
      assert.equal(fake.activityFrames().length, framesBefore, "unsupported newest identity must not enqueue")
      assert.equal(fake.connections, connectionsBefore, "refused identity must not open a connection")
      const snapshot = JSON.parse(readFileSync(join(h.evidence, "snapshot.json"), "utf8"))
      assert.equal(snapshot.inspection.agent, ["plan"].includes(identity.agent as string) ? "plan" : null)
      if (identity.name.includes("model") || identity.name.includes("provider") || identity.name.includes("variant")) assert.equal(snapshot.inspection.executedModel, null)
      const db = h.db()
      assert.equal((db.query("SELECT count(*) AS n FROM anchor").get() as any).n, anchored ? 1 : 0)
      if (anchored) assert.equal((db.query("SELECT seconds FROM anchor").get() as any).seconds, 1_750_000_000)
      assert.equal((db.query("SELECT count(*) AS n FROM anchor_pending").get() as any).n, 0)
      db.close()
      if (anchored) await h.call("disconnect")
      await h.stop()
      assertPrivate(h)
    }
    const h = await host("newest-supported", fake, "local", { state: {
      messages: [
        { type: "user", time: { created: 1_750_000_000_123 } },
        older,
        { type: "assistant", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", credentials: credential }, agent: "plan", content: credential },
      ],
      agent: "build",
    } })
    await h.call("publish")
    await until(() => acks(h).length === 1)
    assert.deepEqual(acks(h)[0].modelProvenance.executed, { id: "deepseek-v4.1-flash", providerID: "opencode-go" })
    assert.equal(acks(h)[0].modelProvenance.agent, "plan")
    await h.call("set", { messages: [
      older,
      { type: "user", time: { created: 1_750_000_010_123 } },
      { type: "assistant", model: { ...older.model, credentials: credential }, agent: "build", content: credential },
    ] })
    await h.call("publish")
    await until(() => acks(h).length === 2)
    assert.deepEqual(acks(h)[1].modelProvenance.executed, older.model)
    assert.equal(acks(h)[1].modelProvenance.agent, "build")
    assert.equal(acks(h)[1].activity.timestamps.start, acks(h)[0].activity.timestamps.start)
    await h.call("disconnect")
    await h.stop()
    assertPrivate(h)
  })
  await test("host-reasoning-variants-and-agent-vocabularies", async () => {
    const fake = await endpoint("vocabulary")
    const base = { id: "deepseek-v4.1-flash", providerID: "opencode-go" }
    const messages = (model: unknown, agent: string) => ({ state: { messages: [
      { type: "user", time: { created: 1_750_000_000_123 } },
      { type: "assistant", model, agent },
    ] } })

    for (const variant of ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const h = await host(`variant-${variant}`, fake, "local", messages({ ...base, variant }, "build"))
      await h.call("publish")
      await until(() => acks(h).length === 1)
      assert.equal(acks(h)[0].phase, "acknowledged")
      assert.equal(acks(h)[0].modelProvenance.executed.variant, variant, `variant ${variant} must survive provenance`)
      await h.call("disconnect")
      await h.stop()
    }

    const nullVariant = await host("variant-null", fake, "local", messages({ ...base, variant: null }, "build"))
    await nullVariant.call("publish")
    await until(() => acks(nullVariant).length === 1)
    assert.deepEqual(acks(nullVariant)[0].modelProvenance.executed, base, "a null variant publishes as no variant")
    assert.equal("variant" in acks(nullVariant)[0].modelProvenance.executed, false)
    await nullVariant.call("disconnect")
    await nullVariant.stop()

    for (const agent of ["general", "compaction", "my-reviewer"]) {
      const h = await host(`agent-${agent}`, fake, "local", messages(base, agent))
      await h.call("publish")
      await until(() => acks(h).length === 1)
      assert.equal(acks(h)[0].modelProvenance.agent, agent, `agent ${agent} must survive provenance`)
      await h.call("disconnect")
      await h.stop()
    }

    // Availability refusals use a dedicated endpoint so zero connections means
    // zero, not merely "no new connection after an earlier success".
    const refused = await endpoint("vocabulary-refusal")
    const refusal = async (name: string, metadata: unknown, code: string): Promise<void> => {
      const h = await host(name, refused, "local", metadata)
      const frames = refused.activityFrames().length
      assert.equal((await h.call("publish")).ok, true)
      await until(() => records(h.evidence).some((r) => r.code === code))
      const publication = records(h.evidence).filter((r) => r.attempt === "command-publish").at(-1)
      assert.equal(publication.phase, "pre-enqueue")
      assert.equal(publication.nonce, undefined)
      assert.equal(refused.activityFrames().length, frames, `${code} must not enqueue`)
      assert.equal(refused.connections, 0, `${code} must not open a connection`)
      assert.equal(acks(h).length, 0)
      await h.stop()
    }
    for (const agent of ["bad/agent", "bad=agent"]) await refusal(`refuse-agent-${agent.includes("/") ? "path" : "query"}`, messages(base, agent), "executed-agent-unknown")
    await refusal("refuse-variant", messages({ ...base, variant: "ultra" }, "build"), "executed-variant-unknown")
    await refusal("refuse-model", messages({ ...base, id: "unsupported-vocabulary-model" }, "build"), "executed-model-unknown")
    await refusal("refuse-provider", messages({ ...base, providerID: "unsupported-vocabulary-provider" }, "build"), "executed-provider-unknown")
    await refusal("refuse-no-session", { state: { home: true } }, "no-observed-session")
  })
  await test("authorized-rejection-closure-and-reconnect", async () => {
    const fake = await endpoint("rejection", { rejectOnce: true })
    const h = await host("rejection", fake)
    await h.call("publish")
    await until(() => records(h.evidence).some((r) => r.code === "rpc-rejected" && r.phase === "post-enqueue" && r.nonce && r.cmd === "SET_ACTIVITY"))
    assert.equal(acks(h).length, 0)
    await h.call("set", { created: 1_750_000_010_123 })
    await h.call("publish")
    frozen(fake)
    await h.call("disconnect")
    await h.call("publish")
    assert.equal(fake.connections, 2)
    await h.call("disconnect")
    await h.stop()
  })
  await test("concurrent-changing-message-delayed-ACK-reload", async () => {
    const fake = await endpoint("concurrent", { responseDelayMs: 300 })
    const h = await host("concurrent", fake)
    const first = h.call("publish")
    await until(() => starts(fake).length === 1)
    await h.call("set", { created: 1_750_000_010_123 })
    const second = h.call("publish"), third = h.call("publish")
    await delay(100)
    assert.equal(starts(fake).length, 1, "entire sequence must wait for ACK")
    await Promise.all([first, second, third])
    await until(() => acks(h).length === 3)
    frozen(fake)
    await h.stop()
    const reload = await host("concurrent", fake)
    await reload.call("set", { created: 1_750_000_020_123 })
    await reload.call("publish")
    frozen(fake)
    await reload.call("disconnect")
    await reload.stop()
  })
  await test("ACK-DB-lock-retry-and-no-newer-anchor", async () => {
    const fake = await endpoint("ack-lock", { responseDelayMs: 300 })
    const h = await host("ack-lock", fake)
    const first = h.call("publish")
    await until(() => starts(fake).length === 1)
    const db = h.db()
    db.exec("BEGIN IMMEDIATE")
    await first
    await until(() => acks(h).length === 1)
    assert.equal(acks(h)[0].code, "anchor-persist-failed")
    assert.equal(acks(h)[0].timestampProvenance.anchorCommitted, false)
    await h.call("set", { created: 1_750_000_010_123 })
    await h.call("publish")
    assert.equal(starts(fake).length, 1)
    db.exec("COMMIT")
    await until(() => !!db.query("SELECT seconds FROM anchor").get(), 6000)
    assert.equal((db.query("SELECT seconds FROM anchor").get() as any).seconds, 1_750_000_000)
    await h.call("publish")
    frozen(fake)
    db.close()
    await h.call("disconnect")
    await h.stop()
  })
  await test("disconnect-clear-refused-under-held-write-lock", async () => {
    const fake = await endpoint("clear-refused")
    const h = await host("clear-refused", fake)
    await h.call("publish")
    await until(() => acks(h).length === 1)
    const framesBefore = fake.activityFrames().length
    const db = h.db()
    // Hold the writer lock from outside the plugin. The clear then reaches the
    // production disconnect path with a ready socket and a live owner, but the
    // synchronous owner/fence + enqueue transaction cannot start (busy). This is
    // the only reachable route to clear-refused: a revoked publisher is refused
    // as no-socket because onRevoked destroys the socket first. No bundle hook
    // is involved; the lock is an ordinary external SQLite connection.
    db.exec("BEGIN IMMEDIATE")
    await h.call("disconnect")
    await until(() => records(h.evidence).some((r) => r.code === "clear-refused"))
    const refusal = records(h.evidence).find((r) => r.code === "clear-refused")
    assert.equal(refusal.attempt, "disconnect-command")
    assert.equal(refusal.phase, "pre-enqueue")
    assert.equal(refusal.nonce, undefined)
    assert.equal(fake.activityFrames().length, framesBefore, "a refused clear must not enqueue a frame")
    db.exec("ROLLBACK")
    db.close()
    await h.stop()
  })
  await test("persistence-failure-reload-pending-distinct-from-ACK", async () => {
    const fake = await endpoint("persist-fail", { responseDelayMs: 300 })
    const h = await host("persist-fail", fake)
    const first = h.call("publish")
    await until(() => starts(fake).length === 1)
    const db = h.db()
    db.exec("CREATE TRIGGER fail_anchor BEFORE INSERT ON anchor BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END")
    await first
    assert.equal((db.query("SELECT count(*) AS n FROM anchor").get() as any).n, 0)
    assert.equal((db.query("SELECT count(*) AS n FROM anchor_pending").get() as any).n, 1)
    await h.stop()
    const reload = await host("persist-fail", fake)
    await reload.call("set", { created: 1_750_000_010_123 })
    await reload.call("publish")
    frozen(fake)
    await until(() => acks(reload).length === 2)
    assert.equal(acks(reload)[1].timestampProvenance.committed, false, "pending intent must not be reported as ACK-committed")
    db.exec("DROP TRIGGER fail_anchor")
    await until(() => !!db.query("SELECT seconds FROM anchor").get(), 6000)
    assert.equal((db.query("SELECT count(*) AS n FROM anchor_pending").get() as any).n, 0)
    db.close()
    await reload.call("disconnect")
    await reload.stop()
  })
  await test("stored-anchor-conflict-blocks-before-and-after-reload", async () => {
    const fake = await endpoint("conflict", { responseDelayMs: 300 })
    const h = await host("conflict", fake)
    const first = h.call("publish")
    await until(() => starts(fake).length === 1)
    const db = h.db()
    const pending: any = db.query("SELECT * FROM anchor_pending").get()
    db.query("INSERT INTO anchor VALUES (?, ?, ?, ?)").run(pending.session_key, 1_750_000_010, 1_750_000_010_123, Date.now())
    await first
    await h.call("set", { created: 1_750_000_010_123 })
    const connectionsBefore = fake.connections
    await h.call("publish")
    assert.equal(starts(fake).length, 1)
    await until(() => records(h.evidence).some((r) => r.code === "anchor-conflict"))
    assert.equal(fake.connections, connectionsBefore, "a proven anchor conflict must not open a connection")
    await h.stop()
    const reload = await host("conflict", fake)
    const reloadConnections = fake.connections
    await reload.call("publish")
    assert.equal(starts(fake).length, 1)
    await until(() => records(reload.evidence).some((r) => r.code === "anchor-conflict"))
    assert.equal(fake.connections, reloadConnections, "a reloaded anchor conflict must not open a connection")
    db.close()
    await reload.call("disconnect")
    await reload.stop()
  })
  await test("dispose-pending-handshake-and-queued-commands", async () => {
    const fake = await endpoint("dispose-handshake", { handshakeDelayMs: 600 })
    const h = await host("dispose-handshake", fake)
    const publishing = h.call("publish")
    await until(() => fake.frames.length === 1)
    const disposal = await h.call("dispose")
    await publishing
    await h.call("snapshot")
    await h.call("disconnect")
    await delay(800)
    const stats = await h.call("stats")
    assert.equal(stats.toasts, disposal.toasts)
    assert.equal(fake.closedConnections, 1)
    assert.equal(fake.activityFrames().length, 0)
    assert(!records(h.evidence).some((r) => r.attempt === "ready"))
    await h.stop()
  })
  await test("dispose-pending-ACK-and-snapshot-no-late-writes", async () => {
    const fake = await endpoint("dispose-ack", { responseDelayMs: 700 })
    const h = await host("dispose-ack", fake)
    const publishing = h.call("publish")
    await until(() => starts(fake).length === 1)
    await h.call("set", { empty: true, syncDelay: 800 })
    const snapshot = h.call("snapshot")
    const disposal = await h.call("dispose")
    const sizes = evidenceFiles(h.evidence).map((p) => [p, statSync(p).size])
    await Promise.all([publishing, snapshot])
    await delay(900)
    assert.equal((await h.call("stats")).toasts, disposal.toasts)
    assert.deepEqual(evidenceFiles(h.evidence).map((p) => [p, statSync(p).size]), sizes)
    assert.equal(fake.closedConnections, 1)
    assert.equal(fake.connections, 1)
    assert.equal(acks(h).length, 0)
    await h.stop()
  })
  await test("two-unknown-servers-same-session-refuse-with-no-anchor", async () => {
    const fake = await endpoint("unknown")
    for (const name of ["unknown-a", "unknown-b"]) {
      const h = await host(name, fake, "unknown")
      await h.call("publish")
      await until(() => records(h.evidence).some((r) => r.code === "identity-unknown" && r.phase === "pre-enqueue" && !r.nonce))
      const db = h.db()
      assert.equal((db.query("SELECT count(*) AS n FROM anchor").get() as any).n, 0)
      assert.equal((db.query("SELECT count(*) AS n FROM anchor_pending").get() as any).n, 0)
      db.close()
      await h.stop()
    }
    assert.equal(fake.connections, 0)
  })
  await test("metadata-every-source-refused-publications-and-capture-privacy", async () => {
    const fake = await endpoint("privacy")
    const h = await host("privacy", fake)
    const secrets: unknown[] = [
      "/home/CRITIC_SECRET/file", "https://user:password@private.example/v1",
      "Error: CREDENTIAL_STACK\n at /private/file.ts:1:1", "sk-live-CRITIC-SECRET",
      { credentials: { token: "CREDENTIAL_CONTAINER_VALUE", path: "/home/CRITIC_SECRET/file" } },
    ]
    for (const secret of secrets) {
      await h.call("set", {
        executed: { id: secret, providerID: secret, variant: secret },
        selected: { modelID: secret, providerID: secret, variant: secret },
        sessionModel: { id: secret, providerID: secret, variant: secret },
        agent: secret, messageAgent: secret, cost: secret,
        tokens: { input: secret, output: secret, reasoning: secret, cache: { read: secret, write: secret } },
      })
      await h.call("snapshot")
      await h.call("publish")
      for (const type of [secret, "session.model.selected", "session.agent.selected", "session.execution.failed"]) {
        await h.call("event", { id: "evt_secret", type, data: { sessionID: "ses_packed", model: { id: secret, providerID: secret }, agentID: secret, error: secret, credentials: secret } })
      }
    }
    await h.stop()
    assert.equal(fake.activityFrames().length, 0)
    assert.equal(fake.connections, 0, "refused privacy publications must not connect")
    for (const file of evidenceFiles(h.evidence)) {
      const content = readFileSync(file, "utf8")
      for (const secret of ["CRITIC", "CREDENTIAL", "user:password", "/private/file"]) assert(!content.includes(secret), `privacy leak in ${file}`)
    }
    assert(records(h.evidence).some((r) => r.code === "executed-model-unknown"))
    for (const [index, secret] of secrets.entries()) {
      const appHost = await host(`privacy-app-${index}`, fake, "local", { app: { version: secret, channel: secret } })
      await appHost.call("snapshot")
      await appHost.stop()
      for (const file of evidenceFiles(appHost.evidence)) {
        const content = readFileSync(file, "utf8")
        for (const token of ["CRITIC", "CREDENTIAL", "user:password", "/private/file"]) assert(!content.includes(token), `app metadata leak in ${file}`)
      }
    }
  })
  await test("pending-intent-post-ACK-outside-transaction-SIGSTOP-takeover-revoked-refusal-kill-recovery", async () => {
    const fake = await endpoint("takeover", { responseDelayMs: 300 })
    const a = await host("takeover", fake)
    const first = a.call("publish")
    await until(() => starts(fake).length === 1)
    const db = a.db()
    db.exec("CREATE TRIGGER fail_anchor BEFORE INSERT ON anchor BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    await first
    const b = await host("takeover", fake)
    // Publication, ACK and its failed persistence attempt have returned.
    // SIGSTOP is outside any ownership write transaction; this does NOT
    // demonstrate bounded takeover while a suspended writer holds SQLite.
    process.kill(a.proc.pid, "SIGSTOP")
    await until(() => (db.query("SELECT pid FROM owner").get() as any)?.pid === b.proc.pid, 16_000)
    db.exec("DROP TRIGGER fail_anchor")
    await b.call("set", { created: 1_750_000_010_123 })
    await b.call("publish")
    frozen(fake)
    process.kill(a.proc.pid, "SIGCONT")
    await delay(2500)
    const count = starts(fake).length
    const connectionsBeforeRefusal = fake.connections
    await a.call("publish")
    assert.equal(starts(fake).length, count)
    assert.equal(fake.connections, connectionsBeforeRefusal, "a refused non-owner publication must not open a connection")
    await a.stop()
    // b's ACK/reconciliation has completed too: kill recovery is tested at
    // this outside-transaction point, not inside the synchronous enqueue.
    process.kill(b.proc.pid, "SIGKILL")
    await b.proc.exited
    children.delete(b)
    const c = await host("takeover", fake)
    await until(() => (db.query("SELECT pid FROM owner").get() as any)?.pid === c.proc.pid, 16_000)
    await c.call("set", { created: 1_750_000_020_123 })
    await c.call("publish")
    frozen(fake)
    await c.call("disconnect")
    await c.stop()
    assert.equal((db.query("SELECT count(*) AS n FROM owner").get() as any).n, 0)
    db.close()
  })
} catch (error) {
  marker("FAIL", { error: error instanceof Error ? error.message : String(error) })
  throw error
} finally {
  for (const child of children) {
    try { process.kill(child.proc.pid, "SIGCONT"); await child.stop() }
    catch { child.proc.kill("SIGKILL") }
  }
  for (const fake of endpoints) await fake.stop()
}
marker("PASS")
console.log(`Packed entrypoint: ${Object.keys(results).length} scenarios PASS (synthetic host + fake Discord)`)
