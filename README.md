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
[docs/M0.md](./docs/M0.md). Publishing to npm is still gated on the blocked
remote-endpoint test and the user's visual Discord check.

## Discord assets

Discord images require the asset keys listed in [PLAN.md](./PLAN.md).
