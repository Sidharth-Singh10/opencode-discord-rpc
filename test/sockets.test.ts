import { describe, expect, test } from "bun:test"
import { socketCandidates } from "../src/discord/sockets.js"

describe("Discord socket discovery", () => {
  test("explicit socket short-circuits discovery", () => {
    expect(socketCandidates({ DISCORD_IPC_PATH: "/custom/socket" }, 42)).toEqual(["/custom/socket"])
  })

  test("discovers slots 0–9 and supported Linux packaging layouts", () => {
    const paths = socketCandidates({ XDG_RUNTIME_DIR: "/runtime" }, 42)
    expect(paths).toContain("/runtime/discord-ipc-9")
    expect(paths).toContain("/run/user/42/snap.discord/discord-ipc-0")
    expect(paths).toContain("/runtime/app/com.discordapp.Discord/discord-ipc-0")
    expect(paths).toContain("/runtime/app/dev.vencord.Vesktop/discord-ipc-0")
    expect(paths).not.toContain("/run/user/43/discord-ipc-0")
    expect(new Set(paths).size).toBe(paths.length)
  })
})
