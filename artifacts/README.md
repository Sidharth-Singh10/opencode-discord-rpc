The packed `opencode-presence-discord@0.0.1` tarball retained from a single clean-tree pack, with the bundle it contains and their checksums.
Re-verify: `cd artifacts && sha256sum -c SHA256SUMS && test "$(tar -tzf opencode-presence-discord-0.0.1.tgz | wc -l)" -eq 29 && cmp extracted/package/dist/tui.js dist/tui.js`.
