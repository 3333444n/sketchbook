import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentError, AgentPointer, AgentRequestFrame } from '../../shared/agent'
import { createSocketRpc, locate, userDataDir } from '../client'

let userData: string
let cleanup: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  // Keep the path short: macOS limits Unix socket paths to ~104 bytes.
  userData = await fs.mkdtemp(join(tmpdir(), 'sb-'))
  process.env.SKETCHBOOK_USER_DATA = userData
})

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
  delete process.env.SKETCHBOOK_USER_DATA
  await fs.rm(userData, { recursive: true, force: true })
})

async function writeSettings(allowAgentConnections: boolean): Promise<void> {
  await fs.writeFile(join(userData, 'settings.json'), JSON.stringify({ allowAgentConnections }))
}

async function writePointer(pointer: AgentPointer): Promise<void> {
  await fs.mkdir(join(userData, 'agent'), { recursive: true })
  await fs.writeFile(join(userData, 'agent', 'agent.json'), JSON.stringify(pointer))
}

/**
 * A fake Sketchbook bridge speaking NDJSON. `listTabs` answers with one doc;
 * `getScene` with `docId: 'bad'` answers with an error, with `docId: 'hang'`
 * never answers, with `docId: 'drop'` closes the connection without replying.
 */
async function startFakeBridge(): Promise<{ socketPath: string; requests: AgentRequestFrame[] }> {
  const socketPath = join(userData, 'a.sock')
  const requests: AgentRequestFrame[] = []
  const server = net.createServer((socket) => {
    const rl = createInterface({ input: socket })
    rl.on('line', (line) => {
      const req = JSON.parse(line) as AgentRequestFrame
      requests.push(req)
      const params = (req.params ?? {}) as { docId?: string }
      const reply = (frame: object): boolean => socket.write(JSON.stringify(frame) + '\n')
      if (req.method === 'listTabs') {
        reply({
          id: req.id,
          result: {
            docs: [
              { docId: 'd1', title: 'One', path: null, dirty: false, active: true, windowId: 1 }
            ]
          }
        })
      } else if (params.docId === 'bad') {
        reply({ id: req.id, error: { code: 'NO_SUCH_DOC', message: 'no doc bad' } })
      } else if (params.docId === 'drop') {
        socket.end()
      } else if (params.docId === 'hang') {
        // never reply
      } else {
        reply({ id: req.id, result: { echoed: req } })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await writePointer({ protocol: 1, socketPath, version: 'test', pid: process.pid })
  return { socketPath, requests }
}

async function expectAgentError(
  p: Promise<unknown>,
  code: AgentError['code']
): Promise<AgentError> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught).toMatchObject({ code })
  expect(typeof (caught as AgentError).message).toBe('string')
  return caught as AgentError
}

describe('userDataDir', () => {
  it('honours SKETCHBOOK_USER_DATA', () => {
    expect(userDataDir()).toBe(userData)
  })

  it('falls back to Application Support when the override is unset', () => {
    delete process.env.SKETCHBOOK_USER_DATA
    expect(userDataDir()).toMatch(/Library\/Application Support\/[Ss]ketchbook$/)
  })
})

describe('locate', () => {
  it('is DISABLED with no pointer and the setting off', async () => {
    await writeSettings(false)
    const err = await expectAgentError(locate(), 'DISABLED')
    expect(err.message).toMatch(/Allow Agent Connections/)
  })

  it('is DISABLED with no pointer and no settings file', async () => {
    await expectAgentError(locate(), 'DISABLED')
  })

  it('is NOT_RUNNING with no pointer and the setting on', async () => {
    await writeSettings(true)
    const err = await expectAgentError(locate(), 'NOT_RUNNING')
    expect(err.message).toMatch(/isn't running/)
  })

  it('is NOT_RUNNING when the pointer names a dead pid', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    const pid = child.pid as number
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    await writeSettings(true)
    await writePointer({ protocol: 1, socketPath: join(userData, 'a.sock'), version: 't', pid })
    const err = await expectAgentError(locate(), 'NOT_RUNNING')
    expect(err.message).toMatch(/stale/i)
  })

  it('ignores a malformed pointer', async () => {
    await fs.mkdir(join(userData, 'agent'), { recursive: true })
    await fs.writeFile(join(userData, 'agent', 'agent.json'), '{not json')
    await expectAgentError(locate(), 'DISABLED')
  })

  it('returns the socket path of a live pointer', async () => {
    const { socketPath } = await startFakeBridge()
    await expect(locate()).resolves.toBe(socketPath)
  })
})

describe('createSocketRpc', () => {
  it('round-trips a request as one NDJSON frame', async () => {
    const { requests } = await startFakeBridge()
    const rpc = createSocketRpc()
    const result = await rpc('listTabs', {})
    expect(result.docs[0].docId).toBe('d1')
    expect(requests).toEqual([{ id: 1, method: 'listTabs', params: {} }])
  })

  it('sends params verbatim and uses a fresh connection per call', async () => {
    const { requests } = await startFakeBridge()
    const rpc = createSocketRpc()
    await rpc('scrollTo', { docId: 'd1', ids: ['x'] })
    await rpc('scrollTo', { docId: 'd1' })
    expect(requests.map((r) => r.params)).toEqual([{ docId: 'd1', ids: ['x'] }, { docId: 'd1' }])
    expect(requests.map((r) => r.id)).toEqual([1, 1])
  })

  it('throws the error object sent by the app', async () => {
    await startFakeBridge()
    const rpc = createSocketRpc()
    const err = await expectAgentError(rpc('getScene', { docId: 'bad' }), 'NO_SUCH_DOC')
    expect(err).toEqual({ code: 'NO_SUCH_DOC', message: 'no doc bad' })
  })

  it('maps a request timeout to TIMEOUT', async () => {
    await startFakeBridge()
    const rpc = createSocketRpc({ requestTimeoutMs: 50 })
    const err = await expectAgentError(rpc('getScene', { docId: 'hang' }), 'TIMEOUT')
    expect(err.message).toMatch(/50 ms/)
  })

  it('maps a connection closed without reply to NOT_RUNNING', async () => {
    await startFakeBridge()
    const rpc = createSocketRpc()
    await expectAgentError(rpc('getScene', { docId: 'drop' }), 'NOT_RUNNING')
  })

  it('maps a stale socket (ENOENT) to NOT_RUNNING', async () => {
    await writePointer({
      protocol: 1,
      socketPath: join(userData, 'gone.sock'),
      version: 't',
      pid: process.pid
    })
    const err = await expectAgentError(createSocketRpc()('listTabs', {}), 'NOT_RUNNING')
    expect(err.message).toMatch(/stale/)
    expect(err.message).toMatch(/ENOENT/)
  })

  it('maps a refused connection (ECONNREFUSED) to NOT_RUNNING', async () => {
    const socketPath = join(userData, 'dead.sock')
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Recreate the file so the path exists but nobody listens.
    await fs.writeFile(socketPath, '')
    await writePointer({ protocol: 1, socketPath, version: 't', pid: process.pid })
    const err = await expectAgentError(createSocketRpc()('listTabs', {}), 'NOT_RUNNING')
    expect(err.message).toMatch(/isn't running/)
  })

  it('surfaces DISABLED without touching the socket', async () => {
    await writeSettings(false)
    await expectAgentError(createSocketRpc()('listTabs', {}), 'DISABLED')
  })
})
