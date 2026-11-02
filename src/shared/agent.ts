// Agent bridge contract shared by main (socket server), the renderer (per-doc
// ops) and the bundled MCP server (src/mcp). Every layer codes against it.
//
// THIS FILE MUST STAY TYPE-ONLY (no runtime exports, no imports).
//
// `out/main/mcp.js` is copied out of the build as a single file
// (electron-builder `extraResources` → Contents/Resources/mcp/index.js) and run
// with ELECTRON_RUN_AS_NODE outside the asar. If this module carried runtime
// code that both src/main and src/mcp import, rolldown would split it into
// `out/main/chunks/` and mcp.js would `require("./chunks/…")`, which does not
// exist next to the copied file. The `mcpSelfContained` plugin in
// electron.vite.config.ts fails the build if that ever happens. Validation
// therefore lives on each side: hand-written guards in main, zod in the MCP
// server. Keep the limits below in sync on both sides.
//
// Limits (literals on each side; not exported from here on purpose):
//   - socket frame (one NDJSON line): ≤ 16 MiB, else TOO_LARGE and the connection closes
//   - addElements / updateElements: ≤ 2000 elements per call
//   - deleteElements: ≤ 5000 ids per call
//   - exportImage.maxSize: 256–4096 (default 1200)
//   - newDrawing.title: ≤ 200 chars
//   - docId: /^[A-Za-z0-9_-]{1,128}$/
//   - addElements type whitelist: rectangle | ellipse | diamond | text | arrow | line | frame | image

export type AgentErrorCode =
  | 'NOT_RUNNING'
  | 'DISABLED'
  | 'NO_SUCH_DOC'
  | 'NOT_READY'
  | 'BAD_PARAMS'
  | 'UNKNOWN_METHOD'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'INTERNAL'

export type AgentError = { code: AgentErrorCode; message: string }

export type AgentDocInfo = {
  docId: string
  title: string
  path: string | null
  dirty: boolean
  active: boolean
  windowId: number
}

export type Bounds = { x: number; y: number; width: number; height: number }

/** An Excalidraw element skeleton or raw element as supplied by an agent. */
export type ElementJSON = { type: string; id?: string } & Record<string, unknown>

export type ElementSummary = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  text?: string
  label?: string
  containerId?: string
  start?: string
  end?: string
  points?: [number, number][]
  strokeColor: string
  backgroundColor: string
  strokeWidth?: number
  strokeStyle?: string
  fillStyle?: string
  roughness?: number
  opacity?: number
  fontSize?: number
  fontFamily?: number
  textAlign?: string
  groupIds?: string[]
  frameId?: string
  link?: string
  locked?: true
  fileId?: string
  name?: string
}

export type SceneSummary = {
  docId: string
  title: string
  elementCount: number
  bounds: Bounds | null
  viewBackgroundColor: string
  selectedIds: string[]
  /** `ElementSummary[]` by default; raw `ElementJSON[]` when `full` was requested. */
  elements: ElementSummary[] | ElementJSON[]
}

export type ElementPatch = { id: string } & Record<string, unknown>

/** Optional target; defaults to the active doc of the focused (else last-focused) window. */
type DocTarget = { docId?: string }

export type AgentMethods = {
  listTabs: { params: Record<string, never>; result: { docs: AgentDocInfo[] } }
  newDrawing: { params: { title?: string }; result: AgentDocInfo }
  getScene: { params: DocTarget & { full?: boolean }; result: SceneSummary }
  addElements: {
    params: DocTarget & { elements: ElementJSON[]; scrollTo?: boolean }
    result: { ids: string[]; bounds: Bounds | null }
  }
  updateElements: {
    params: DocTarget & { elements: ElementPatch[] }
    result: { updated: string[]; bounds: Bounds | null }
  }
  deleteElements: { params: DocTarget & { ids: string[] }; result: { deleted: string[] } }
  exportImage: {
    params: DocTarget & {
      ids?: string[]
      maxSize?: number
      background?: boolean
      dark?: boolean
      padding?: number
    }
    result: { pngBase64: string; width: number; height: number; elementCount: number }
  }
  scrollTo: { params: DocTarget & { ids?: string[] }; result: { ok: true } }
}

export type AgentMethod = keyof AgentMethods
/** Methods that act on one document (forwarded from main to the renderer). */
export type AgentDocOp = Exclude<AgentMethod, 'listTabs' | 'newDrawing'>
export type AgentParams<M extends AgentMethod> = AgentMethods[M]['params']
export type AgentResult<M extends AgentMethod> = AgentMethods[M]['result']

/** One NDJSON line from client to main over the Unix socket. */
export type AgentRequestFrame = { id: number | string; method: string; params?: unknown }
/** One NDJSON line from main to client. `id` is null when the request could not be parsed. */
export type AgentResponseFrame =
  | { id: number | string | null; result: unknown }
  | { id: number | string | null; error: AgentError }

/** Contents of `userData/agent/agent.json`, written while the bridge is running. */
export type AgentPointer = { protocol: 1; socketPath: string; version: string; pid: number }

export type AgentRpc = <M extends AgentMethod>(
  method: M,
  params: AgentParams<M>
) => Promise<AgentResult<M>>
