import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { makeEvidenceFixture } from "./fixtures/m0-evidence.js"

const labRoot = "/tmp/opencode"
const REPO = resolve(import.meta.dir, "..")
const SCRIPT = join(REPO, "scripts", "m0-evidence.ts")
const dirs: string[] = []

function fixture(): string {
  const dir = mkdtempSync(join(labRoot, "m0-validator-"))
  dirs.push(dir)
  makeEvidenceFixture(dir)
  return dir
}

function runValidator(dir: string): { code: number; output: string } {
  const result = Bun.spawnSync([process.execPath, SCRIPT, dir], { cwd: REPO, stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode ?? -1, output: (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "") }
}

function expectPass(dir: string): void {
  const result = runValidator(dir)
  if (result.code !== 0) throw new Error(`expected PASS, got ${result.code}\n${result.output.slice(-4000)}`)
}

function expectFail(name: string, mutate: (dir: string) => void): void {
  test(name, () => {
    const dir = fixture()
    mutate(dir)
    const result = runValidator(dir)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("M0 evidence: FAIL")
  })
}

function editJson(dir: string, name: string, edit: (value: any) => void): void {
  const path = join(dir, name)
  const value = JSON.parse(readFileSync(path, "utf8"))
  edit(value)
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

function editJsonl(dir: string, name: string, edit: (records: any[]) => void): void {
  const path = join(dir, name)
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  edit(records)
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
}

afterEach(() => {
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe("M0 evidence validator", () => {
  test("accepts the complete positive fixture", () => {
    expectPass(fixture())
  })

  describe("mandatory documents", () => {
    expectFail("missing run.json", (dir) => rmSync(join(dir, "run.json")))
    expectFail("null run.json", (dir) => writeFileSync(join(dir, "run.json"), "null\n"))
    expectFail("malformed run.json", (dir) => writeFileSync(join(dir, "run.json"), "{not json\n"))
    expectFail("array-valued run.json", (dir) => writeFileSync(join(dir, "run.json"), "[]\n"))
    expectFail("wrong-typed run.json host.version", (dir) => editJson(dir, "run.json", (run) => (run.host.version = 230)))
    expectFail("incomplete run.json", (dir) => editJson(dir, "run.json", (run) => delete run.imports))
    expectFail("missing locality.json", (dir) => rmSync(join(dir, "locality.json")))
    expectFail("missing remote.json", (dir) => rmSync(join(dir, "remote.json")))
    expectFail("missing coverage.json", (dir) => rmSync(join(dir, "coverage.json")))
    expectFail("missing reload.json", (dir) => rmSync(join(dir, "reload.json")))
    expectFail("missing canaries.json", (dir) => rmSync(join(dir, "canaries.json")))
    expectFail("missing publication.jsonl", (dir) => rmSync(join(dir, "publication.jsonl")))
    expectFail("missing reference.jsonl", (dir) => rmSync(join(dir, "reference.jsonl")))
    expectFail("missing publisher log", (dir) => rmSync(join(dir, "publisher-22222222-2222-4222-8222-222222222222.jsonl")))
    expectFail("incomplete snapshot", (dir) => editJson(dir, "snapshot-11111111-1111-4111-8111-111111111111.json", (snapshot) => delete snapshot.inspection))
    expectFail("array-valued JSONL record", (dir) => writeFileSync(join(dir, "publication.jsonl"), "[1,2,3]\n"))
    expectFail("incomplete publication record", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        delete records.find((record) => record.attempt === "command-publish" && record.rpcOk).at
      }),
    )
    expectFail("wrong-typed publication rpcOk", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        records.find((record) => record.attempt === "command-publish" && record.rpcOk).rpcOk = "yes"
      }),
    )
    expectFail("wrong-typed publisher fence", (dir) =>
      editJsonl(dir, "publisher-11111111-1111-4111-8111-111111111111.jsonl", (records) => {
        records.find((record) => record.kind === "acquire").fence = "1"
      }),
    )
    expectFail("invalid inspection status", (dir) =>
      editJson(dir, "snapshot-11111111-1111-4111-8111-111111111111.json", (snapshot) => (snapshot.inspection.status = "sleeping")),
    )
    expectFail("wrong-typed locality evidence", (dir) => editJson(dir, "locality.json", (locality) => (locality.evidence.urlCount = "one")))
    expectFail("capture record with an extra key", (dir) =>
      editJsonl(dir, "capture.jsonl", (records) => {
        records[0].injected = "M0CANARY_FIXTURE_PROMPT"
      }),
    )
  })

  describe("scenario evidence", () => {
    expectFail("missing failed-turn scenario", (dir) =>
      editJsonl(dir, "capture.jsonl", (records) => {
        const kept = records.filter((record) => record.type !== "session.execution.failed")
        records.splice(0, records.length, ...kept)
      }),
    )
    expectFail("missing READY handshake", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const kept = records.filter((record) => record.attempt !== "ready")
        records.splice(0, records.length, ...kept)
      }),
    )
    expectFail("missing acknowledgement", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const record = records.find((entry) => entry.rpcOk === true && entry.attempt === "command-publish")
        delete record.rpcOk
      }),
    )
    expectFail("missing decision evidence", (dir) => editJson(dir, "reload.json", (reload) => (reload.reloadReranSetup = false)))
  })

  describe("publication provenance", () => {
    expectFail("only one acknowledged publication", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const successes = records.filter((record) => record.attempt === "command-publish" && record.rpcOk === true)
        const first = successes[0]
        const kept = records.filter((record) => record.attempt !== "command-publish" || record.rpcOk !== true || record === first)
        records.splice(0, records.length, ...kept)
      }),
    )
    expectFail("no same-session repeat", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        let n = 0
        for (const record of records) if (record.attempt === "command-publish" && record.rpcOk) record.sessionHash = (++n).toString(16).padStart(16, "0")
      }),
    )
    expectFail("same-session repeats under 4 seconds", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const base = Date.parse(records.find((record) => record.attempt === "ready").at)
        let n = 0
        for (const record of records) {
          if (record.attempt === "command-publish" && record.rpcOk) {
            record.at = new Date(base + 4100 + n * 100).toISOString()
            n += 1
          }
        }
      }),
    )
    expectFail("missing timestamp provenance", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        delete records.find((record) => record.attempt === "command-publish" && record.rpcOk).timestampProvenance
      }),
    )
    expectFail("changed timestamp anchor", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const record = records.find((entry) => entry.attempt === "command-publish" && entry.rpcOk)
        record.activity.timestamps.start += 1
        record.timestampProvenance.seconds += 1
      }),
    )
    expectFail("incorrect milliseconds-to-seconds conversion", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const record = records.find((entry) => entry.attempt === "command-publish" && entry.rpcOk)
        record.timestampProvenance.originalValue += 1000
      }),
    )
    expectFail("missing model provenance", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        delete records.find((record) => record.attempt === "command-publish" && record.rpcOk).modelProvenance
      }),
    )
    expectFail("missing session identity", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        delete records.find((record) => record.attempt === "command-publish" && record.rpcOk).sessionHash
      }),
    )
    expectFail("missing owner identity", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        records.find((record) => record.attempt === "command-publish" && record.rpcOk).instanceId = "00000000-0000-4000-8000-000000000000"
      }),
    )
    expectFail("missing fence", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        delete records.find((record) => record.attempt === "command-publish" && record.rpcOk).fence
      }),
    )
  })

  describe("ownership and fencing", () => {
    expectFail("publication before acquisition", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        records.find((record) => record.attempt === "command-publish" && record.rpcOk).at = new Date(1_750_000_000_000 - 1000).toISOString()
      }),
    )
    expectFail("publication after release", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const target = records.filter((record) => record.attempt === "command-publish" && record.rpcOk && record.instanceId === "22222222-2222-4222-8222-222222222222")[0]
        target.at = new Date(1_750_000_000_000 + 16_500).toISOString()
      }),
    )
    expectFail("stale or mismatched fence", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        records.find((record) => record.attempt === "command-publish" && record.rpcOk).fence = 2
      }),
    )
    expectFail("overlapping owners", (dir) =>
      editJsonl(dir, "publisher-11111111-1111-4111-8111-111111111111.jsonl", (records) => {
        records.push({ v: 1, kind: "acquire", atMs: 1_750_000_000_000 + 11_500, instanceId: "11111111-1111-4111-8111-111111111111", pid: 4001, generation: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", fence: 9 })
      }),
    )
    expectFail("refused operation that enqueued a nonce", (dir) =>
      editJsonl(dir, "publication.jsonl", (records) => {
        const refused = records.find((record) => record.code === "not-owner")
        refused.nonce = "77777777-7777-4777-8777-777777777777"
      }),
    )
  })

  describe("identity claims", () => {
    expectFail("unknown identity allowing enrichment", (dir) =>
      editJson(dir, "locality.json", (locality) => {
        locality.class = "unknown"
        locality.enrichment = "allowed"
        locality.reason = "identity-incomplete"
        locality.serverFingerprint = null
        locality.evidence.hostnamePresent = false
        locality.evidence.hostnameMatches = null
        locality.evidence.urlCount = 0
        locality.evidence.allUrlsLoopback = null
      }),
    )
    expectFail("invalid locality enum", (dir) => editJson(dir, "locality.json", (locality) => (locality.class = "planet")))
    expectFail("remote success claimed without evidence", (dir) => editJson(dir, "remote.json", (remote) => (remote.claimed = true)))
    expectFail("remote identity allowing enrichment", (dir) =>
      editJson(dir, "locality.json", (locality) => {
        locality.class = "remote"
        locality.enrichment = "allowed"
        locality.reason = "host-mismatch"
      }),
    )
  })
})
