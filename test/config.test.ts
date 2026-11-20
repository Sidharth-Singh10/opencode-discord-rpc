import { describe, expect, test } from "bun:test"
import { resolvePresenceOptions } from "../src/core/config.js"
import { CLIENT_ID } from "../src/discord/presence.js"

describe("release configuration", () => {
  test("defaults to automatic presence without model disclosure", () => {
    const options = resolvePresenceOptions({}, {})
    expect(options.enabled).toBe(true)
    expect(options.automatic).toBe(true)
    expect(options.shareModel).toBe(false)
    expect(options.clientId).toBe(CLIENT_ID)
    expect(options.warnings).toEqual([])
  })

  test("bad keys do not discard valid settings or echo private values", () => {
    const options = resolvePresenceOptions({
      enabled: false, automatic: "PRIVATE", shareModel: true, runtimeDir: "../PRIVATE", clientId: "PRIVATE",
    }, {})
    expect(options.enabled).toBe(false)
    expect(options.automatic).toBe(true)
    expect(options.shareModel).toBe(true)
    expect(options.warnings).toHaveLength(3)
    expect(JSON.stringify(options)).not.toContain("PRIVATE")
  })

  test("environment overrides the configured application and can disable presence", () => {
    const options = resolvePresenceOptions({ clientId: "12345678901234567" }, {
      DISCORD_CLIENT_ID: "12345678901234568", OPENCODE_PRESENCE_DISABLED: "true", XDG_RUNTIME_DIR: "/run/user/42",
    })
    expect(options.clientId).toBe("12345678901234568")
    expect(options.enabled).toBe(false)
    expect(options.runtimeDir).toBe("/run/user/42/opencode-presence-discord")
  })

  test("invalid environment application preserves valid configuration", () => {
    expect(resolvePresenceOptions({ clientId: "12345678901234567" }, { DISCORD_CLIENT_ID: "PRIVATE" }).clientId)
      .toBe("12345678901234567")
  })
})
