// The MCP tool surface: eight tools over the `AgentRpc` socket client. Pure
// (no electron, no src/main runtime); the transport is attached by index.ts
// (stdio) or by tests (in-memory).
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AgentMethod, AgentParams, AgentResult, AgentRpc } from '../shared/agent'
import { isAgentError } from './client'

export type ServerOptions = { rpc: AgentRpc; version: string }

type TextContent = { type: 'text'; text: string }
type ImageContent = { type: 'image'; data: string; mimeType: 'image/png' }
type ToolResult = { content: (TextContent | ImageContent)[]; isError?: true }

// Limits mirrored from src/shared/agent.ts (type-only; literals live on each side).
const MAX_ELEMENTS = 2000
const MAX_DELETE_IDS = 5000
const MAX_TITLE = 200
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/

const docId = z
  .string()
  .regex(DOC_ID)
  .optional()
  .describe(
    'Target drawing, from list_drawings. Omit to use the tab the user is looking at (the active tab of the focused window).'
  )

const idList = (what: string): z.ZodArray<z.ZodString> =>
  z.array(z.string().min(1)).describe(`Element ids ${what}.`)

const elementSkeleton = z
  .looseObject({
    type: z
      .enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'frame', 'image'])
      .describe('Element type.'),
    id: z
      .string()
      .min(1)
      .optional()
      .describe('Your own short id (e.g. "db", "api"); needed to bind arrows or edit later.')
  })
  .describe('An Excalidraw element skeleton; any other Excalidraw element property is accepted.')

const elementPatch = z
  .looseObject({
    id: z.string().min(1).describe('Id of the element to change (from get_scene).')
  })
  .describe('The element id plus only the properties to change.')

const ADD_ELEMENTS_CHEAT_SHEET = `Add new elements to a drawing. Each call is one undo step for the user and makes the tab dirty (autosaved).

Element cheat sheet (Excalidraw skeleton JSON):
- type: rectangle | ellipse | diamond | text | arrow | line | frame | image
- Position with x, y (y grows DOWNWARD), size with width, height (default 100×100). Elements need not touch; leave gaps.
- Shapes and arrows take label: {text: "..."} which creates centred, auto-sized bound text (preferred over a separate text element). label may also carry fontSize, strokeColor, textAlign.
- A standalone text element uses text: "..." (newlines allowed); fontSize default 20; fontFamily 1 (hand-drawn) | 2 (normal) | 3 (code).
- Arrows bind to shapes with start: {id: "a"} and end: {id: "b"} and are then routed between the two shapes automatically (x/y/points optional). Add endArrowhead: null for a plain connector or startArrowhead: "arrow" for double-headed. Unbound arrows/lines use x, y plus points: [[0,0],[dx,dy],...].
- frame: {type: "frame", name: "Title", children: ["id1","id2"]} groups existing or just-added elements.
- Colours are hex strings: strokeColor (default "#1e1e1e"), backgroundColor ("transparent" or e.g. "#a5d8ff"); fillStyle: hachure | solid | cross-hatch; strokeWidth 1|2|4; strokeStyle: solid | dashed | dotted; roughness 0 (clean) – 2 (sketchy); opacity 0–100; roundness: {type: 3} for rounded corners.
- Supply your own short ids so you can reference elements later (bindings, update_elements, delete_elements, get_image ids). Ids must be unique in the drawing.
- Up to ${MAX_ELEMENTS} elements per call.

Workflow: call get_scene first when editing an existing drawing (to see what is there and avoid overlaps), then add_elements, then get_image to check the layout visually.`

/** Build a fresh `McpServer` (one per connection; `serveStdio` calls this per client). */
export function createServer({ rpc, version }: ServerOptions): McpServer {
  const server = new McpServer({ name: 'sketchbook', version })

  const call = async <M extends AgentMethod>(
    method: M,
    params: AgentParams<M>
  ): Promise<AgentResult<M>> => rpc(method, stripUndefined(params))

  server.registerTool(
    'list_drawings',
    {
      title: 'List drawings',
      description:
        'List the drawings (tabs) open in Sketchbook with their docId, title, file path, dirty flag and which one is active. Call this to pick a docId, or just omit docId in other tools to target the tab the user is looking at.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    () => run(() => call('listTabs', {}))
  )

  server.registerTool(
    'new_drawing',
    {
      title: 'New drawing',
      description:
        'Open a new, empty drawing in a new tab of the current Sketchbook window and return its docId. The new tab becomes active. Give it a short title (it becomes the file name when the user saves).',
      inputSchema: z.object({
        title: z.string().max(MAX_TITLE).optional().describe('Tab title, e.g. "Auth flow".')
      })
    },
    ({ title }) => run(() => call('newDrawing', { title }))
  )

  server.registerTool(
    'get_scene',
    {
      title: 'Get scene',
      description:
        'Read a drawing: its title, element count, overall bounds, selected element ids and a compact summary of every element (id, type, x, y, width, height, text/label, arrow start/end bindings, colours). Call this before editing an existing drawing so you can place new elements without overlaps and reference existing ids. Set full=true only when you need every raw Excalidraw property.',
      inputSchema: z.object({
        docId,
        full: z
          .boolean()
          .optional()
          .describe('Return raw Excalidraw elements instead of summaries (verbose).')
      }),
      annotations: { readOnlyHint: true }
    },
    ({ docId, full }) => run(() => call('getScene', { docId, full }))
  )

  server.registerTool(
    'add_elements',
    {
      title: 'Add elements',
      description: ADD_ELEMENTS_CHEAT_SHEET,
      inputSchema: z.object({
        docId,
        elements: z
          .array(elementSkeleton)
          .min(1)
          .max(MAX_ELEMENTS)
          .describe('Elements to add, in drawing order (later ones render on top).'),
        scrollTo: z
          .boolean()
          .default(true)
          .describe('Scroll and zoom the canvas so the new elements are visible (default true).')
      })
    },
    ({ docId, elements, scrollTo }) => run(() => call('addElements', { docId, elements, scrollTo }))
  )

  server.registerTool(
    'update_elements',
    {
      title: 'Update elements',
      description:
        "Change properties of existing elements by id (from get_scene): move (x, y), resize (width, height), restyle (strokeColor, backgroundColor, fillStyle, strokeWidth, roughness, opacity), or change text (text on a text element; its box is re-measured). A bound label follows its container when the container moves or resizes. Pass only the properties to change. All-or-nothing: if any id is unknown nothing changes. One undo step. Use delete_elements plus add_elements to change an element's type or an arrow's bindings.",
      inputSchema: z.object({
        docId,
        elements: z
          .array(elementPatch)
          .min(1)
          .max(MAX_ELEMENTS)
          .describe('Patches, each {id, ...propertiesToChange}.')
      })
    },
    ({ docId, elements }) => run(() => call('updateElements', { docId, elements }))
  )

  server.registerTool(
    'delete_elements',
    {
      title: 'Delete elements',
      description:
        'Delete elements by id. Bound labels of deleted shapes are removed too and arrows bound to them are unbound. Unknown ids are ignored; the result lists what was deleted. One undo step.',
      inputSchema: z.object({
        docId,
        ids: idList('to delete').min(1).max(MAX_DELETE_IDS)
      }),
      annotations: { destructiveHint: true }
    },
    ({ docId, ids }) => run(() => call('deleteElements', { docId, ids }))
  )

  server.registerTool(
    'get_image',
    {
      title: 'Get image',
      description:
        'Render the drawing (or only the given element ids) to a PNG and return it so you can see the result. Use it after add_elements/update_elements to check layout, overlaps and readability. maxSize caps the longer side in pixels.',
      inputSchema: z.object({
        docId,
        ids: idList('to render; omit for the whole drawing').optional(),
        maxSize: z
          .number()
          .int()
          .min(256)
          .max(4096)
          .default(1200)
          .describe('Maximum width or height in pixels (256–4096, default 1200).'),
        background: z
          .boolean()
          .default(true)
          .describe('Paint the canvas background colour (default true; false = transparent).'),
        dark: z.boolean().default(false).describe('Render with the dark theme (default false).'),
        padding: z
          .number()
          .min(0)
          .max(500)
          .default(20)
          .describe('Padding around the content in pixels (default 20).')
      }),
      annotations: { readOnlyHint: true }
    },
    ({ docId, ids, maxSize, background, dark, padding }) =>
      run(
        async () => {
          const r = await call('exportImage', { docId, ids, maxSize, background, dark, padding })
          return {
            content: [
              { type: 'image', data: r.pngBase64, mimeType: 'image/png' },
              { type: 'text', text: `${r.width}×${r.height}px, ${r.elementCount} elements` }
            ]
          }
        },
        { raw: true }
      )
  )

  server.registerTool(
    'scroll_to',
    {
      title: 'Scroll to',
      description:
        "Scroll and zoom the user's canvas so the given elements (or the whole drawing when ids is omitted) are in view. Does not change the drawing.",
      inputSchema: z.object({
        docId,
        ids: idList('to bring into view; omit to fit the whole drawing').optional()
      })
    },
    ({ docId, ids }) => run(() => call('scrollTo', { docId, ids }))
  )

  return server
}

/** Params with `undefined` keys dropped, so an omitted `docId` is not sent. */
function stripUndefined<T extends object>(params: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v
  return out as T
}

/**
 * Run a tool body and map the outcome to an MCP result: JSON text on success,
 * `"CODE: message"` with `isError` for an `AgentError`, `INTERNAL` otherwise.
 */
async function run(body: () => Promise<unknown>, opts?: { raw?: boolean }): Promise<ToolResult> {
  try {
    const result = await body()
    if (opts?.raw) return result as ToolResult
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const { code, message } = isAgentError(err)
      ? err
      : { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
    return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true }
  }
}
