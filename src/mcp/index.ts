// Entry point of the bundled MCP server (built to out/main/mcp.js, shipped as
// Contents/Resources/mcp/index.js and run with ELECTRON_RUN_AS_NODE=1).
//
// Rules for this directory: never import 'electron'; never share runtime
// modules with src/main (the build fails if mcp.js ends up with imports; see
// mcpSelfContained in electron.vite.config.ts); never write to stdout except
// MCP protocol traffic — use stderr for diagnostics.
//
// The socket is only touched inside tool handlers, so `tools/list` works with
// Sketchbook closed and each tool call reports NOT_RUNNING / DISABLED instead.
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createSocketRpc } from './client'
import { createServer } from './server'

serveStdio(() => createServer({ rpc: createSocketRpc(), version: __SKETCHBOOK_VERSION__ }), {
  onerror: (err) => console.error('sketchbook mcp:', err.message)
})
