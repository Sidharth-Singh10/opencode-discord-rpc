/**
 * Minimal Discord IPC transport for M0.
 *
 * One explicit socket path, no discovery ladder. Correct 8-byte little-endian
 * framing, READY handshake, nonce-correlated RPC, bounded timeouts, PING/PONG,
 * CLOSE/error handling and deterministic cleanup.
 */
import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"

export const OPCODE = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
} as const

export interface DiscordIpcOptions {
  path: string
  clientId: string
  connectTimeoutMs?: number
  responseTimeoutMs?: number
  onClose?: (reason: string) => void
  onError?: (error: Error) => void
}

export interface RpcReply {
  cmd?: string
  evt?: string | null
  nonce?: string | null
  data?: unknown
}

export interface RpcRequest {
  nonce: string
  reply: Promise<RpcReply>
}

interface Pending {
  resolve: (reply: RpcReply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cmd: string
}

export class DiscordIpcError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = "DiscordIpcError"
    this.code = code
  }
}

export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  const frame = Buffer.allocUnsafe(8 + body.length)
  frame.writeUInt32LE(opcode, 0)
  frame.writeUInt32LE(body.length, 4)
  body.copy(frame, 8)
  return frame
}

export interface DecodedFrame {
  opcode: number
  payload: unknown
}

/**
 * Incremental decoder. A stream chunk may contain a partial frame, several
 * frames, or a frame boundary in the middle of a JSON body.
 */
export class FrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: DecodedFrame[] = []
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0)
      const length = this.buffer.readUInt32LE(4)
      if (length > 4 * 1024 * 1024) throw new DiscordIpcError(`frame length ${length} exceeds the M0 bound`)
      if (this.buffer.length < 8 + length) break
      const body = this.buffer.subarray(8, 8 + length)
      this.buffer = this.buffer.subarray(8 + length)
      let payload: unknown
      try {
        payload = JSON.parse(body.toString("utf8")) as unknown
      } catch {
        throw new DiscordIpcError("frame body is not valid JSON")
      }
      frames.push({ opcode, payload })
    }
    return frames
  }

  get pendingBytes(): number {
    return this.buffer.length
  }
}

export class DiscordIpc {
  readonly path: string
  private readonly options: Required<Pick<DiscordIpcOptions, "clientId" | "connectTimeoutMs" | "responseTimeoutMs">> &
    Pick<DiscordIpcOptions, "onClose" | "onError">
  private socket: Socket | null = null
  private decoder = new FrameDecoder()
  private pending = new Map<string, Pending>()
  private ready = false
  private closed = false
  private closeReason: string | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private closeNotified = false

  constructor(options: DiscordIpcOptions) {
    this.path = options.path
    this.options = {
      clientId: options.clientId,
      connectTimeoutMs: options.connectTimeoutMs ?? 5000,
      responseTimeoutMs: options.responseTimeoutMs ?? 5000,
      onClose: options.onClose,
      onError: options.onError,
    }
  }

  get isReady(): boolean {
    return this.ready && !this.closed
  }

  get isClosed(): boolean {
    return this.closed
  }

  get pendingRpcCount(): number {
    return this.pending.size
  }

  async connect(): Promise<void> {
    if (this.socket) throw new DiscordIpcError("connection already started")
    this.closed = false
    this.closeReason = null
    this.ready = false
    this.decoder = new FrameDecoder()

    const socket = createConnection(this.path)
    this.socket = socket
    socket.setNoDelay(true)

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    const timer = setTimeout(() => {
      this.fail(new DiscordIpcError(`Discord IPC did not become READY within ${this.options.connectTimeoutMs}ms`, "ETIMEDOUT"))
      socket.destroy()
    }, this.options.connectTimeoutMs)
    if (typeof timer === "object" && timer && "unref" in timer) {
      ;(timer as { unref?: () => void }).unref?.()
    }

    socket.on("connect", () => {
      this.writeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: this.options.clientId })
    })
    socket.on("data", (chunk: Buffer) => {
      this.handleData(chunk)
    })
    socket.on("error", (error: Error) => {
      this.fail(error)
    })
    socket.on("close", () => {
      this.fail(new DiscordIpcError(this.closeReason ?? "Discord IPC socket closed", "ECLOSED"))
    })

    try {
      await readyPromise
    } catch (error) {
      socket.destroy()
      throw error
    } finally {
      clearTimeout(timer)
      this.readyResolve = null
      this.readyReject = null
    }
    if (!this.ready) throw new DiscordIpcError(this.closeReason ?? "Discord IPC closed before READY", "ECLOSED")
  }

  /**
   * Synchronous enqueue. Registers the nonce before writing, so a response
   * that arrives immediately is still correlated. Callers that need the
   * response await `settle(nonce)`.
   */
  enqueueSetActivity(pid: number, activity: Record<string, unknown>): RpcRequest {
    return this.enqueue("SET_ACTIVITY", { pid, activity })
  }

  enqueueClearActivity(pid: number): RpcRequest {
    return this.enqueue("SET_ACTIVITY", { pid })
  }

  enqueue(cmd: string, args: Record<string, unknown>): RpcRequest {
    if (!this.ready || !this.socket || this.closed) throw new DiscordIpcError("Discord IPC is not ready", "ENOTREADY")
    const nonce = randomUUID()
    const payload = { cmd, args, nonce }
    const reply = new Promise<RpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce)
        reject(new DiscordIpcError(`no RPC response for ${cmd} within ${this.options.responseTimeoutMs}ms`, "ETIMEDOUT"))
      }, this.options.responseTimeoutMs)
      if (typeof timer === "object" && timer && "unref" in timer) {
        ;(timer as { unref?: () => void }).unref?.()
      }
      this.pending.set(nonce, { resolve, reject, timer, cmd })
    })
    // Keep the rejection observable without requiring every caller to settle.
    reply.catch(() => {})
    this.writeFrame(OPCODE.FRAME, payload)
    return { nonce, reply }
  }

  /** Rejects every in-flight RPC and destroys the socket. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    const error = new DiscordIpcError("Discord IPC closed locally", "ECLOSED")
    this.settleReady(error)
    this.failPending(error)
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners("close")
      socket.destroy()
    }
    this.onClosed("closed locally")
  }

  destroy(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    const error = new DiscordIpcError(reason, "ECLOSED")
    this.settleReady(error)
    this.failPending(error)
    const socket = this.socket
    this.socket = null
    socket?.destroy()
    this.onClosed(reason)
  }

  private writeFrame(opcode: number, payload: unknown): void {
    if (!this.socket || this.socket.destroyed) throw new DiscordIpcError("Discord IPC socket is gone", "ECLOSED")
    this.socket.write(encodeFrame(opcode, payload))
  }

  private handleData(chunk: Buffer): void {
    let frames: DecodedFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      this.socket?.destroy()
      return
    }
    for (const frame of frames) {
      if (frame.opcode === OPCODE.PING) {
        try {
          this.writeFrame(OPCODE.PONG, frame.payload)
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
        }
        continue
      }
      if (frame.opcode === OPCODE.PONG) continue
      if (frame.opcode === OPCODE.CLOSE) {
        const reason = describePayload(frame.payload) ?? "Discord sent CLOSE"
        this.closeReason = reason
        this.ready = false
        this.failPending(new DiscordIpcError(reason, "ECLOSED"))
        this.socket?.destroy()
        continue
      }
      if (frame.opcode !== OPCODE.FRAME) continue
      this.handleFrame(frame.payload)
    }
  }

  private handleFrame(payload: unknown): void {
    if (!payload || typeof payload !== "object") return
    const message = payload as RpcReply
    if (message.evt === "READY") {
      this.ready = true
      this.readyResolve?.()
      return
    }
    if (message.evt === "ERROR") {
      const error = new DiscordIpcError(`Discord RPC error: ${describeError(message.data)}`, "ERPC")
      if (message.nonce) {
        this.rejectNonce(message.nonce, error)
      } else {
        this.options.onError?.(error)
      }
      return
    }
    if (message.nonce) {
      const pending = this.pending.get(message.nonce)
      if (pending) {
        this.pending.delete(message.nonce)
        clearTimeout(pending.timer)
        pending.resolve(message)
      }
    }
  }

  private rejectNonce(nonce: string, error: Error): void {
    const pending = this.pending.get(nonce)
    if (!pending) {
      this.options.onError?.(error)
      return
    }
    this.pending.delete(nonce)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private failPending(error: Error): void {
    for (const [nonce, pending] of this.pending) {
      this.pending.delete(nonce)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private settleReady(error: Error): void {
    const reject = this.readyReject
    this.readyReject = null
    this.readyResolve = null
    reject?.(error)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.ready = false
    this.settleReady(error)
    this.options.onError?.(error)
    this.failPending(error)
    this.closeReason = this.closeReason ?? error.message
    this.onClosed(this.closeReason)
  }

  private onClosed(reason: string): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.options.onClose?.(reason)
  }
}

function describePayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const record = payload as { message?: unknown; data?: { message?: unknown } }
  if (typeof record.message === "string") return record.message
  if (record.data && typeof record.data.message === "string") return record.data.message
  return null
}

function describeError(data: unknown): string {
  if (!data || typeof data !== "object") return "unknown error"
  const record = data as { code?: unknown; message?: unknown }
  if (typeof record.code === "number" && typeof record.message === "string") return `${record.code}: ${record.message}`
  if (typeof record.message === "string") return record.message
  return "unknown error"
}
