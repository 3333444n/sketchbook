// Entry point of the bundled MCP server (built to out/main/mcp.js, shipped as
// Contents/Resources/mcp/index.js and run with ELECTRON_RUN_AS_NODE=1).
//
// Rules for this directory: never import 'electron'; never share runtime
// modules with src/main (the build fails if mcp.js ends up with imports; see
// mcpSelfContained in electron.vite.config.ts); never write to stdout except
// MCP protocol traffic — use stderr for diagnostics.
//
// Phase A stub; Phase B3 replaces it with the real server.

console.error('sketchbook mcp: not implemented yet (' + __SKETCHBOOK_VERSION__ + ')')
process.exit(0)
