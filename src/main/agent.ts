// Agent bridge: electron glue around agentServer.ts.
//
// Owns the on/off state (persisted in userData/settings.json), builds the
// AgentHost from the documents facade, and shows the setup dialog. The socket
// and pointer file live in userData/agent/ (see agentServer.ts).
import { app, BrowserWindow, clipboard, dialog } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AgentDocOp, AgentParams, AgentResult } from '../shared/agent'
import { AgentServer, agentError, type AgentHost } from './agentServer'
import { claudeMcpAddCommand, mcpConfigJSON, type McpLaunch } from './agentConfig'
import { readSettings, writeSettings } from './settings'
import { agentListDocs, agentNewDrawing, agentResolveDoc, rendererRequest } from './documents'

/** How long main waits for the renderer to answer a per-doc op. */
const OP_TIMEOUT_MS = 15_000
/** Rendering a PNG of a large scene can take a while. */
const EXPORT_TIMEOUT_MS = 45_000

let server: AgentServer | null = null
/** Serialises enable/disable so a double-click on the menu item cannot interleave. */
let queue: Promise<unknown> = Promise.resolve()

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function agentDir(): string {
  return join(app.getPath('userData'), 'agent')
}

function buildHost(): AgentHost {
  return {
    listTabs: (): AgentResult<'listTabs'> => ({ docs: agentListDocs() }),
    newDrawing: async (params: AgentParams<'newDrawing'>): Promise<AgentResult<'newDrawing'>> =>
      agentNewDrawing(params.title),
    docOp: (op: AgentDocOp, params: AgentParams<AgentDocOp>): Promise<unknown> => {
      const target = agentResolveDoc(params.docId)
      if (!target) {
        return Promise.reject(
          agentError(
            'NO_SUCH_DOC',
            params.docId
              ? `no open drawing with docId "${params.docId}"`
              : 'no drawing is open; call newDrawing first'
          )
        )
      }
      const timeout = op === 'exportImage' ? EXPORT_TIMEOUT_MS : OP_TIMEOUT_MS
      return rendererRequest(target.w, target.d.docId, op, params, timeout)
    }
  }
}

async function startServer(): Promise<void> {
  if (server?.running) return
  server ??= new AgentServer({
    dir: agentDir(),
    tmpdir: tmpdir(),
    // Build-time package.json version (app.getVersion() is Electron's own in dev).
    version: __SKETCHBOOK_VERSION__,
    pid: process.pid,
    host: buildHost()
  })
  await server.start()
}

async function stopServer(): Promise<void> {
  if (server) await server.stop()
}

/**
 * Read the persisted setting and start the bridge if it is on. A failure to
 * start is logged and leaves the bridge off (the menu reflects the real state).
 */
export async function initAgent(): Promise<void> {
  app.on('will-quit', () => {
    // stop() removes the socket and pointer synchronously; no need to wait.
    void stopServer()
  })
  const settings = await readSettings(settingsFile())
  if (!settings.allowAgentConnections) return
  try {
    await startServer()
  } catch (err) {
    console.error('[agent] could not start the agent bridge:', err)
  }
}

export function isAgentEnabled(): boolean {
  return server?.running ?? false
}

/**
 * Turn the bridge on or off and persist the choice. Resolves to the effective
 * state; on failure the user is told and the state is left as it is.
 */
export function setAgentEnabled(on: boolean): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    try {
      if (on) await startServer()
      else await stopServer()
    } catch (err) {
      dialog.showErrorBox(
        on ? 'Could not allow agent connections' : 'Could not stop agent connections',
        (err as Error).message
      )
    }
    const effective = isAgentEnabled()
    try {
      await writeSettings(settingsFile(), { allowAgentConnections: effective })
    } catch (err) {
      console.error('[agent] could not write settings:', err)
    }
    return effective
  }
  const next = queue.then(run, run)
  queue = next
  return next
}

/** Where an MCP client should find the bundled server. */
export function mcpLaunch(): McpLaunch {
  // In both cases `process.execPath` honours ELECTRON_RUN_AS_NODE: the packaged
  // app binary, or the Electron binary in development.
  return app.isPackaged
    ? { command: process.execPath, script: join(process.resourcesPath, 'mcp', 'index.js') }
    : { command: process.execPath, script: join(__dirname, 'mcp.js') }
}

/** "Agent ▸ Set Up Agent Access…": show the config snippets with Copy buttons. */
export async function showAgentSetup(): Promise<void> {
  const launch = mcpLaunch()
  const json = mcpConfigJSON(launch)
  const command = claudeMcpAddCommand(launch)
  const status = isAgentEnabled()
    ? 'Agent connections are on.'
    : 'Agent connections are off. Turn on Agent ▸ Allow Agent Connections to let a connected agent draw.'
  const opts: Electron.MessageBoxOptions = {
    type: 'info',
    message: 'Set Up Agent Access',
    detail: [
      'Sketchbook ships an MCP server that lets an AI agent (Claude Code, Claude Desktop, Cursor, Codex…) read and edit the drawing you are looking at.',
      status,
      `Claude Code:\n${command}`,
      `Other MCP clients (JSON):\n${json}`
    ].join('\n\n'),
    buttons: ['Copy JSON', 'Copy claude mcp add command', 'Close'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const parent = BrowserWindow.getFocusedWindow()
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  if (r.response === 0) clipboard.writeText(json)
  else if (r.response === 1) clipboard.writeText(command)
}
