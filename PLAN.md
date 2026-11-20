# opencode-discord-rpc — Project Plan

Discord Rich Presence for OpenCode V2, built from the strengths of three existing
community plugins and none of their bugs.

Status: **plan + working release-development build**. This document describes the
intended M0→M6 architecture; it is not a current status report. The implemented
release path, its limits and its verification live in [README.md](./README.md) and
[CHANGELOG.md](./CHANGELOG.md). M0 remains available through explicit
`options.m0` and keeps its original evidence contract.

---

## 1. Goal and scope

**Goal.** A presence card that is correct, honest, private by default, and
installable in one line — the thing all three references almost are.

**v1 supported environment (explicit, not implied):**

- OpenCode **v2.3.0+**, TUI/CLI, local machine, local desktop session.
- Discord **Desktop** running on the same machine (Linux first; macOS/Windows code
  paths written but untested in v1).
- Single OS user; multiple OpenCode terminals on that machine are supported.

**Non-goals for v1:**

- `opencode run`, Mini, headless/CI, SSH sessions, containers without Discord access.
- OpenCode Desktop app (GUI part), server-only hosts, web client (`opencode pair`).
- Windows/macOS certification, cross-user arbitration.
- V1 OpenCode support.

Missing Discord is a **normal disconnected state**, never a startup error. If the
connected OpenCode server is remote, DB enrichment is refused and the plugin runs
events-only.

---

## 2. Decisions locked

| Decision | Value |
|---|---|
| Stack | TypeScript, single package |
| Build | `bun build` → bundled ESM; `bun test` |
| Distribution | published npm package (`0.0.1` only after Jury acceptance and explicit user authorization) |
| npm name | `opencode-presence-discord` (verified free) |
| First surface | TUI part only (`./tui`), installed via `cli.json` |
| Discord client ID | `1572459187873783838` (public; overridable per user) |
| Runtime deps | `@opencode/plugin` declared; host packages kept external in the bundle |
| Node baseline | Node 26.11.1 present; Bun installed as the build tool |

The Discord **public key was supplied but is not used** by Rich Presence and must
not be committed.

---

## 3. What the references taught us

| | Puri12 `opencode-discord-presence` 0.7.2 | Khip01 `opencode-rich-presence` 3.6.7 | Jerit3787 `opencode-discord-status` 1.0.1 |
|---|---|---|---|
| Runtime | TS plugin, ~13 transitive deps | zero-dep JS: CLI + daemon + V1 & V2 entries + TUI part | Go static binary + optional TS shim |
| V2 support | V1 factory only → will not load | real V2 server part + TUI part | plugin removed; pure SQLite polling |
| Data source | V1 hooks + SDK | V2 `ctx.event.subscribe`, `ctx.session.hook`, `ctx.tool.hook`, 1 SQLite query | `session_v2` + `session_message` read-only |
| Discord IPC | `@xhayper/discord-rpc` | hand-rolled, fire-and-forget | hand-rolled, nonce-correlated |
| Images | correct `assets` | `largeImageKey` (non-native, ignored) | none |
| Timer | session start, resets idle→busy | `Date.now()` per push (fake) | latest user message (correct) |
| Sockets | 0–9 + snap + flatpak via lib | 0–2, five temp dirs | 0–9 + snap/canary/flatpak/vesktop + `DISCORD_IPC_PATH` |
| Multi-window | per-PID heartbeat election | daemon arbitration + TUI heartbeat | none |

**Borrow:** Puri12's snapshot+reducer and leader election; Khip01's V2 event
stream, restartable subscription, protected modal states, heartbeat bus and
throttle discipline; Jerit3787's IPC protocol discipline, socket ladder, model
prettifier, cost/token formatting and election margin.

**Do not repeat:** fake timers, non-native asset fields, filename leakage despite a
privacy flag, per-event SDK logging, blocking `appendFileSync`, unauthenticated
local sockets, hardcoded `session_v2` without a capability probe, or
`tokens_input + tokens_output` presented as "tokens".

All three reference projects are MIT; borrowed code keeps attribution. Algorithms
are reimplemented from the observed behaviour in the three RE reports.

---

## 4. Verified environment facts

- OpenCode **v2.3.0**; `opencode debug paths db` → `~/.local/share/opencode/opencode.db`
  (channel-aware; use it instead of composing the path).
- DB is 947 MB with a live 16 MB WAL; `~/.config/opencode/opencode.jsonc` already
  has a `plugins` array; no `plugins/` dir yet.
- `session_v2` includes `cost`, `tokens_input/output/reasoning`,
  `tokens_cache_read`, `tokens_cache_write`, `time_busy`, `time_idle`,
  `idle_outcome`, `directory`, `agent`, `model` JSON `{id,providerID,variant}`.
- `session_message.type` includes `idle` (with `data.outcome`), `assistant` (with
  `finish`, `tokens`, `time.completed`), `user`, `compaction`, `model-switched`.
- `kv['models-dev:v2:catalog']` ≈ 12.7 MB: provider/model names, `limit.context`,
  `cost.text.{input,output,cache}`. Parse once, cache, query via `json_extract`.
- `project.name` is NULL for every row; use `project.worktree` or the session
  directory basename.
- Cache reads dominate real traffic (~25× input+output here) — the reason metrics
  must be labelled precisely.
- `bun` absent, `npm` unauthenticated: both are pre-flight items.

---

## 5. Architecture

The V2 **TUI part owns everything**: events, state, rendering, throttling and the
Discord socket. It is the component most likely to sit beside the user's Discord
client; a server part may be remote or a shared background service, so it cannot
own the socket.

```
TUI part (local, one per terminal)
  context.data.listen ──► reducer ──► snapshot ──► renderer ──► throttle ──► Discord IPC
  context.data.session.*  (reconcile)              │
  context.data.location.* (model, vcs)             │
  publisher lock (XDG_RUNTIME_DIR) ──► only the fenced leader pushes
  DB enrichment (guarded) ──► cache tokens / context / catalog prices
```

```
src/
  tui.tsx              Plugin.define({ id, setup }) — wiring only
  core/
    reducer.ts         event → PresenceState (session-scoped)
    sessions.ts        candidate election: busy > idle, 10 s margin, server-qualified
    renderer.ts        templates, per-state overrides, rotation, truncation
    catalog.ts         models-dev catalog: context limit, prices (cached)
    db.ts              path resolution, capability probe, read-only queries
    election.ts        publisher lock, fence tokens, heartbeat
    throttle.ts        4 s floor, instant on state/project/model change
  discord/
    sockets.ts         flatpak/canary/vesktop/snap + 0–9 + DISCORD_IPC_PATH
    ipc.ts             8-byte LE framing, handshake, nonce correlation, PING/PONG
    presence.ts        SET_ACTIVITY with real `assets` and real timestamps
  config.ts            JSONC, validated, env overrides, warnings
  cli.ts               doctor | once | health --json
test/
  fake-discord.ts      fragmentation, coalescing, errors, delays, disconnects
  fixtures/            synthetic DBs + `VACUUM INTO` copy of the real DB
assets/discord/        Discord app art (uploaded manually, see §15)
```

**No daemon in v1.** Multiple terminals are arbitrated by a lock file. A daemon is
reconsidered only if Desktop support must share the card.

---

## 6. Metrics semantics (no blended numbers)

| Quantity | Source | Display |
|---|---|---|
| Cumulative usage | `session_v2.tokens_*` (input, output, reasoning, cache_read, cache_write) | `1.2M tok · 5.7B cache` |
| Current context | latest assistant message `input + cache_read + cache_write` vs catalog `limit.context` | `42% ctx`; **`ctx ?`** when unknown |
| Reported cost | `session_v2.cost` when > 0 | `$0.42` |
| Estimated cost | catalog prices × session token columns | `~$0.42 est.` |
| Included | provider list price is 0 | `included` |

Rules: never add lifetime totals to claim "context used"; never present an estimate
as reported; unknown renders as unknown.

**DB identity gate.** Enrichment runs only when the connected server is local and
the resolved DB belongs to it. Resolution order: explicit config → `opencode debug
paths db` → `$OPENCODE_DB` → `$XDG_DATA_HOME/opencode/opencode.db`. Any doubt →
events-only. Never join remote event data to a local DB.

**Schema capability probe** before use: `sqlite_master` + `pragma table_info`
(`session_v2`? `idle` message type? `time_busy`?). Ship known schema eras, degrade
gracefully, never a single hardcoded SQL string without a probe.

**Busy ladder** (cheapest first): `idle` message seq vs `assistant` seq →
`finish != 'tool-calls'` → `time_busy > time_idle` → staleness window.

**Read discipline:** read-only connection with `busy_timeout`; no `immutable` on a
live WAL DB; short statements; no per-event queries; catalog parsed once.

---

## 7. State machine

States: `working`, `thinking`, `typing`, `asking`, `compacting`, `retrying`,
`idle`, `error`.

- `session.execution.started|succeeded|failed|interrupted` — turn boundaries.
- `session.step.*`, `session.text.*`, `session.reasoning.*` — thinking vs typing.
- `session.tool.*` — working (progress/input deltas are non-committing).
- `permission.*` and `form.created|replied|cancelled` → `asking` (protected).
- `session.compaction.*` → `compacting` (protected, restores prior state).
- `session.retry.scheduled` → `retrying`.
- `session.execution.succeeded|failed|interrupted` → terminal; confirm with an
  authoritative session-state reconciliation.

**Observed on OpenCode 2.3.0 (M0, sampled):** neither `data.listen` nor the
reference `event.subscribe` stream delivered `session.idle` or `session.status`
across 11 execution starts. Treat those events as optional corroboration, not
as the terminal signal. M1 must detect terminals from
`session.execution.succeeded|failed` (plus `interrupted`), reconcile against
authoritative session state with generation guards, and keep protected states
bounded with recovery rather than assuming an idle event will arrive.

Protected states are bounded, not permanent: an authoritative reconciliation
(session state / execution terminal / last message) releases them, so one missed
terminal event cannot pin the card forever. Generation counters stop stale polls
overwriting live state. A watchdog fires only when no in-progress answer is
visible.

Subscription is restartable: `AbortController` + monotonic token; clean end or
error resubscribes with 1 s → 30 s backoff. `location.shutdown` does not clear
presence; final dispose is delayed 5 s so reloads do not flicker.

---

## 8. Arbitration

Two independent problems, two mechanisms.

1. **Who publishes.** `$XDG_RUNTIME_DIR/opencode-presence-discord/publisher.json`
   with `{pid, instanceId, hostname, startedAt, lastActivity, fence}`; atomic
   tmp+rename; 2 s heartbeat; 10 s staleness; takeover increments `fence`. Only the
   current fence holder may push or clear. Suspend/resume fencing is tested only
   at the points labelled in the suspension limitation below.
2. **Which session wins.** Candidates carry a server-qualified identity
   (`serverID + location + sessionID`); busy beats idle; then most recent activity;
   the incumbent keeps the card unless the challenger is ≥ 10 s newer. New processes
   start at `lastActivity = 0`, so launching a terminal never steals focus.

**Suspension limitation:** the guarantee is transactional ownership/fence
checking around synchronous enqueue, with serialized publication/ACK
reconciliation. It is **not** bounded takeover under arbitrary suspension. A
publisher stopped inside its SQLite write transaction can hold the writer lock
until it resumes or dies; lease expiry does not release it, and other instances
must fail closed. No unconditional takeover deadline is advertised or claimed.

**Tested suspension points:** the packed test suspends only after publication
completes — after the first publication has returned from ACK and its failed
persistence reconciliation, before the next publication — and kills after the
contender's publication has returned. Neither point deliberately suspends
inside an ownership/heartbeat transaction. The source subprocess lock-delay test
holds the write lock in a separate locker process; it demonstrates lock-delayed
takeover, not a publisher instrumented mid-transaction. There are no bundle test
hooks.

Auto-clear on the last publisher exit (SIGTERM/SIGINT with re-raise, and clean
dispose). A crashed publisher is cleared after the stale window.

---

## 9. Discord transport spec

- Frame: `[opcode u32LE][length u32LE][JSON]`; HANDSHAKE 0, FRAME 1, CLOSE 2,
  PING 3, PONG 4. Accumulate reads properly; handle fragmented **and** coalesced
  frames.
- Handshake: `{v:1, client_id}`; wait for `READY`; treat `CLOSE`/`ERROR` as errors;
  bounded timeout.
- `SET_ACTIVITY`: `args: {pid, activity: {details, state, assets:{large_image,
  large_text, small_image, small_text}, timestamps:{start}}}`; nonce-correlated
  responses; omit unknown fields rather than sending null.
- **Assets are the native object.** Never send `largeImageKey`.
- Timer: anchored to session start (latest user message / `time_busy`), recomputed
  only when the session changes — never per push.
- Clear: `{pid}` with no `activity`; only by the fence holder; 1.5 s guard before
  the next re-publish (Discord drops updates right after a clear).
- Throttle: 4 s floor; immediate on state/project/model change; dedupe on a hash of
  the full payload (images and hover texts included); keep only the latest pending
  update; republish after reconnect.
- Reconnect: socket death → 1 s → 30 s exponential with jitter; no PONG watchdog
  (Discord replies unreliably).
- Socket discovery: `$XDG_RUNTIME_DIR`, `$TMPDIR`, `/tmp`, `/run/user/*`; patterns
  `discord-ipc-N`, `snap.discord/`, `snap.discord-canary/`,
  `app/com.discordapp.Discord/`, `app/com.discordapp.DiscordCanary/`,
  `app/dev.vencord.Vesktop/`; N = 0–9; `DISCORD_IPC_PATH` short-circuits; Windows
  named pipes `\\.\pipe\discord-ipc-N`.

---

## 10. Privacy model

Outbound **allowlist**, default minimal:

| Field | Default | Opt-in |
|---|---|---|
| Project basename | on | — |
| Agent, model, provider | on | — |
| Cumulative tokens, cost | on | `metrics.showCost` etc. |
| Session title | **off** | `privacy.sessionTitle` |
| File path / name / language | **off** | `privacy.fileSpotlight` |
| Git branch | **off** | `privacy.branch` |
| Tool names, todo text | **off** | `privacy.toolDetail` |
| Errors/diagnostics detail | **off** | `privacy.diagnostics` |

Path/URL normalisation before display; user-configurable blocklist; `health --json`
reports the same sanitised view. The egress payload is one reviewed object — no
ad-hoc string building.

---

## 11. Config

`~/.config/opencode/discord-presence.json` (JSONC, comments allowed), validated:

```jsonc
{
  "enabled": true,
  "clientId": "1572459187873783838",
  "currency": "$",
  "presence": {
    "details": "Working on {project}",
    "state": "{model} · {contextPct}% ctx · {cost}",
    "byState": {
      "asking": { "details": "Waiting for you", "state": "{project}" }
    },
    "rotate": ["file", "todos", "stats"],
    "rotationIntervalSeconds": 20
  },
  "privacy": { "fileSpotlight": false, "branch": false, "sessionTitle": false },
  "assets": { "large": { "working": "state-working" }, "small": {} },
  "throttleMs": 4000,
  "debug": false
}
```

Env overrides: `DISCORD_CLIENT_ID`, `OPENCODE_PRESENCE_DISABLED`,
`OPENCODE_PRESENCE_DEBUG`, `OPENCODE_DB`, `DISCORD_IPC_PATH`.

Malformed config **warns** and keeps defaults for the bad key only — it must not
silently discard every customisation (Khip01's failure). Failures inside hooks are
caught and logged: a presence bug must never break a session.

---

## 12. Packaging and distribution

Current `package.json` reflects §2: `type: module`, `exports: {"./tui": "./dist/tui.js"}`,
`bin: {"opencode-presence": "./dist/cli.js"}`, `files: ["dist", "assets"]`,
`@opencode/plugin` as a dependency, OpenTUI/Solid as peers for the optional footer.

- Install: add `"opencode-presence-discord"` to `cli.json` `plugins` (TUI-only
  packages belong there and stay active against remote servers).
- Host packages (`@opencode/plugin`, OpenTUI, Solid, `@opencode/client`) stay
  **external** in the bundle; only our modules are bundled.
- Publish flow: `bun test` → `bun build` → `npm pack` → install the **packed
  artifact** into an isolated config → verify load and IPC → request explicit user
  authorization → `npm publish`. Passing the gates or completing the packed-artifact
  checks never publishes automatically; `npm publish` requires Jury acceptance and
  an explicit user instruction after that acceptance.
- Versioning: `0.x` through M5; each milestone independently installable.
- Loader hazards to test, not assume: a plugin dir whose entrypoint is a symlink or
  escapes the dir can be silently dropped since 2.2.0; a local `package.json` with
  `name` resolves as a package specifier.

---

## 13. Milestones and acceptance criteria

### M0 — Prove it (release-readiness gate)

1. Bun installed; scaffold builds one bundled ESM `./tui`.
2. The packed artifact installs and loads on OpenCode 2.3.0 from `cli.json` with no
   `.` export. `node:net` and the chosen SQLite API resolve in the host runtime.
3. Redacted event capture: startup mid-task, permission wait, compaction, failure,
   cancellation, reconnect, `location.shutdown`.
4. Thin slice: events → state → `SET_ACTIVITY` with real `assets` and a real
   session-anchored timestamp, verified in a live Discord client.
5. Two processes → exactly one publisher; fenced takeover after kill/suspend/resume
   at the tested suspension points in §8 (not bounded takeover under arbitrary
   suspension).
6. Remote-server integration is **descoped from M0** and remains unverified:
   unknown identity refuses local-DB enrichment and continues events-only.
   A genuine remote endpoint must be tested before remote support is claimed.
7. `0.0.1` publication requires Jury acceptance, the human visual check and
   explicit user authorization. Passing the M1–M6 gates does not authorize or
   trigger publication.

Fallback if `node:net` is unavailable in the TUI host: `Bun.spawn` a socket-owning
helper. Same package, one extra entrypoint.

### M1 — Core state

Reducer, session election, state machine, protected modals, recovery, generation
counters. Fixture-driven unit tests; fake Discord for transport.

### M2 — Rendering and config

Templates with `{var}` and conditionals, per-state overrides, rotation, truncation
(middle-truncation for paths), model prettifier (`deepseek-v4.1-flash` →
`DeepSeek V4.1 Flash`), JSONC config with per-key validation.

### M3 — Enrichment

DB identity gate, schema probe, busy ladder, cache-aware totals, context when
observable, catalog prices cached once. Tests against a `VACUUM INTO` copy; a
locked/renamed/missing DB must degrade, not crash or freeze silently.

### M4 — Transport hardening

Nonce correlation, PING/PONG, backoff+jitter, 4 s floor with instant state changes,
post-clear guard, reconnect republish, full socket ladder including flatpak and
snap. Fake server covers fragmentation, coalescing, errors, delays, restarts.

### M5 — Multi-window and lifecycle

Fence tokens, takeover, auto-clear, SIGINT/SIGTERM with re-raise, reload cleanup,
stale publisher GC.

### M6 — Ship

`doctor`, `once`, `health --json`; README with the privacy table and asset
manifest; `0.1.0` tag; optional footer indicator; Desktop GUI part deferred.

---

## 14. Risks and open questions

| Risk | Mitigation |
|---|---|
| TUI host cannot open `node:net` | M0 test; fallback helper process |
| Remote server / SSH without Discord | Scope statement; disconnected state; unknown identity refuses enrichment; genuine remote integration unverified until tested |
| Unverifiable event semantics (ordering, replay) | Capture first; reconcile from authoritative session state |
| Schema drift in `session_v2` / catalog key | Capability probe; known-era matrix; events-only fallback |
| Discord asset keys immutable after upload | Freeze the key list before uploading (§15) |
| Rate limit / dropped updates | Floor + dedupe + post-clear guard; verify empirically |
| Large DB reads, WAL contention | Read-only, short statements, busy_timeout, no per-event queries |
| Election races on suspend/resume | Fence tokens + two-process test |
| npm publishing needs auth | User runs `npm login`; publication requires Jury acceptance and explicit user authorization |

Open: whether the TUI part can see a server identity sufficient to qualify remote
sessions (M0 test 6); whether `session.cost()` matches `session_v2.cost`; whether
the footer slot needs peers at all.

---

## 15. Asset manifest and art briefs (Discord app `1572459187873783838`)

Portal rules: PNG/JPG/WebP, **1024×1024 recommended, 512×512 minimum**, keys are
**immutable once saved** (delete + re-upload to rename), max 300 assets.
`large_text` / `small_text` are hover strings set by the plugin — nothing to upload.

Art is supplied by the user and generated externally. `assets/discord/` holds the
finished PNGs named after their keys.

### Brief notes for whoever generates them

- One mark across the whole set; only the accent colour and corner glyph change.
  Seven different logos read as seven apps; one mark plus colour reads as a product.
- The large image renders at roughly 90 px, the small at roughly 20 px and cropped
  to a circle. Detail below ~8 px is wasted; test legibility at 64 px.
- Avoid text, letters, UI chrome, mockups, device frames, drop shadows, glow,
  gradients, photorealism or 3D. Flat vector only.
- Ask for a **solid** background, not transparency: image models rarely produce
  clean alpha, and a filled square is what Discord shows anyway.
- Exact hex and exact glyph geometry will drift between generations. Generate one
  master, then recolour it (or image-edit) for the other states so the set matches.
- Keep each image free of borders that touch the edge — Discord masks the image.
- **Static only.** The asset uploader accepts PNG/JPG/JPEG (WebP for the invite
  cover); GIF and animated WebP do not animate in a presence card. Motion, if any,
  comes from the spinner character in the state text and Discord's own elapsed timer.

### Shared prompt block (prepend to every asset prompt)

> A single flat vector app icon on a 1024×1024 square canvas, full-bleed.
> Background: deep charcoal navy `#1E1E2E`. Centered: a bold geometric terminal
> prompt mark — a thick chevron `>` followed by a short underscore `_`, drawn as
> one continuous stroke of uniform weight (about 9% of the canvas), in off-white
> `#EDEDF2`, optically centered, no serifs. A thin rounded-rectangle border inset
> 40 px from the edges, corner radius 160 px, 12 px stroke. Minimal, crisp, high
> contrast, still readable when scaled to 20 px. No text, no letters, no numbers,
> no shadows, no gradients, no glow, no 3D, no texture, no mockup.

### M0 — upload these four

| Key | Accent | Corner glyph | Hover text |
|---|---|---|---|
| `opencode` | `#3A3A4C` (border only) | none | `OpenCode` |
| `state-working` | `#34D399` emerald | filled dot, 6% of width | `OpenCode — Working` |
| `state-idle` | `#8A8A9E` slate, glyph dimmed to `#8A8A9E` | hollow circle outline | `OpenCode — Waiting for command` |
| `state-asking` | `#FBBF24` amber | exclamation mark | `OpenCode — Waiting for you` |

### M1 — upload when the states exist

| Key | Accent | Corner glyph | Hover text |
|---|---|---|---|
| `state-thinking` | `#38BDF8` sky | filled dot | `OpenCode — Thinking` |
| `state-typing` | `#A78BFA` violet | three small dots in a row | `OpenCode — Responding` |
| `state-compacting` | `#F472B6` pink | three horizontal bars, decreasing width | `OpenCode — Compacting context` |
| `state-complete` | `#34D399` emerald | checkmark | `OpenCode — Turn complete` |
| `state-error` | `#F87171` red | cross (×) | `OpenCode — Turn failed` |
| `badge-model` | `#34D399` ring | three stacked bars, white | `{model}` |
| `badge-agent` | `#34D399` ring | robot head, rounded square with two eyes | `{agent}` |

### Small badges (512×512)

Different composition from the large images: a filled circle covering the canvas,
a 12 px accent ring inset 24 px, and the glyph centered inside. Discord crops small
images to a circle, so keep the glyph within the middle 60% and leave the corners
visually empty. Same flat style, no text.

### Phase 2 — only if file spotlight is enabled

`lang-typescript`, `lang-javascript`, `lang-python`, `lang-rust`, `lang-go`,
`lang-json`, `lang-markdown`, `lang-yaml`, `lang-html`, `lang-css`, `lang-shell`,
`lang-file`: same frame, with a simple monochrome code-file glyph instead of the
terminal mark. Skip unless `privacy.fileSpotlight` is turned on.

### Assembled example (use this shape for every entry)

> *[shared prompt block]* … then: the border and a small corner dot are emerald
> green `#34D399`; everything else stays off-white on charcoal. Square 1:1 crop,
> no transparent areas, icon centered with generous padding.

---

## 16. References

---

## 16. References

- V2 plugin parts and loading: https://opencode.ai/docs/build/plugins/
- TUI plugin API: https://opencode.ai/docs/build/plugins/cli/
- CLI plugin loading (`cli.json`): https://opencode.ai/docs/cli/plugins/
- OpenCode 1 → 2 plugin migration: https://opencode.ai/docs/migrate-v1/
- Reference repositories (all MIT):
  `Puri12/opencode-discord-presence`, `Khip01/opencode-rich-presence`,
  `Jerit3787/opencode-discord-status`.
