# Changelog

## Unreleased

### Added
- Automatic local-Linux TUI presence with generic activity for every model and
  provider, without exporting arbitrary model metadata.
- Opt-in reviewed model labels, including GPT-6.1 Sol.
- Opt-in project name, agent, context %, cumulative tokens and reported cost in
  the card text; all off by default.
- Presence no longer fails when the local server advertises tunnel/LAN URLs.
- `/presence status`, `/presence doctor`, `publish`, `pause` and `resume`.
- Running-session selection across terminals on the local server; the foreground
  session is the fallback when nothing is running.
- State-event observation, running/idle reconciliation, deduplication, update
  throttling, connection retry, Linux socket discovery and bounded disposal.
- Per-option validation and privacy-focused fake-Discord integration tests.
- Rejection handling distinguishes a refused update from a broken socket; socket
  loss backs off and reconnects.
- Packed-tarball release acceptance test and a CI workflow.
- Verified a real Discord IPC publish and clear on the local machine.

### Compatibility
- Explicit `options.m0` retains the original strict, manual transmission spike.
- No npm publication or stable-version declaration. The README lists open gates.
