// Socket client of the bundled MCP server: finds the running Sketchbook's
// agent bridge (userData/agent/agent.json) and sends one NDJSON request per
// connection. Pure Node; never imports 'electron' or runtime code from
// src/main (see src/shared/agent.ts for why).
import { existsSync, promises as fs } from 'node:fs'
import * as net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AgentError,
  AgentErrorCode,
  AgentMethod,
  AgentParams,
  AgentPointer,
  AgentResponseFrame,
  AgentResult,
  AgentRpc
} from '../shared/agent'

export const DISABLED_HINT =
  'Open Sketchbook and turn on Agent ▸ Allow Agent Connections (the bridge is off by default).'
export const NOT_RUNNING_HINT = "Sketchbook isn't running. Open it, then try again."

export function agentError(code: AgentErrorCode, message: string): AgentError {
  return { code, message }
}

export function isAgentError(value: unknown): value is AgentError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentError).code === 'string' &&
    typeof (value as AgentError).message === 'string'
  )
}

/**
 * Sketchbook's Electron `userData` directory. `SKETCHBOOK_USER_DATA` overrides;
 * otherwise the packaged app's `…/Sketchbook`, then the dev build's
 * `…/sketchbook` (no `app.setName`), falling back to the packaged name.
 */
export function userDataDir(): string {
  const override = process.env.SKETCHBOOK_USER_DATA
  if (override) return override
  const base = join(homedir(), 'Library', 'Application Support')
  const candidates = [join(base, 'Sketchbook'), join(base, 'sketchbook')]
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]
}

export function pointerFile(userData = userDataDir()): string {
  return join(userData, 'agent', 'agent.json')
}

export function settingsFile(userData = userDataDir()): string {
  return join(userData, 'settings.json')
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

function asPointer(value: unknown): AgentPointer | null {
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  if (p.protocol !== 1) return null
  if (typeof p.socketPath !== 'string' || !p.socketPath) return null
  if (typeof p.pid !== 'number' || !Number.isInteger(p.pid) || p.pid <= 0) return null
  return {
    protocol: 1,
    socketPath: p.socketPath,
    version: typeof p.version === 'string' ? p.version : '',
    pid: p.pid
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function bridgeEnabled(userData: string): Promise<boolean> {
  const settings = await readJson(settingsFile(userData))
  return (
    typeof settings === 'object' &&
    settings !== null &&
    (settings as Record<string, unknown>).allowAgentConnections === true
  )
}

/**
 * Resolve the Unix socket of the running app, or throw an `AgentError`:
 * `DISABLED` when the setting is off (or the settings file is missing) and no
 * bridge is advertised, `NOT_RUNNING` when it is on but no live pointer exists.
 */
export async function locate(userData = userDataDir()): Promise<string> {
  const pointer = asPointer(await readJson(pointerFile(userData)))
  if (pointer) {
    if (pidAlive(pointer.pid)) return pointer.socketPath
    throw agentError(
      'NOT_RUNNING',
      `${NOT_RUNNING_HINT} (A stale socket pointer from a previous session was found; it is replaced when Sketchbook starts.)`
    )
  }
  if (await bridgeEnabled(userData)) throw agentError('NOT_RUNNING', NOT_RUNNING_HINT)
  throw agentError('DISABLED', DISABLED_HINT)
}

export type SocketRpcOptions = {
  /** Milliseconds to wait for the app to accept the connection. */
  connectTimeoutMs?: number
  /** Milliseconds to wait for the reply once the request was sent. */
  requestTimeoutMs?: number
  /** Override the userData directory (tests). */
  userData?: string
}

/**
 * An `AgentRpc` that opens one connection per call, writes a single NDJSON
 * frame `{id: 1, method, params}` and resolves with the first reply line.
 * Socket failures map to `NOT_RUNNING`, waits to `TIMEOUT`; errors sent by
 * the app are thrown as-is (`{code, message}`).
 */
export function createSocketRpc(options: SocketRpcOptions = {}): AgentRpc {
  const connectTimeoutMs = options.connectTimeoutMs ?? 3000
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000
  return async <M extends AgentMethod>(
    method: M,
    params: AgentParams<M>
  ): Promise<AgentResult<M>> => {
    const socketPath = await locate(options.userData)
    const frame = await request(socketPath, JSON.stringify({ id: 1, method, params }) + '\n', {
      connectTimeoutMs,
      requestTimeoutMs
    })
    if ('error' in frame) {
      throw isAgentError(frame.error)
        ? frame.error
        : agentError('INTERNAL', 'Sketchbook returned a malformed error')
    }
    return frame.result as AgentResult<M>
  }
}

function request(
  socketPath: string,
  line: string,
  opts: { connectTimeoutMs: number; requestTimeoutMs: number }
): Promise<AgentResponseFrame> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const socket = net.connect(socketPath)
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const fail = (err: AgentError): void => finish(() => reject(err))
    const arm = (ms: number, err: AgentError): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => fail(err), ms)
    }

    arm(
      opts.connectTimeoutMs,
      agentError(
        'TIMEOUT',
        `Sketchbook did not accept the connection within ${opts.connectTimeoutMs} ms`
      )
    )

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const stale = err.code === 'ECONNREFUSED' || err.code === 'ENOENT'
      fail(
        agentError(
          'NOT_RUNNING',
          stale
            ? `${NOT_RUNNING_HINT} (The socket at ${socketPath} is stale: ${err.code}.)`
            : `${NOT_RUNNING_HINT} (${err.code ?? err.message})`
        )
      )
    })

    socket.on('connect', () => {
      arm(
        opts.requestTimeoutMs,
        agentError('TIMEOUT', `Sketchbook did not reply within ${opts.requestTimeoutMs} ms`)
      )
      const rl = createInterface({ input: socket, crlfDelay: Infinity })
      rl.once('line', (text) => {
        rl.close()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          fail(agentError('INTERNAL', 'Sketchbook sent a reply that is not JSON'))
          return
        }
        if (typeof parsed !== 'object' || parsed === null) {
          fail(agentError('INTERNAL', 'Sketchbook sent a malformed reply'))
          return
        }
        finish(() => resolve(parsed as AgentResponseFrame))
      })
      socket.on('close', () => {
        fail(
          agentError('NOT_RUNNING', `${NOT_RUNNING_HINT} (The connection closed without a reply.)`)
        )
      })
      socket.write(line)
    })
  })
}
