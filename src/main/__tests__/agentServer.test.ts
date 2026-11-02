import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, connect, type Socket } from 'net'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import {
  AgentLineSplitter,
  AgentServer,
  chooseSocketPath,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  parseFrame,
  POINTER_NAME,
  removeStaleSocket,
  SOCKET_NAME,
  validateParams,
  type AgentHost
} from '../agentServer'
import type { AgentDocInfo, AgentResponseFrame } from '../../shared/agent'

const DOC: AgentDocInfo = {
  docId: 'doc-1',
  title: 'Untitled',
  path: null,
  dirty: false,
  active: true,
  windowId: 1
}

/** Short root so the socket path fits sun_path (macOS tmpdir is already long). */
function shortTempDir(): string {
  return mkdtempSync('/tmp/sb-agent-')
}

function fakeHost(overrides: Partial<AgentHost> = {}): AgentHost & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    listTabs: () => ({ docs: [DOC] }),
    newDrawing: async (p) => ({ ...DOC, docId: 'doc-2', title: p.title ?? 'Untitled' }),
    docOp: async (op, params) => {
      calls.push({ op, params })
      return { op, params }
    },
    ...overrides
  }
}

/** A raw NDJSON client: send lines, collect parsed response frames. */
class RawClient {
  readonly frames: AgentResponseFrame[] = []
  readonly closed: Promise<void>
  private buffer = ''
  private waiters: (() => void)[] = []
  private readonly socket: Socket

  constructor(path: string) {
    this.socket = connect(path)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        this.frames.push(JSON.parse(this.buffer.slice(0, nl)))
        this.buffer = this.buffer.slice(nl + 1)
      }
      for (const w of this.waiters.splice(0)) w()
    })
    this.closed = new Promise((res) => this.socket.on('close', () => res()))
    this.socket.on('error', () => {})
  }

  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.socket.once('connect', res)
      this.socket.once('error', rej)
    })
  }

  send(line: string | object): void {
    this.socket.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
  }

  /** Resolve once at least `n` frames have arrived. */
  async wait(n: number): Promise<AgentResponseFrame[]> {
    while (this.frames.length < n) await new Promise<void>((res) => this.waiters.push(res))
    return this.frames
  }

  async request(line: string | object): Promise<AgentResponseFrame> {
    const n = this.frames.length
    this.send(line)
    return (await this.wait(n + 1))[n]
  }

  end(): void {
    this.socket.destroy()
  }
}

let dir: string
let server: AgentServer | null
let host: ReturnType<typeof fakeHost>
let clients: RawClient[]

beforeEach(() => {
  dir = shortTempDir()
  server = null
  clients = []
})
afterEach(async () => {
  for (const c of clients) c.end()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(h: AgentHost = fakeHost()): Promise<string> {
  host = h as ReturnType<typeof fakeHost>
  server = new AgentServer({
    dir: join(dir, 'agent'),
    tmpdir: dir,
    version: '1.2.3',
    pid: process.pid,
    host,
    log: () => {}
  })
  return (await server.start()).socketPath
}

async function client(path: string): Promise<RawClient> {
  const c = new RawClient(path)
  clients.push(c)
  await c.ready()
  return c
}

describe('AgentServer', () => {
  it('creates the dir 0700, the socket 0600 and a pointer file', async () => {
    const socketPath = await startServer()
    const agentDir = join(dir, 'agent')
    expect(socketPath).toBe(join(agentDir, SOCKET_NAME))
    expect(statSync(agentDir).mode & 0o777).toBe(0o700)
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    const pointer = JSON.parse(readFileSync(join(agentDir, POINTER_NAME), 'utf8'))
    expect(pointer).toEqual({ protocol: 1, socketPath, version: '1.2.3', pid: process.pid })
    expect(server!.running).toBe(true)
  })

  it('answers listTabs', async () => {
    const c = await client(await startServer())
    const res = await c.request({ id: 1, method: 'listTabs', params: {} })
    expect(res).toEqual({ id: 1, result: { docs: [DOC] } })
  })

  it('forwards newDrawing and doc ops to the host', async () => {
    const c = await client(await startServer())
    expect(await c.request({ id: 'a', method: 'newDrawing', params: { title: 'Plan' } })).toEqual({
      id: 'a',
      result: { ...DOC, docId: 'doc-2', title: 'Plan' }
    })
    const params = { docId: 'doc-1', ids: ['x'] }
    expect(await c.request({ id: 2, method: 'deleteElements', params })).toEqual({
      id: 2,
      result: { op: 'deleteElements', params }
    })
    expect(host.calls).toEqual([{ op: 'deleteElements', params }])
  })

  it('rejects unknown methods', async () => {
    const c = await client(await startServer())
    const res = await c.request({ id: 3, method: 'nope', params: {} })
    expect(res).toMatchObject({ id: 3, error: { code: 'UNKNOWN_METHOD' } })
  })

  it('answers a garbage line with id null and keeps the connection usable', async () => {
    const c = await client(await startServer())
    expect(await c.request('this is not json')).toMatchObject({
      id: null,
      error: { code: 'BAD_PARAMS' }
    })
    expect(await c.request('[1,2]')).toMatchObject({ id: null, error: { code: 'BAD_PARAMS' } })
    expect(await c.request({ method: 'listTabs' })).toMatchObject({
      id: null,
      error: { code: 'BAD_PARAMS' }
    })
    expect(await c.request({ id: 7 })).toMatchObject({ id: 7, error: { code: 'BAD_PARAMS' } })
    expect(await c.request({ id: 4, method: 'listTabs' })).toEqual({
      id: 4,
      result: { docs: [DOC] }
    })
  })

  it('rejects bad params with BAD_PARAMS', async () => {
    const c = await client(await startServer())
    const cases: object[] = [
      { id: 1, method: 'getScene', params: { docId: '../x' } },
      { id: 2, method: 'getScene', params: { full: 'yes' } },
      { id: 3, method: 'addElements', params: { elements: [] } },
      { id: 4, method: 'addElements', params: { elements: [{ type: 'selection' }] } },
      { id: 5, method: 'addElements', params: { elements: [{ type: 'rectangle', id: 5 }] } },
      { id: 6, method: 'updateElements', params: { elements: [{ type: 'rectangle' }] } },
      { id: 7, method: 'deleteElements', params: { ids: ['a', 1] } },
      { id: 8, method: 'deleteElements', params: {} },
      { id: 9, method: 'exportImage', params: { maxSize: 100 } },
      { id: 10, method: 'exportImage', params: { maxSize: 5000 } },
      { id: 11, method: 'exportImage', params: { background: 1 } },
      { id: 12, method: 'newDrawing', params: { title: 'x'.repeat(201) } },
      { id: 13, method: 'listTabs', params: [] },
      { id: 14, method: 'addElements', params: { elements: 'rect' } },
      { id: 15, method: 'scrollTo', params: { ids: 'a' } }
    ]
    for (const [i, req] of cases.entries()) {
      const res = await c.request(req)
      expect(res, JSON.stringify(req)).toMatchObject({ id: i + 1, error: { code: 'BAD_PARAMS' } })
    }
    expect(host.calls).toEqual([])
  })

  it('passes AgentError throws from the host through', async () => {
    const c = await client(
      await startServer(
        fakeHost({
          docOp: async () => {
            throw { code: 'NO_SUCH_DOC', message: 'gone' }
          }
        })
      )
    )
    expect(await c.request({ id: 1, method: 'getScene', params: {} })).toEqual({
      id: 1,
      error: { code: 'NO_SUCH_DOC', message: 'gone' }
    })
  })

  it('maps a plain Error from the host to INTERNAL', async () => {
    const c = await client(
      await startServer(
        fakeHost({
          docOp: async () => {
            throw new Error('boom')
          }
        })
      )
    )
    expect(await c.request({ id: 1, method: 'getScene', params: {} })).toEqual({
      id: 1,
      error: { code: 'INTERNAL', message: 'boom' }
    })
    // Still serving.
    expect(await c.request({ id: 2, method: 'listTabs', params: {} })).toMatchObject({ id: 2 })
  })

  it('answers an oversize frame with TOO_LARGE and closes the socket', async () => {
    const c = await client(await startServer())
    const big =
      '{"id":1,"method":"listTabs","params":{"pad":"' + 'x'.repeat(MAX_FRAME_BYTES) + '"}}'
    c.send(big)
    await c.closed
    expect(c.frames).toEqual([
      { id: null, error: { code: 'TOO_LARGE', message: expect.stringContaining('exceeds') } }
    ])
  })

  it('serves concurrent requests on one connection with matching ids', async () => {
    const gates = new Map<string, () => void>()
    const c = await client(
      await startServer(
        fakeHost({
          docOp: (_op, params) =>
            new Promise((res) => {
              const docId = (params as { docId: string }).docId
              gates.set(docId, () => res({ got: docId }))
            })
        })
      )
    )
    c.send({ id: 'first', method: 'getScene', params: { docId: 'A' } })
    c.send({ id: 'second', method: 'getScene', params: { docId: 'B' } })
    c.send({ id: 'third', method: 'listTabs', params: {} })
    await c.wait(1)
    expect(c.frames[0]).toMatchObject({ id: 'third' })
    await vi.waitFor(() => expect(gates.size).toBe(2))
    gates.get('B')!()
    await c.wait(2)
    expect(c.frames[1]).toEqual({ id: 'second', result: { got: 'B' } })
    gates.get('A')!()
    await c.wait(3)
    expect(c.frames[2]).toEqual({ id: 'first', result: { got: 'A' } })
  })

  it('stop() removes the socket and pointer and drops connections', async () => {
    const socketPath = await startServer()
    const c = await client(socketPath)
    await server!.stop()
    expect(server!.running).toBe(false)
    expect(existsSync(socketPath)).toBe(false)
    expect(existsSync(join(dir, 'agent', POINTER_NAME))).toBe(false)
    await c.closed
  })

  it('start() replaces a stale socket file', async () => {
    const agentDir = join(dir, 'agent')
    const stale = join(agentDir, SOCKET_NAME)
    // Make a socket file nobody listens on: listen elsewhere, move the inode, close.
    const { mkdirSync } = await import('fs')
    mkdirSync(agentDir, { recursive: true })
    const tmpSock = join(agentDir, 'old.sock')
    const old = createServer()
    await new Promise<void>((res) => old.listen(tmpSock, res))
    renameSync(tmpSock, stale)
    await new Promise<void>((res) => old.close(() => res()))
    expect(statSync(stale).isSocket()).toBe(true)

    const socketPath = await startServer()
    expect(socketPath).toBe(stale)
    const c = await client(socketPath)
    expect(await c.request({ id: 1, method: 'listTabs', params: {} })).toMatchObject({ id: 1 })
  })

  it('start() refuses to steal a live socket', async () => {
    const agentDir = join(dir, 'agent')
    const { mkdirSync } = await import('fs')
    mkdirSync(agentDir, { recursive: true })
    const live = createServer()
    await new Promise<void>((res) => live.listen(join(agentDir, SOCKET_NAME), res))
    try {
      await expect(startServer()).rejects.toThrow(/already listening/)
      expect(server!.running).toBe(false)
    } finally {
      await new Promise<void>((res) => live.close(() => res()))
    }
  })

  it('removeStaleSocket ignores a missing path', async () => {
    await expect(removeStaleSocket(join(dir, 'nothing.sock'))).resolves.toBeUndefined()
  })
})

describe('chooseSocketPath', () => {
  it('prefers <dir>/agent.sock when it fits', () => {
    expect(chooseSocketPath('/tmp/x', '/tmp')).toBe('/tmp/x/agent.sock')
  })

  it('falls back to a short per-profile name in tmpdir for long dirs', () => {
    const long = '/Users/someone/Library/Application Support/' + 'a'.repeat(80)
    const p = chooseSocketPath(long, '/tmp')
    expect(p.startsWith('/tmp/sketchbook-')).toBe(true)
    expect(p.endsWith('.sock')).toBe(true)
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(100)
    expect(chooseSocketPath(long, '/tmp')).toBe(p)
    expect(chooseSocketPath(long + 'b', '/tmp')).not.toBe(p)
  })

  it('is used by start() for a long dir', async () => {
    const long = join(dir, 'a'.repeat(100))
    host = fakeHost()
    server = new AgentServer({
      dir: long,
      tmpdir: dir,
      version: '0',
      pid: 1,
      host,
      log: () => {}
    })
    const { socketPath } = await server.start()
    expect(socketPath.startsWith(join(dir, 'sketchbook-'))).toBe(true)
    expect(JSON.parse(readFileSync(join(long, POINTER_NAME), 'utf8')).socketPath).toBe(socketPath)
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    await server.stop()
    expect(existsSync(socketPath)).toBe(false)
  })
})

describe('AgentLineSplitter', () => {
  it('splits lines across chunks', () => {
    const s = new AgentLineSplitter()
    expect(s.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}'])
    expect(s.push(Buffer.from(':2}\n\n{"c":3}\n'))).toEqual(['{"b":2}', '', '{"c":3}'])
    expect(s.push(Buffer.from('tail'))).toEqual([])
  })

  it('keeps multi-byte characters split across chunks intact', () => {
    const s = new AgentLineSplitter()
    const bytes = Buffer.from('é\n')
    expect(s.push(bytes.subarray(0, 1))).toEqual([])
    expect(s.push(bytes.subarray(1))).toEqual(['é'])
  })

  it('throws once a partial or complete line exceeds the cap', () => {
    const s = new AgentLineSplitter(8)
    expect(s.push(Buffer.from('12345'))).toEqual([])
    expect(() => s.push(Buffer.from('6789'))).toThrow(FrameTooLargeError)
    const t = new AgentLineSplitter(8)
    expect(() => t.push(Buffer.from('123456789\n'))).toThrow(FrameTooLargeError)
    expect(new AgentLineSplitter(8).push(Buffer.from('12345678\n'))).toEqual(['12345678'])
  })
})

describe('parseFrame', () => {
  it('fills in empty params', () => {
    expect(parseFrame('{"id":1,"method":"listTabs"}')).toEqual({
      ok: true,
      frame: { id: 1, method: 'listTabs', params: {} }
    })
  })

  it('reports the id when it can', () => {
    expect(parseFrame('{"id":"x","method":1}')).toMatchObject({ ok: false, id: 'x' })
    expect(parseFrame('{"id":"x","method":"m","params":[]}')).toMatchObject({ ok: false, id: 'x' })
    expect(parseFrame('{"id":true,"method":"m"}')).toMatchObject({ ok: false, id: null })
    expect(parseFrame('null')).toMatchObject({ ok: false, id: null })
  })
})

describe('validateParams', () => {
  it('accepts valid params for every method', () => {
    expect(validateParams('listTabs', {})).toBeNull()
    expect(validateParams('newDrawing', {})).toBeNull()
    expect(validateParams('newDrawing', { title: 'Plan' })).toBeNull()
    expect(validateParams('getScene', { docId: 'abc_-1', full: true })).toBeNull()
    expect(
      validateParams('addElements', {
        elements: [{ type: 'rectangle', id: 'r1', x: 0 }, { type: 'arrow' }],
        scrollTo: false
      })
    ).toBeNull()
    expect(validateParams('updateElements', { elements: [{ id: 'r1', x: 10 }] })).toBeNull()
    expect(validateParams('deleteElements', { ids: ['r1'] })).toBeNull()
    expect(
      validateParams('exportImage', {
        ids: ['r1'],
        maxSize: 256,
        background: true,
        dark: false,
        padding: 20
      })
    ).toBeNull()
    expect(validateParams('exportImage', { maxSize: 4096 })).toBeNull()
    expect(validateParams('scrollTo', {})).toBeNull()
    expect(validateParams('scrollTo', { ids: [] })).toBeNull()
  })

  it('enforces the count limits', () => {
    const many = (n: number): { type: string }[] =>
      Array.from({ length: n }, () => ({ type: 'text' }))
    expect(validateParams('addElements', { elements: many(2000) })).toBeNull()
    expect(validateParams('addElements', { elements: many(2001) })).toMatchObject({
      code: 'BAD_PARAMS'
    })
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `id${i}`)
    expect(validateParams('deleteElements', { ids: ids(5000) })).toBeNull()
    expect(validateParams('deleteElements', { ids: ids(5001) })).toMatchObject({
      code: 'BAD_PARAMS'
    })
  })

  it('rejects non-object params and unknown methods', () => {
    expect(validateParams('listTabs', null)).toMatchObject({ code: 'BAD_PARAMS' })
    expect(validateParams('listTabs', 'x')).toMatchObject({ code: 'BAD_PARAMS' })
    expect(validateParams('frobnicate', {})).toMatchObject({ code: 'UNKNOWN_METHOD' })
  })
})
