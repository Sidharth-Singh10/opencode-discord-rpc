# opencode-presence-discord

Discord Rich Presence for OpenCode V2 (TUI only).

## Install

Add `"opencode-presence-discord"` to the `plugins` array in `cli.json`:

```json
{
  "plugins": [
    {
      "package": "opencode-presence-discord",
      "options": {
        "m0": {
          "capture": false,
          "live": false
        }
      }
    }
  ]
}
```

`live` is off by default; M0 publishes only through the explicit
`/presence-m0 publish` command.

## Status

Status: pre-alpha. M0 (packaged-host and transmission spike) is documented in
[docs/M0.md](./docs/M0.md). Remote integration is descoped from M0 and
unverified; the human visual Discord check is still open. Nothing is published
to npm.

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
