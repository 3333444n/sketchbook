import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { drawText, launchApp, makeTempDir, nonLocal, ROOT, waitForExcalidraw } from './fixtures'

// Smoke test for the packaged app produced by `pnpm build:mac`.
// Skipped unless dist/mac-arm64/Sketchbook.app exists.
const APP = join(ROOT, 'dist/mac-arm64/Sketchbook.app')
const BINARY = join(APP, 'Contents/MacOS/Sketchbook')
const MCP_SCRIPT = join(APP, 'Contents/Resources/mcp/index.js')

test('packaged Sketchbook.app starts offline with bundled fonts', async () => {
  test.skip(!existsSync(BINARY), 'run `pnpm build:mac` first')
  const ctx = await launchApp({ executablePath: BINARY })
  try {
    const { page, app } = ctx
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await waitForExcalidraw(page)
    expect(page.url()).toBe('app://bundle/index.html')
    await drawText(page, 'Packaged')
    const ok = await page.evaluate(async () => {
      await document.fonts.load('20px Excalifont', 'Packaged')
      return document.fonts.check('20px Excalifont', 'Packaged')
    })
    expect(ok).toBe(true)
    expect(ctx.requests.some((u) => u.startsWith('app://bundle/fonts/Excalifont/'))).toBe(true)
    expect(await ctx.cspViolations()).toEqual([])
    const mainSeen = await app.evaluate(
      () => (globalThis as unknown as { __sbRequests: string[] }).__sbRequests
    )
    expect(nonLocal([...ctx.requests, ...mainSeen])).toEqual([])
  } finally {
    await ctx.close()
  }
})

test('the packaged MCP server runs in node mode and reports DISABLED when the app is off', async () => {
  test.skip(!existsSync(BINARY), 'run `pnpm build:mac` first')
  expect(existsSync(MCP_SCRIPT), 'Contents/Resources/mcp/index.js is shipped').toBe(true)
  // A scratch profile that never had the bridge enabled (and no app running on it).
  const userData = makeTempDir('sketchbook-packaged-mcp-')
  const transport = new StdioClientTransport({
    command: BINARY,
    args: [MCP_SCRIPT],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RUN_AS_NODE: '1',
      SKETCHBOOK_USER_DATA: userData
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'e2e-packaged', version: '0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('get_scene')
    expect(tools).toHaveLength(8)

    const res = (await client.callTool({ name: 'list_drawings', arguments: {} })) as unknown as {
      content: { type: string; text?: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/^DISABLED: /)
    expect(res.content[0].text).toContain('Allow Agent Connections')
  } finally {
    await client.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
