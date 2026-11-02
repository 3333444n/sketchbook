import { describe, expect, it } from 'vitest'
import { claudeMcpAddCommand, mcpConfig, mcpConfigJSON, shellQuote } from '../agentConfig'

const launch = {
  command: '/Applications/Sketchbook.app/Contents/MacOS/Sketchbook',
  script: '/Applications/Sketchbook.app/Contents/Resources/mcp/index.js'
}

describe('mcpConfigJSON', () => {
  it('produces an mcpServers.sketchbook entry with ELECTRON_RUN_AS_NODE', () => {
    const parsed = JSON.parse(mcpConfigJSON(launch))
    expect(parsed).toEqual({
      mcpServers: {
        sketchbook: {
          command: launch.command,
          args: [launch.script],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        }
      }
    })
    expect(parsed).toEqual(mcpConfig(launch))
    // Pretty-printed so it can be pasted into a config file.
    expect(mcpConfigJSON(launch)).toContain('\n  "mcpServers"')
  })

  it('keeps paths with spaces verbatim (JSON needs no shell quoting)', () => {
    const parsed = JSON.parse(
      mcpConfigJSON({ command: '/Users/me/My Apps/Sketchbook', script: '/x y/mcp.js' })
    )
    expect(parsed.mcpServers.sketchbook.command).toBe('/Users/me/My Apps/Sketchbook')
    expect(parsed.mcpServers.sketchbook.args).toEqual(['/x y/mcp.js'])
  })
})

describe('claudeMcpAddCommand', () => {
  it('builds the one-liner without quotes for plain paths', () => {
    expect(claudeMcpAddCommand(launch)).toBe(
      `claude mcp add sketchbook -e ELECTRON_RUN_AS_NODE=1 -- ${launch.command} ${launch.script}`
    )
  })

  it('single-quotes paths with spaces and escapes embedded quotes', () => {
    const cmd = claudeMcpAddCommand({
      command: "/Users/me/It's Here/Sketchbook.app/Contents/MacOS/Sketchbook",
      script: '/Users/me/dev/sketch book/out/main/mcp.js'
    })
    expect(cmd).toBe(
      'claude mcp add sketchbook -e ELECTRON_RUN_AS_NODE=1 -- ' +
        "'/Users/me/It'\\''s Here/Sketchbook.app/Contents/MacOS/Sketchbook' " +
        "'/Users/me/dev/sketch book/out/main/mcp.js'"
    )
  })
})

describe('shellQuote', () => {
  it('leaves safe strings alone', () => {
    expect(shellQuote('/a/b-c_d.e')).toBe('/a/b-c_d.e')
  })
  it('quotes anything else', () => {
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    expect(shellQuote('')).toBe("''")
  })
})
