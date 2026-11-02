import { test, expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import type { AgentError, ElementSummary, SceneSummary } from '../../src/shared/agent'
import { createSocketRpc } from '../../src/mcp/client'
import {
  launchApp,
  makeAgentProfile,
  makeTempDir,
  nonLocal,
  readPointer,
  readSettings,
  ROOT,
  toggleAgentMenu,
  waitForExcalidraw,
  waitForNoPointer,
  waitForPointer,
  type Launched
} from './fixtures'

// The agent bridge end to end: the production build with a pre-enabled
// profile, driven over the Unix socket exactly as the bundled MCP server does
// (src/mcp/client.ts), plus the MCP server itself over stdio.

const MCP_SCRIPT = join(ROOT, 'out/main/mcp.js')

async function agentErrorOf(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p
  } catch (err) {
    return err as AgentError
  }
  throw new Error('expected the call to reject')
}

function tabTitles(page: Page): Promise<string[]> {
  return page.$$eval('.sketchbook-tab__title', (els) => els.map((e) => e.textContent ?? ''))
}

function summaries(scene: SceneSummary): ElementSummary[] {
  return scene.elements as ElementSummary[]
}

async function assertOffline(ctx: Launched): Promise<void> {
  expect(await ctx.cspViolations(), 'CSP violations').toEqual([])
  const mainSeen = await ctx.app.evaluate(
    () => (globalThis as unknown as { __sbRequests: string[] }).__sbRequests
  )
  expect(nonLocal([...ctx.requests, ...mainSeen]), 'non-local requests').toEqual([])
}

test.describe('agent bridge (socket)', () => {
  let userData: string
  let ctx: Launched

  test.beforeEach(async () => {
    userData = makeAgentProfile()
    ctx = await launchApp({ userData })
    await waitForExcalidraw(ctx.page)
  })

  test.afterEach(async () => {
    await ctx?.close()
    rmSync(userData, { recursive: true, force: true })
  })

  test('full round trip: list, add, read, update, export, delete, new drawing, errors', async () => {
    const { page } = ctx
    const pointer = await waitForPointer(userData)
    expect(pointer.protocol).toBe(1)
    expect(pointer.pid).toBeGreaterThan(0)
    expect(pointer.version).toMatch(/^\d+\.\d+\.\d+/)

    // Socket and its directory are private to the user.
    expect(statSync(pointer.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(pointer.socketPath)).mode & 0o777).toBe(0o700)
    expect(statSync(join(userData, 'agent')).mode & 0o777).toBe(0o700)

    const rpc = createSocketRpc({ userData })

    // listTabs: one untitled, active doc.
    const { docs } = await rpc('listTabs', {})
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ active: true, dirty: false, path: null })
    const docId = docs[0].docId

    // addElements: a labelled rectangle, a labelled ellipse, a text, one arrow
    // routed between the shapes (no x/y) and one with explicit geometry.
    const added = await rpc('addElements', {
      docId,
      elements: [
        { type: 'rectangle', id: 'db', x: 0, y: 0, width: 160, height: 80, label: { text: 'DB' } },
        {
          type: 'ellipse',
          id: 'api',
          x: 400,
          y: 0,
          width: 160,
          height: 80,
          label: { text: 'API' }
        },
        { type: 'text', id: 'note', x: 0, y: 200, text: 'hello agent' },
        { type: 'arrow', id: 'link', start: { id: 'db' }, end: { id: 'api' } },
        {
          type: 'arrow',
          id: 'link2',
          x: 80,
          y: 80,
          points: [
            [0, 0],
            [0, 100]
          ],
          start: { id: 'db' },
          end: { id: 'note' }
        }
      ]
    })
    expect(added.ids).toEqual(expect.arrayContaining(['db', 'api', 'note', 'link', 'link2']))
    // Labels are extra bound text elements.
    expect(added.ids.length).toBe(7)
    expect(added.bounds).not.toBeNull()
    expect(added.bounds!.width).toBeGreaterThan(0)

    // The tab is now dirty, like after a user edit.
    await expect(page.locator('.sketchbook-tab--dirty')).toHaveCount(1)

    // getScene shows labels and arrow bindings.
    let scene = await rpc('getScene', { docId })
    expect(scene.docId).toBe(docId)
    expect(scene.elementCount).toBe(7)
    const byId = (id: string): ElementSummary | undefined =>
      summaries(scene).find((e) => e.id === id)
    expect(byId('db')).toMatchObject({ type: 'rectangle', label: 'DB' })
    expect(byId('api')).toMatchObject({ type: 'ellipse', label: 'API' })
    expect(byId('note')).toMatchObject({ type: 'text', text: 'hello agent' })
    expect(byId('link')).toMatchObject({ type: 'arrow', start: 'db', end: 'api' })
    expect(byId('link2')).toMatchObject({ type: 'arrow', start: 'db', end: 'note' })
    const dbLabel = summaries(scene).find((e) => e.containerId === 'db')
    expect(dbLabel?.text).toBe('DB')

    // updateElements: change the label text and move the rectangle.
    const updated = await rpc('updateElements', {
      docId,
      elements: [
        { id: dbLabel!.id, text: 'Postgres' },
        { id: 'db', x: 50, y: 60 }
      ]
    })
    expect(updated.updated.sort()).toEqual([dbLabel!.id, 'db'].sort())
    scene = await rpc('getScene', { docId })
    expect(byId('db')).toMatchObject({ x: 50, y: 60, label: 'Postgres' })
    expect(byId(dbLabel!.id)?.text).toBe('Postgres')

    // exportImage: a real PNG with the requested size cap.
    const image = await rpc('exportImage', { docId, maxSize: 600 })
    expect(image.pngBase64.startsWith('iVBORw0KGgo')).toBe(true)
    expect(image.width).toBeGreaterThan(0)
    expect(image.height).toBeGreaterThan(0)
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(600)
    expect(image.elementCount).toBe(7)

    // deleteElements: the container goes with its label; arrows get unbound.
    const deleted = await rpc('deleteElements', { docId, ids: ['db'] })
    expect(deleted.deleted.sort()).toEqual(['db', dbLabel!.id].sort())
    scene = await rpc('getScene', { docId })
    expect(scene.elementCount).toBe(5)
    expect(byId('db')).toBeUndefined()
    expect(byId(dbLabel!.id)).toBeUndefined()
    expect(byId('link')?.start).toBeUndefined()
    expect(byId('link')?.end).toBe('api')

    // newDrawing: a second, active tab with the given title.
    const fresh = await rpc('newDrawing', { title: 'From agent' })
    expect(fresh.docId).not.toBe(docId)
    expect(fresh.title).toBe('From agent')
    expect(fresh.active).toBe(true)
    await expect.poll(() => tabTitles(page)).toEqual(['Untitled', 'From agent'])
    await expect(page.locator('.sketchbook-tab--active')).toHaveText(/From agent/)
    const list = await rpc('listTabs', {})
    expect(list.docs.map((d) => [d.docId, d.active])).toEqual([
      [docId, false],
      [fresh.docId, true]
    ])

    // Immediately drawing into the new tab works (no race with the tab arriving).
    const intoFresh = await rpc('addElements', {
      docId: fresh.docId,
      elements: [{ type: 'diamond', id: 'd1', x: 0, y: 0, label: { text: 'new' } }]
    })
    expect(intoFresh.ids).toContain('d1')
    expect((await rpc('getScene', { docId: fresh.docId })).elementCount).toBe(2)
    // Omitting docId targets the active tab (the fresh one).
    expect((await rpc('getScene', {})).docId).toBe(fresh.docId)

    // Errors.
    expect(await agentErrorOf(rpc('getScene', { docId: 'nope' }))).toMatchObject({
      code: 'NO_SUCH_DOC'
    })
    expect(await agentErrorOf(rpc('getScene', { docId: 'not valid!' }))).toMatchObject({
      code: 'BAD_PARAMS'
    })
    expect(
      await agentErrorOf(
        rpc('addElements', { docId, elements: [{ type: 'rectangle', id: 'api' }] })
      )
    ).toMatchObject({ code: 'BAD_PARAMS' })
    expect(
      await agentErrorOf(rpc('updateElements', { docId, elements: [{ id: 'missing', x: 1 }] }))
    ).toMatchObject({ code: 'BAD_PARAMS' })

    await assertOffline(ctx)
  })

  test('one addElements call is one undo step', async () => {
    const { page } = ctx
    await waitForPointer(userData)
    const rpc = createSocketRpc({ userData })
    const { docs } = await rpc('listTabs', {})
    const docId = docs[0].docId

    await rpc('addElements', {
      docId,
      elements: [
        { type: 'rectangle', id: 'a', x: 0, y: 0 },
        { type: 'ellipse', id: 'b', x: 200, y: 0 },
        { type: 'text', id: 'c', x: 0, y: 200, text: 'three' }
      ],
      scrollTo: false
    })
    expect((await rpc('getScene', { docId })).elementCount).toBe(3)
    await expect(page.locator('.sketchbook-tab--dirty')).toHaveCount(1)

    // Undo from the keyboard, as the user would. Focus the canvas by clicking
    // empty space (a fresh doc has scroll 0, zoom 1, so scene (0,0) is the
    // canvas corner; selecting an element would itself be an undo step).
    await page.locator('.sketchbook-editor--active canvas.interactive').click({
      position: { x: 500, y: 450 }
    })
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await rpc('getScene', { docId })).elementCount).toBe(0)

    // Redo brings all three back in one step.
    await page.keyboard.press('Meta+Shift+z')
    await expect.poll(async () => (await rpc('getScene', { docId })).elementCount).toBe(3)
  })

  test('targeting an evicted tab mounts and activates it', async () => {
    const { page } = ctx
    await waitForPointer(userData)
    const rpc = createSocketRpc({ userData })
    const first = (await rpc('listTabs', {})).docs[0].docId

    for (let i = 1; i <= 6; i++) await rpc('newDrawing', { title: `Tab ${i}` })
    await expect(page.locator('.sketchbook-tab')).toHaveCount(7)
    // The MRU budget is 5 editors: the first tab is no longer mounted.
    await expect(page.locator('.sketchbook-editor')).toHaveCount(5)
    await expect(page.locator(`.sketchbook-editor[data-doc-id="${first}"]`)).toHaveCount(0)

    const res = await rpc('addElements', {
      docId: first,
      elements: [{ type: 'rectangle', id: 'back', x: 0, y: 0, label: { text: 'back' } }]
    })
    expect(res.ids).toContain('back')
    await expect(page.locator('.sketchbook-tab--active')).toHaveText(/Untitled/)
    await expect(page.locator(`.sketchbook-editor[data-doc-id="${first}"]`)).toHaveCount(1)
    expect((await rpc('listTabs', {})).docs.find((d) => d.docId === first)).toMatchObject({
      active: true,
      dirty: true
    })
    expect((await rpc('getScene', { docId: first })).elementCount).toBe(2)
  })

  test('the bundled MCP server talks to the app over stdio', async () => {
    await waitForPointer(userData)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SCRIPT],
      env: { ...(process.env as Record<string, string>), SKETCHBOOK_USER_DATA: userData },
      stderr: 'pipe'
    })
    const client = new Client({ name: 'e2e', version: '0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['list_drawings', 'add_elements', 'get_image', 'get_scene'])
      )

      type Content = { type: string; text?: string; data?: string; mimeType?: string }
      type Result = { content: Content[]; isError?: boolean }
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> =>
        (await client.callTool({ name, arguments: args })) as unknown as Result

      const listed = await call('list_drawings', {})
      expect(listed.isError).toBeFalsy()
      const docs = JSON.parse(listed.content[0].text ?? '{}').docs as { docId: string }[]
      expect(docs).toHaveLength(1)

      const added = await call('add_elements', {
        elements: [
          { type: 'rectangle', id: 'r', x: 0, y: 0, label: { text: 'via MCP' } },
          { type: 'ellipse', id: 'e', x: 300, y: 0 },
          { type: 'arrow', id: 'a', start: { id: 'r' }, end: { id: 'e' } }
        ]
      })
      expect(added.isError).toBeFalsy()
      expect(added.content[0].text).toContain('"r"')

      const image = await call('get_image', { maxSize: 400 })
      expect(image.isError).toBeFalsy()
      expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
      expect(image.content[0].data?.startsWith('iVBORw0KGgo')).toBe(true)
      expect(image.content[1].text).toMatch(/^\d+×\d+px, 4 elements$/)

      const bad = await call('get_scene', { docId: 'nope' })
      expect(bad.isError).toBe(true)
      expect(bad.content[0].text).toMatch(/^NO_SUCH_DOC: /)
    } finally {
      await client.close()
    }
    await expect(ctx.page.locator('.sketchbook-tab--dirty')).toHaveCount(1)
    await assertOffline(ctx)
  })
})

test('the bridge is off by default and the menu toggles it', async () => {
  const userData = makeTempDir('sketchbook-agent-off-')
  const ctx = await launchApp({ userData })
  try {
    await waitForExcalidraw(ctx.page)
    // Off: no pointer, no socket, the client reports DISABLED.
    await ctx.page.waitForTimeout(300)
    expect(readPointer(userData)).toBeNull()
    expect(existsSync(join(userData, 'agent'))).toBe(false)
    const rpc = createSocketRpc({ userData })
    expect(await agentErrorOf(rpc('listTabs', {}))).toMatchObject({ code: 'DISABLED' })

    // On via the menu: pointer, setting persisted, calls work.
    expect(await toggleAgentMenu(ctx.app)).toBe(true)
    const pointer = await waitForPointer(userData)
    await expect.poll(() => readSettings(userData)).toEqual({ allowAgentConnections: true })
    expect((await rpc('listTabs', {})).docs).toHaveLength(1)

    // Off again: pointer and socket removed, setting persisted, client reports DISABLED.
    expect(await toggleAgentMenu(ctx.app)).toBe(false)
    await waitForNoPointer(userData)
    await expect.poll(() => readSettings(userData)).toEqual({ allowAgentConnections: false })
    expect(existsSync(pointer.socketPath)).toBe(false)
    expect(await agentErrorOf(rpc('listTabs', {}))).toMatchObject({ code: 'DISABLED' })

    await assertOffline(ctx)
  } finally {
    await ctx.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('the setting survives a relaunch', async () => {
  const userData = makeTempDir('sketchbook-agent-persist-')
  try {
    const first = await launchApp({ userData })
    try {
      await waitForExcalidraw(first.page)
      expect(await toggleAgentMenu(first.app)).toBe(true)
      await waitForPointer(userData)
    } finally {
      await first.close()
    }
    // Quitting removes the pointer and socket.
    expect(readPointer(userData)).toBeNull()
    expect(existsSync(join(userData, 'agent', 'agent.sock'))).toBe(false)

    const second = await launchApp({ userData })
    try {
      await waitForExcalidraw(second.page)
      await waitForPointer(userData)
      const checked = await second.app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('allow-agent-connections')?.checked
      )
      expect(checked).toBe(true)
      expect((await createSocketRpc({ userData })('listTabs', {})).docs).toHaveLength(1)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
