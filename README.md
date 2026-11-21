# opencode-presence-discord

Discord Rich Presence for OpenCode V2 (TUI only). Status: `0.0.1`
pre-release — usable, but not a stable release.

## Use the local release-development build

Run `bun run build`, then add the local package directory to the `plugins` array
in `~/.config/opencode/cli.json`, preserving any existing plugins:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-discord-rpc",
      "options": {
        "enabled": true,
        "automatic": true,
        "shareModel": false
      }
    }
  ]
}
```

Config reloads automatically; use `/reload` if commands do not appear.

With Discord Desktop running, the plugin automatically publishes activity for
the session displayed in the TUI. Any model/provider can produce a generic card;
unknown model metadata never blocks publication. The timer uses an observed
user-message timestamp and keeps its acknowledged anchor for that session.
No timestamp is invented when the session has no usable user-message timestamp.

Commands:

- `/presence status` — connection/coordination status.
- `/presence doctor` — a private, multi-line diagnostic summary: mode, socket
  count, publisher ownership, session presence, model-sharing policy, the last
  published card text and config warning count. It never prints paths or IDs.
- `/presence publish` — request an update (still respects throttling).
- `/presence pause` — clear this publisher's activity and stop updates.
- `/presence resume` — resume unless disabled in configuration/environment.

### Privacy

The default payload contains only “Using OpenCode,” a fixed activity-state label,
the session timer and fixed artwork keys. It never includes prompts, answers,
project names, paths, titles, agent names, tool arguments, costs or raw errors.
Release mode writes no evidence logs. Its private coordination store retains
hashed session anchors; automatic anchor pruning is not implemented yet.

Opt-in fields:

- `shareProject: true` — details become `Working on <project-directory-basename>`.
  The absolute path is never sent.
- `shareModel: true` — the state line starts with a reviewed model label, e.g.
  `GPT-6.1 Sol`. Currently includes `openai/gpt-6.1-sol` and the M0 DeepSeek
  identities. Unknown/custom identities are omitted, never copied verbatim.
- `shareAgent: true` — adds the executing agent, e.g. `build`.
- `shareMetrics: true` — adds reported cost, context usage and cumulative
  input+output tokens when known: `42% ctx · 1.2M tok · $0.42`. Cache tokens are
  not blended into the token figure; unknown values are omitted.

With all four enabled the card reads, for example:

```
details: Working on opencode-discord-rpc
state:   GPT-6.1 Sol · build · Working · 42% ctx · 1.2M tok · $0.42
```

### Options

| Option | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable presence; `false` creates no publisher or socket. |
| `automatic` | `true` | Poll the current session and observe state events. |
| `shareModel` | `false` | Reviewed model label in the state line and tooltip. |
| `shareProject` | `false` | Project directory basename in the details line. |
| `shareAgent` | `false` | Executing agent name in the state line. |
| `shareMetrics` | `false` | Context %, cumulative tokens and reported cost when known. |
| `clientId` | Built-in public application ID | Use another Discord application. |
| `runtimeDir` | User runtime directory | Absolute coordination-directory override. |

Environment overrides: `DISCORD_CLIENT_ID`, `DISCORD_IPC_PATH` (exclusive socket
override), `OPENCODE_PRESENCE_DISABLED=1` or `true`, and
`OPENCODE_PRESENCE_DEBUG=1` for opt-in error logging.
Invalid option values warn without echoing the value and leave other valid
settings intact.

### Current boundaries / remaining release gates

- Local Linux desktop TUI only. A local TUI publishes even when the server
  advertises tunnel or LAN URLs; the anchor namespace is derived from the local
  server identity, not from URL reachability.
- Automatic mode publishes the best fresh card across all TUIs on this machine.
  Every TUI advertises its current card in the private coordination store; the
  fence owner publishes the best running session (recent local activity, then
  session update time), then the newest idle one. This works across workspaces
  without a second Discord socket.
- If a TUI loses publisher ownership it discards that publisher and recreates it,
  so it can take over again after the current owner exits or its lease goes stale.
- Publisher fencing is reused from M0; a full multi-process suspend/resume
  acceptance run remains open.
- Linux socket discovery includes slots 0–9, Snap, Flatpak and Vesktop layouts;
  discovery tests are not certification of every desktop packaging variant.
- `/presence doctor` reports counts and states, not socket paths or session IDs.
- A packed-artifact test extracts the npm tarball, loads the published `./tui`
  export through an isolated `node_modules`, and verifies publication, privacy
  and clear-on-dispose against fake Discord IPC. It is not a live acceptance run.
- CI runs typecheck, the full test suite, the build and the package guard.
- Dependency audit: `bun audit` reports two moderate advisories (`glob`,
  `minimatch`) in the host/tooling graph via `@opencode/plugin` and
  `@opentui/solid`. Those packages are external to the shipped bundle and are
  not imported by plugin runtime code; no forced fix was applied. Re-check when
  the host packages update.
- State events drive thinking, typing, waiting, compaction, retry and terminal
  labels. Polling reconciles against host running/idle state. A missed reply/end
  can lose detailed status; full pending-form/permission reconciliation is open.
- Updates are coalesced by polling, deduplicated and limited to one publication
  attempt per four seconds. Connection failures back off up to 30 seconds.
- Metrics/enrichment, configurable templates, comprehensive diagnostics, CI and
  clean packed-artifact release-mode acceptance are still pending.
- Live OpenCode/Discord visual acceptance is required before a stable release.
  macOS, Windows and OpenCode GUI are not supported release targets yet.

The private coordination store also holds each running TUI's current card
payload so the owner can publish it. It contains only what would be sent to
Discord, is created `0600` inside a `0700` runtime directory, is removed when the
TUI pauses or exits, and stale rows are pruned after ten seconds.

## Legacy M0 transmission spike

An explicit `options.m0` object selects the unchanged strict M0 path instead of
release mode:

```json
{
  "m0": {
    "capture": false,
    "live": false
  }
}
```

M0 remains manual (`/presence-m0 publish`) and DeepSeek-allowlisted. `live` is off
by default for M0. Remove `m0` from plugin options to use release mode.

Status: `0.0.1` pre-release. M0 remains a pre-alpha transmission spike documented
in [docs/M0.md](./docs/M0.md); remote integration is descoped and unverified.
Nothing is published to npm.

The packed M0 artifact is retained in the repository at
[`artifacts/`](./artifacts/README.md): the tarball, the bundle it contains, the
checksums and the `npm pack --json` manifest. Re-verification needs no `/tmp`
directory.

Model identity and evidence: `opencode/deepseek-v4.1-flash-free` is a **harness
test identity, not an executed model**. No such model was run for any figure in
this repository. Live evidence is **real host, scripted inference**: a real
OpenCode 2.3.0 TUI/server and real Discord IPC driven by a local deterministic
inference fixture. The live labs have been deleted and are not cited; the
retained material is the synthetic packed suite and the validator evidence under
`docs/evidence/`.

## Discord assets

Discord images require the asset keys listed in [PLAN.md](./PLAN.md).

## Development checks

```sh
bun test
bun run typecheck
bun run build
```

Existing M0 tests remain intact. New release-mode tests use a synthetic host and
fake Discord IPC, not a live Discord account. Historical evidence and packed
artifacts describe their original builds, not the current development bundle.
