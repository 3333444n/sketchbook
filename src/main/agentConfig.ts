// Snippets shown by "Agent ▸ Set Up Agent Access…". Pure (no 'electron' import).
//
// The bundled MCP server is run by the app binary itself in node mode:
//   ELECTRON_RUN_AS_NODE=1 <command> <script>

export type McpLaunch = {
  /** The executable to run (the Sketchbook binary, or Electron in dev). */
  command: string
  /** Absolute path of the MCP server script. */
  script: string
}

export const MCP_SERVER_NAME = 'sketchbook'

/** The `mcpServers` entry for Claude Desktop, Cursor, `.mcp.json` and friends. */
export function mcpConfig(launch: McpLaunch): {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
} {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: launch.command,
        args: [launch.script],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  }
}

export function mcpConfigJSON(launch: McpLaunch): string {
  return JSON.stringify(mcpConfig(launch), null, 2)
}

/** Quote `arg` for a POSIX shell unless it is made only of safe characters. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** One-liner for Claude Code. */
export function claudeMcpAddCommand(launch: McpLaunch): string {
  return [
    'claude mcp add',
    MCP_SERVER_NAME,
    '-e ELECTRON_RUN_AS_NODE=1',
    '--',
    shellQuote(launch.command),
    shellQuote(launch.script)
  ].join(' ')
}
