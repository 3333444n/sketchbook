import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRpc } from '../../shared/agent'
import { createServer } from '../server'

type Content = { type: string; text?: string; data?: string; mimeType?: string }
type Result = { content: Content[]; isError?: boolean }

const TOOL_NAMES = [
  'list_drawings',
  'new_drawing',
  'get_scene',
  'add_elements',
  'update_elements',
  'delete_elements',
  'get_image',
  'scroll_to'
]

let rpc: ReturnType<typeof vi.fn>
let client: Client
let close: () => Promise<void>

beforeEach(async () => {
  rpc = vi.fn()
  const server = createServer({ rpc: rpc as unknown as AgentRpc, version: '0.0.0-test' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)
  close = async () => {
    await client.close()
    await server.close()
  }
})

afterEach(async () => {
  await close()
})

async function callTool(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as unknown as Result
}

describe('createServer', () => {
  it('registers exactly the 8 tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(tools).toHaveLength(8)
    const add = tools.find((t) => t.name === 'add_elements')
    expect(add?.description).toMatch(/label/)
    expect(add?.description).toMatch(/start/)
  })

  it('add_elements forwards elements with scrollTo defaulting to true and omits docId', async () => {
    rpc.mockResolvedValueOnce({
      ids: ['box', 'txt'],
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    })
    const elements = [
      { type: 'rectangle', id: 'box', x: 0, y: 0, label: { text: 'Hi' } },
      { type: 'text', id: 'txt', x: 0, y: 200, text: 'note' }
    ]
    const res = await callTool('add_elements', { elements })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('addElements', { elements, scrollTo: true })
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain('docId')
    expect(res.isError).toBeUndefined()
    expect(res.content[0].type).toBe('text')
    expect(res.content[0].text).toContain('"box"')
    expect(res.content[0].text).toContain('"txt"')
  })

  it('passes docId through when given', async () => {
    rpc.mockResolvedValueOnce({ deleted: ['a'] })
    await callTool('delete_elements', { docId: 'doc-1', ids: ['a'] })
    expect(rpc).toHaveBeenCalledWith('deleteElements', { docId: 'doc-1', ids: ['a'] })
  })

  it('get_image returns image content first, then a dimensions line', async () => {
    const png = Buffer.from('fake-png').toString('base64')
    rpc.mockResolvedValueOnce({ pngBase64: png, width: 640, height: 480, elementCount: 3 })
    const res = await callTool('get_image', { ids: ['a'] })
    expect(rpc).toHaveBeenCalledWith('exportImage', {
      ids: ['a'],
      maxSize: 1200,
      background: true,
      dark: false,
      padding: 20
    })
    expect(res.isError).toBeUndefined()
    expect(res.content[0]).toEqual({ type: 'image', data: png, mimeType: 'image/png' })
    expect(res.content[1]).toEqual({ type: 'text', text: '640×480px, 3 elements' })
  })

  it('maps an AgentError to isError with its message', async () => {
    rpc.mockRejectedValueOnce({ code: 'NOT_RUNNING', message: "Sketchbook isn't running" })
    const res = await callTool('list_drawings', {})
    expect(rpc).toHaveBeenCalledWith('listTabs', {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toBe("NOT_RUNNING: Sketchbook isn't running")
  })

  it('maps an unexpected throw to INTERNAL', async () => {
    rpc.mockRejectedValueOnce(new Error('kaboom'))
    const res = await callTool('get_scene', {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toBe('INTERNAL: kaboom')
  })

  it('rejects zod-invalid arguments before calling rpc', async () => {
    // The SDK validates `arguments` against the zod schema and answers with an
    // error result (or rejects, depending on SDK version); either way the
    // handler, and therefore the socket, is never reached.
    const invalid = async (name: string, args: Record<string, unknown>): Promise<string> => {
      try {
        const res = await callTool(name, args)
        expect(res.isError).toBe(true)
        return res.content[0].text ?? ''
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(await invalid('delete_elements', {})).toMatch(/ids/)
    expect(await invalid('add_elements', { elements: [{ type: 'hexagon' }] })).toMatch(/type/)
    expect(await invalid('get_image', { maxSize: 10 })).toMatch(/maxSize/)
    expect(rpc).not.toHaveBeenCalled()
  })
})
