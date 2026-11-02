// Agent bridge: NDJSON request/response server on a Unix socket.
//
// Pure node (no 'electron' import) so it can be unit tested. The electron glue
// (settings, menu state, the documents facade) lives in agent.ts.
//
// Protocol (see src/shared/agent.ts): one JSON object per line.
//   client → { id, method, params }      server → { id, result } | { id, error }
// Requests on one connection may overlap; responses carry the request's id.
// Lines that cannot be parsed are answered with id null. A line over
// MAX_FRAME_BYTES gets a TOO_LARGE error and the connection is closed.
//
// Layout: <dir>/agent.sock (0600, dir 0700) and <dir>/agent.json, the pointer
// the MCP client reads to find the socket. The socket moves to <tmpdir> when
// the userData path is too long for sun_path (104 bytes on macOS).
import { connect, createServer, type Server, type Socket } from 'net'
import { promises as fs, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { atomicWrite } from './fileio'
import type {
  AgentDocOp,
  AgentError,
  AgentErrorCode,
  AgentMethod,
  AgentParams,
  AgentPointer,
  AgentRequestFrame,
  AgentResponseFrame,
  AgentResult
} from '../shared/agent'

// Limits: literals here must match src/shared/agent.ts and the MCP server.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_ELEMENTS = 2000
export const MAX_IDS = 5000
export const MIN_EXPORT_SIZE = 256
export const MAX_EXPORT_SIZE = 4096
export const MAX_TITLE_LENGTH = 200
export const MAX_PADDING = 1000
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/
const ADD_TYPES = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'frame',
  'image'
])
/** Longest socket path we hand to bind(2); sun_path is 104 bytes on macOS. */
const MAX_SOCKET_PATH_BYTES = 100

export const SOCKET_NAME = 'agent.sock'
export const POINTER_NAME = 'agent.json'

const ERROR_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  'NOT_RUNNING',
  'DISABLED',
  'NO_SUCH_DOC',
  'NOT_READY',
  'BAD_PARAMS',
  'UNKNOWN_METHOD',
  'TIMEOUT',
  'TOO_LARGE',
  'INTERNAL'
])

const METHODS: ReadonlySet<string> = new Set<AgentMethod>([
  'listTabs',
  'newDrawing',
  'getScene',
  'addElements',
  'updateElements',
  'deleteElements',
  'exportImage',
  'scrollTo'
])

/** What the server needs from the app. Errors thrown as `AgentError` pass through to the client. */
export interface AgentHost {
  listTabs(): Promise<AgentResult<'listTabs'>> | AgentResult<'listTabs'>
  newDrawing(params: AgentParams<'newDrawing'>): Promise<AgentResult<'newDrawing'>>
  docOp(op: AgentDocOp, params: AgentParams<AgentDocOp>): Promise<unknown>
}

export function agentError(code: AgentErrorCode, message: string): AgentError {
  return { code, message }
}

export function isAgentError(v: unknown): v is AgentError {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.code === 'string' && ERROR_CODES.has(e.code) && typeof e.message === 'string'
}

/** Shape anything thrown by the host as an `AgentError`; unknown throws become INTERNAL. */
export function toAgentError(err: unknown): AgentError {
  if (isAgentError(err)) return { code: err.code, message: err.message }
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'unexpected error'
  return agentError('INTERNAL', message)
}

// ---------------------------------------------------------------------------
// Framing

export class FrameTooLargeError extends Error {
  constructor(max: number) {
    super(`frame exceeds ${max} bytes`)
    this.name = 'FrameTooLargeError'
  }
}

/** Splits a byte stream into lines, refusing any line (complete or partial) over `maxBytes`. */
export class AgentLineSplitter {
  private chunks: Buffer[] = []
  private size = 0

  constructor(private readonly maxBytes: number = MAX_FRAME_BYTES) {}

  /** Feed bytes; returns the complete lines they finished (without the newline). */
  push(chunk: Buffer): string[] {
    const out: string[] = []
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(10, start)
      if (nl === -1) break
      const piece = chunk.subarray(start, nl)
      if (this.size + piece.length > this.maxBytes) throw new FrameTooLargeError(this.maxBytes)
      const line = this.size ? Buffer.concat([...this.chunks, piece]) : piece
      this.chunks = []
      this.size = 0
      out.push(line.toString('utf8'))
      start = nl + 1
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      if (this.size + rest.length > this.maxBytes) throw new FrameTooLargeError(this.maxBytes)
      this.chunks.push(Buffer.from(rest))
      this.size += rest.length
    }
    return out
  }
}

export type ParsedFrame =
  | { ok: true; frame: AgentRequestFrame & { params: Record<string, unknown> } }
  | { ok: false; id: number | string | null; error: AgentError }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRequestId(v: unknown): v is number | string {
  return (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string'
}

/** Parse one line into a request frame. `params` defaults to `{}`. */
export function parseFrame(line: string): ParsedFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, id: null, error: agentError('BAD_PARAMS', 'request is not valid JSON') }
  }
  if (!isPlainObject(parsed))
    return { ok: false, id: null, error: agentError('BAD_PARAMS', 'request must be an object') }
  if (!isRequestId(parsed.id))
    return {
      ok: false,
      id: null,
      error: agentError('BAD_PARAMS', 'request id must be a number or string')
    }
  const id = parsed.id
  if (typeof parsed.method !== 'string')
    return { ok: false, id, error: agentError('BAD_PARAMS', 'method must be a string') }
  const params = parsed.params === undefined ? {} : parsed.params
  if (!isPlainObject(params))
    return { ok: false, id, error: agentError('BAD_PARAMS', 'params must be an object') }
  return { ok: true, frame: { id, method: parsed.method, params } }
}

// ---------------------------------------------------------------------------
// Validation (hand-written guards; the MCP side uses zod with the same limits)

function bad(message: string): AgentError {
  return agentError('BAD_PARAMS', message)
}

function checkDocId(p: Record<string, unknown>): AgentError | null {
  if (p.docId === undefined) return null
  if (typeof p.docId !== 'string' || !DOC_ID.test(p.docId))
    return bad('docId must match /^[A-Za-z0-9_-]{1,128}$/')
  return null
}

function checkBoolean(p: Record<string, unknown>, key: string): AgentError | null {
  if (p[key] !== undefined && typeof p[key] !== 'boolean') return bad(`${key} must be a boolean`)
  return null
}

function checkIds(p: Record<string, unknown>, key: string, required: boolean): AgentError | null {
  const v = p[key]
  if (v === undefined) return required ? bad(`${key} is required`) : null
  if (!Array.isArray(v)) return bad(`${key} must be an array of strings`)
  if (required && v.length === 0) return bad(`${key} must not be empty`)
  if (v.length > MAX_IDS) return bad(`${key} must have at most ${MAX_IDS} entries`)
  for (const id of v)
    if (typeof id !== 'string' || !id) return bad(`${key} must contain non-empty strings`)
  return null
}

function checkElements(
  p: Record<string, unknown>,
  each: (el: Record<string, unknown>, i: number) => AgentError | null
): AgentError | null {
  const v = p.elements
  if (!Array.isArray(v)) return bad('elements must be an array')
  if (v.length === 0) return bad('elements must not be empty')
  if (v.length > MAX_ELEMENTS) return bad(`elements must have at most ${MAX_ELEMENTS} entries`)
  for (let i = 0; i < v.length; i++) {
    if (!isPlainObject(v[i])) return bad(`elements[${i}] must be an object`)
    const err = each(v[i], i)
    if (err) return err
  }
  return null
}

/**
 * Check `params` for `method`. Returns null when valid, an UNKNOWN_METHOD or
 * BAD_PARAMS error otherwise. Unknown keys are ignored.
 */
export function validateParams(method: string, params: unknown): AgentError | null {
  if (!METHODS.has(method)) return agentError('UNKNOWN_METHOD', `unknown method "${method}"`)
  if (!isPlainObject(params)) return bad('params must be an object')
  const p = params
  switch (method as AgentMethod) {
    case 'listTabs':
      return null
    case 'newDrawing':
      if (p.title !== undefined) {
        if (typeof p.title !== 'string') return bad('title must be a string')
        if (p.title.length > MAX_TITLE_LENGTH)
          return bad(`title must be at most ${MAX_TITLE_LENGTH} characters`)
      }
      return null
    case 'getScene':
      return checkDocId(p) ?? checkBoolean(p, 'full')
    case 'addElements':
      return (
        checkDocId(p) ??
        checkBoolean(p, 'scrollTo') ??
        checkElements(p, (el, i) => {
          if (typeof el.type !== 'string' || !ADD_TYPES.has(el.type))
            return bad(`elements[${i}].type must be one of ${[...ADD_TYPES].join(', ')}`)
          if (el.id !== undefined && (typeof el.id !== 'string' || !el.id))
            return bad(`elements[${i}].id must be a non-empty string`)
          return null
        })
      )
    case 'updateElements':
      return (
        checkDocId(p) ??
        checkElements(p, (el, i) =>
          typeof el.id === 'string' && el.id
            ? null
            : bad(`elements[${i}].id must be a non-empty string`)
        )
      )
    case 'deleteElements':
      return checkDocId(p) ?? checkIds(p, 'ids', true)
    case 'exportImage': {
      const err =
        checkDocId(p) ??
        checkIds(p, 'ids', false) ??
        checkBoolean(p, 'background') ??
        checkBoolean(p, 'dark')
      if (err) return err
      if (p.maxSize !== undefined) {
        if (
          typeof p.maxSize !== 'number' ||
          !Number.isInteger(p.maxSize) ||
          p.maxSize < MIN_EXPORT_SIZE ||
          p.maxSize > MAX_EXPORT_SIZE
        )
          return bad(`maxSize must be an integer between ${MIN_EXPORT_SIZE} and ${MAX_EXPORT_SIZE}`)
      }
      if (p.padding !== undefined) {
        if (
          typeof p.padding !== 'number' ||
          !Number.isFinite(p.padding) ||
          p.padding < 0 ||
          p.padding > MAX_PADDING
        )
          return bad(`padding must be a number between 0 and ${MAX_PADDING}`)
      }
      return null
    }
    case 'scrollTo':
      return checkDocId(p) ?? checkIds(p, 'ids', false)
  }
}

// ---------------------------------------------------------------------------
// Socket path

/**
 * `<dir>/agent.sock`, or a short per-profile name under `tmpdir` when that
 * would not fit in sun_path.
 */
export function chooseSocketPath(dir: string, tmpdir: string): string {
  const preferred = join(dir, SOCKET_NAME)
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred
  const tag = createHash('sha256').update(dir).digest('hex').slice(0, 12)
  return join(tmpdir, `sketchbook-${tag}.sock`)
}

/**
 * Remove a socket file left behind by a crashed instance. Throws if something
 * is still listening on it (another running instance) or if the path is not a socket.
 */
export async function removeStaleSocket(path: string): Promise<void> {
  let st: Awaited<ReturnType<typeof fs.lstat>>
  try {
    st = await fs.lstat(path)
  } catch {
    return
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`)
  const alive = await new Promise<boolean>((res) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      res(true)
    })
    probe.once('error', () => res(false))
  })
  if (alive) throw new Error(`another instance is already listening on ${path}`)
  await fs.rm(path, { force: true })
}

// ---------------------------------------------------------------------------
// Server

export type AgentServerOptions = {
  /** Directory for the socket and pointer file (created with mode 0700). */
  dir: string
  /** Fallback location for the socket when `dir` is too long. */
  tmpdir: string
  /** App version written to the pointer file. */
  version: string
  pid: number
  host: AgentHost
  log?: (message: string, err?: unknown) => void
}

export class AgentServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private socketPath: string | null = null
  private readonly log: (message: string, err?: unknown) => void

  constructor(private readonly opts: AgentServerOptions) {
    this.log = opts.log ?? ((m, e) => console.error(`[agent] ${m}`, e ?? ''))
  }

  get running(): boolean {
    return this.server !== null
  }

  get pointerPath(): string {
    return join(this.opts.dir, POINTER_NAME)
  }

  async start(): Promise<{ socketPath: string }> {
    if (this.server && this.socketPath) return { socketPath: this.socketPath }
    const { dir, tmpdir } = this.opts
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700)
    const socketPath = chooseSocketPath(dir, tmpdir)
    await removeStaleSocket(socketPath)

    const server = createServer({ allowHalfOpen: false }, (s) => this.onConnection(s))
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen({ path: socketPath, exclusive: true }, () => {
        server.off('error', onError)
        resolve()
      })
    })
    this.server = server
    this.socketPath = socketPath
    server.on('error', (err) => this.log('server error', err))

    try {
      await fs.chmod(socketPath, 0o600)
      const pointer: AgentPointer = {
        protocol: 1,
        socketPath,
        version: this.opts.version,
        pid: this.opts.pid
      }
      await atomicWrite(this.pointerPath, JSON.stringify(pointer, null, 2) + '\n')
    } catch (err) {
      await this.stop()
      throw err
    }
    return { socketPath }
  }

  /**
   * Close every connection, stop listening and remove the socket and pointer
   * files. The file removal happens synchronously so the quit path can call
   * this without waiting.
   */
  stop(): Promise<void> {
    const server = this.server
    const socketPath = this.socketPath
    this.server = null
    this.socketPath = null
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    const closed = new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    try {
      rmSync(this.pointerPath, { force: true })
    } catch (err) {
      this.log('could not remove pointer file', err)
    }
    if (socketPath) {
      try {
        rmSync(socketPath, { force: true })
      } catch (err) {
        this.log('could not remove socket', err)
      }
    }
    return closed
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket)
    const splitter = new AgentLineSplitter()
    let closing = false
    const write = (frame: AgentResponseFrame): void => {
      if (!closing && !socket.destroyed && socket.writable)
        socket.write(JSON.stringify(frame) + '\n')
    }
    socket.on('data', (chunk: Buffer) => {
      if (closing) return
      let lines: string[]
      try {
        lines = splitter.push(chunk)
      } catch (err) {
        const message = err instanceof FrameTooLargeError ? err.message : 'could not read request'
        write({ id: null, error: agentError('TOO_LARGE', message) })
        closing = true
        socket.end()
        return
      }
      for (const line of lines) void this.handleLine(line, write)
    })
    socket.on('error', (err) => {
      // EPIPE / ECONNRESET from a client that went away are routine.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPIPE' && code !== 'ECONNRESET') this.log('connection error', err)
    })
    socket.on('close', () => this.sockets.delete(socket))
  }

  private async handleLine(line: string, write: (f: AgentResponseFrame) => void): Promise<void> {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!text.trim()) return
    const parsed = parseFrame(text)
    if (!parsed.ok) {
      write({ id: parsed.id, error: parsed.error })
      return
    }
    const { id, method, params } = parsed.frame
    const invalid = validateParams(method, params)
    if (invalid) {
      write({ id, error: invalid })
      return
    }
    try {
      const result = await this.dispatch(method as AgentMethod, params)
      write({ id, result })
    } catch (err) {
      const error = toAgentError(err)
      if (error.code === 'INTERNAL') this.log(`${method} failed`, err)
      write({ id, error })
    }
  }

  private dispatch(method: AgentMethod, params: Record<string, unknown>): Promise<unknown> {
    const { host } = this.opts
    switch (method) {
      case 'listTabs':
        return Promise.resolve(host.listTabs())
      case 'newDrawing':
        return host.newDrawing(params as AgentParams<'newDrawing'>)
      default:
        return host.docOp(method, params as AgentParams<AgentDocOp>)
    }
  }
}
