import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function socketCandidates(
  env: Record<string, string | undefined> = process.env,
  uid = process.getuid?.(),
): string[] {
  if (env.DISCORD_IPC_PATH) return [env.DISCORD_IPC_PATH]
  const roots = [...new Set([
    env.XDG_RUNTIME_DIR, uid === undefined ? undefined : `/run/user/${uid}`, env.TMPDIR, tmpdir(),
  ].filter((path): path is string => Boolean(path)))]
  const directories = ["", "snap.discord", "snap.discord-canary", "app/com.discordapp.Discord",
    "app/com.discordapp.DiscordCanary", "app/dev.vencord.Vesktop"]
  return roots.flatMap((root) => directories.flatMap((directory) =>
    Array.from({ length: 10 }, (_, index) => join(root, directory, `discord-ipc-${index}`))))
}

/** Do not scan other users' runtimes or connect to regular files. */
export function availableSockets(): string[] {
  const uid = process.getuid?.()
  return socketCandidates().filter((path) => {
    try {
      const stat = statSync(path)
      return stat.isSocket() && (uid === undefined || stat.uid === uid)
    } catch {
      return false
    }
  })
}
