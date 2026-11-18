import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { join } from "node:path"
import { DiscordIpc, encodeFrame, FrameDecoder, OPCODE } from "../src/discord/ipc.js"

test("only the matching command, nonce and ACK event settle a request", async () => {
  const dir = mkdtempSync("/tmp/opencode/ipc-correlation-")
  const path = join(dir, "socket")
  let peer: Socket | undefined
  let nonce = ""
  const server = createServer((socket) => {
    peer = socket
    const decoder = new FrameDecoder()
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === OPCODE.HANDSHAKE) socket.write(encodeFrame(OPCODE.FRAME, { cmd: "DISPATCH", evt: "READY" }))
        else nonce = (frame.payload as any).nonce
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const ipc = new DiscordIpc({ path, clientId: "0" })
  try {
    await ipc.connect()
    const request = ipc.enqueueClearActivity(process.pid)
    while (!nonce) await Bun.sleep(5)
    let settled = false
    request.reply.then(() => { settled = true }, () => { settled = true })
    peer!.write(encodeFrame(OPCODE.FRAME, { cmd: "OTHER", evt: null, nonce }))
    peer!.write(encodeFrame(OPCODE.FRAME, { cmd: "SET_ACTIVITY", evt: "EVENT", nonce }))
    await Bun.sleep(30)
    expect(settled).toBe(false)
    peer!.write(encodeFrame(OPCODE.FRAME, { cmd: "SET_ACTIVITY", evt: null, nonce: request.nonce }))
    expect((await request.reply).nonce).toBe(request.nonce)
  } finally {
    ipc.close()
    peer?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
