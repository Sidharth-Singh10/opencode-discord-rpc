/**
 * Local fake Discord IPC endpoint for transport tests. It records decoded
 * frames and can fragment, coalesce, reject and disconnect.
 */
import { unlinkSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"

import { FrameDecoder, OPCODE, encodeFrame } from "../src/discord/ipc.js"

export interface FakeDiscordOptions {
  path: string
  fragment?: boolean
  coalesce?: boolean
  reject?: boolean
  rejectOnce?: boolean
  closeOnActivity?: boolean
  noReady?: boolean
  handshakeDelayMs?: number
  responseDelayMs?: number
}

export interface RecordedFrame {
  atMs: number
  connection: number
  opcode: number
  payload: unknown
}

export class FakeDiscord {
  readonly path: string
  readonly frames: RecordedFrame[] = []
  readonly options: FakeDiscordOptions
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private queues = new Map<Socket, Buffer[]>()
  private draining = new Set<Socket>()
  private connectionSeq = 0
  private closedCount = 0
  private rejectedOnce = false

  constructor(options: FakeDiscordOptions) {
    this.options = options
    this.path = options.path
  }

  get connections(): number {
    return this.connectionSeq
  }

  get closedConnections(): number {
    return this.closedCount
  }

  activityFrames(): RecordedFrame[] {
    return this.frames.filter((frame) => {
      const payload = frame.payload as { cmd?: string } | null
      return frame.opcode === OPCODE.FRAME && payload?.cmd === "SET_ACTIVITY"
    })
  }

  async start(): Promise<void> {
    try {
      unlinkSync(this.path)
    } catch {
      // No stale socket.
    }
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.path, () => resolve())
    })
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    try {
      unlinkSync(this.path)
    } catch {
      // Already gone.
    }
  }

  async waitFor(predicate: (frame: RecordedFrame) => boolean, timeoutMs = 3000): Promise<RecordedFrame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error("fake Discord: timed out waiting for a frame")
  }

  private accept(socket: Socket): void {
    this.connectionSeq += 1
    const connection = this.connectionSeq
    this.sockets.add(socket)
    const decoder = new FrameDecoder()
    socket.on("close", () => {
      this.closedCount += 1
      this.sockets.delete(socket)
    })
    socket.on("error", () => {
      // Client-side teardown is normal in these tests.
    })
    socket.on("data", (chunk: Buffer) => {
      let frames
      try {
        frames = decoder.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) {
        this.frames.push({ atMs: Date.now(), connection, opcode: frame.opcode, payload: frame.payload })
        this.respond(socket, frame.opcode, frame.payload)
      }
    })
  }

  private respond(socket: Socket, opcode: number, payload: unknown): void {
    if (opcode === OPCODE.HANDSHAKE) {
      if (this.options.noReady) return
      const ready = encodeFrame(OPCODE.FRAME, {
        cmd: "DISPATCH",
        evt: "READY",
        data: { v: 1, config: { cdn_host: "cdn.discordapp.com", api_endpoint: "//discord.com/api" }, user: { id: "0", username: "fake" } },
      })
      const send = (): void => {
        this.write(socket, ready)
        if (this.options.coalesce) {
          this.write(socket, encodeFrame(OPCODE.PING, { coalesced: true }))
        }
      }
      if (this.options.handshakeDelayMs) setTimeout(send, this.options.handshakeDelayMs)
      else send()
      return
    }
    if (opcode !== OPCODE.FRAME) return
    const message = payload as { cmd?: string; nonce?: string; evt?: string } | null
    if (!message || message.cmd !== "SET_ACTIVITY") return

    if (this.options.closeOnActivity) {
      socket.destroy()
      return
    }

    const shouldReject = this.options.reject || (this.options.rejectOnce && !this.rejectedOnce)
    if (shouldReject) {
      if (this.options.rejectOnce) this.rejectedOnce = true
      const error = encodeFrame(OPCODE.FRAME, {
        cmd: "SET_ACTIVITY",
        evt: "ERROR",
        nonce: message.nonce,
        data: { code: 4000, message: "fake RPC rejection" },
      })
      this.deliver(socket, error)
      return
    }

    const reply = encodeFrame(OPCODE.FRAME, {
      cmd: "SET_ACTIVITY",
      evt: null,
      nonce: message.nonce,
      data: { activity: null },
    })
    this.deliver(socket, reply)
  }

  private deliver(socket: Socket, frame: Buffer): void {
    if (this.options.responseDelayMs) setTimeout(() => this.write(socket, frame), this.options.responseDelayMs)
    else this.write(socket, frame)
  }

  private write(socket: Socket, frame: Buffer): void {
    if (socket.destroyed) return
    let queue = this.queues.get(socket)
    if (!queue) {
      queue = []
      this.queues.set(socket, queue)
    }
    queue.push(frame)
    if (!this.draining.has(socket)) {
      this.draining.add(socket)
      this.drain(socket)
    }
  }

  private drain(socket: Socket): void {
    if (socket.destroyed) {
      this.draining.delete(socket)
      this.queues.delete(socket)
      return
    }
    const queue = this.queues.get(socket)
    const frame = queue?.shift()
    if (!frame) {
      this.draining.delete(socket)
      this.queues.delete(socket)
      return
    }
    if (!this.options.fragment) {
      socket.write(frame)
      this.drain(socket)
      return
    }
    let offset = 0
    const step = (): void => {
      if (socket.destroyed) {
        this.draining.delete(socket)
        return
      }
      if (offset >= frame.length) {
        this.drain(socket)
        return
      }
      socket.write(frame.subarray(offset, Math.min(offset + 3, frame.length)))
      offset += 3
      setTimeout(step, 2)
    }
    step()
  }
}
