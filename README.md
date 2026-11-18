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

## Discord assets

Discord images require the asset keys listed in [PLAN.md](./PLAN.md).
