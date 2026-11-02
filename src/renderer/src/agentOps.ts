// The per-document agent operations (contract: src/shared/agent.ts), run by
// App against one tab's Excalidraw imperative API.
//
// Every edit goes through a single `updateScene({captureUpdate: IMMEDIATELY})`
// so it is one undo step and fires the editor's onChange, which drives the
// tab's dirty state and autosave exactly like a user edit. `updateScene`
// replaces the whole element list, so every call passes the full scene
// (including tombstones) with the changed elements swapped in by id.
//
// Validation failures throw `AgentError` objects ({code, message}); anything
// else that throws is reported by App as INTERNAL.

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  MIME_TYPES,
  newElementWith,
  restoreElements
} from '@excalidraw/excalidraw'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement
} from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type {
  AgentDocOp,
  AgentParams,
  AgentResult,
  ElementJSON,
  ElementPatch
} from '../../shared/agent'
import {
  agentError,
  applyPatch,
  arrowBinding,
  commonBounds,
  MAX_ELEMENTS_PER_CALL,
  planDelete,
  prepareSkeletons,
  ROUTE_GAP,
  routeArrow,
  summarizeElements,
  validateIds,
  validateSkeletons
} from './agentScene'

export type AgentOpContext = {
  api: ExcalidrawImperativeAPI
  docId: string
  /** The tab's display title. */
  title: string
}

type OpImpl<K extends AgentDocOp> = (
  ctx: AgentOpContext,
  params: unknown
) => Promise<AgentResult<K>>

const EXPORT_SIZE = { min: 256, max: 4096, default: 1200 }
const EXPORT_PADDING = { max: 1000, default: 20 }

// A function declaration (not a const) so TS narrows after `cond || bad(...)`.
function bad(message: string): never {
  throw agentError('BAD_PARAMS', message)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function params<K extends AgentDocOp>(raw: unknown): AgentParams<K> {
  if (raw === undefined || raw === null) return {} as AgentParams<K>
  if (!isRecord(raw)) bad('params must be an object')
  return raw as AgentParams<K>
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
/** A fresh element id in Excalidraw's style. */
function makeId(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const b of bytes) id += ID_ALPHABET[b & 63]
  return id
}

type Scene = {
  all: readonly ExcalidrawElement[]
  live: Map<string, NonDeletedExcalidrawElement>
}

function readScene(api: ExcalidrawImperativeAPI): Scene {
  const all = api.getSceneElementsIncludingDeleted()
  const live = new Map<string, NonDeletedExcalidrawElement>()
  for (const el of all) if (!el.isDeleted) live.set(el.id, el as NonDeletedExcalidrawElement)
  return { all, live }
}

/** Commit one undoable scene update: `replaced` swaps elements by id, `added` goes on top. */
function commit(
  api: ExcalidrawImperativeAPI,
  scene: Scene,
  replaced: ReadonlyMap<string, ExcalidrawElement>,
  added: readonly ExcalidrawElement[] = [],
  appState?: { selectedElementIds: Readonly<Record<string, true>> }
): void {
  const elements = scene.all.map((el) => replaced.get(el.id) ?? el)
  api.updateScene({
    elements: [...elements, ...added],
    ...(appState ? { appState } : {}),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY
  })
}

/** Non-deleted elements for `ids` (BAD_PARAMS if any is unknown). */
function pick(scene: Scene, ids: readonly string[]): NonDeletedExcalidrawElement[] {
  return ids.map((id) => scene.live.get(id) ?? bad(`no element with id "${id}"`))
}

/** `elements` plus the text labels bound to them (so exports and scrolls show whole shapes). */
function withLabels(
  scene: Scene,
  elements: readonly NonDeletedExcalidrawElement[]
): NonDeletedExcalidrawElement[] {
  const out = new Map(elements.map((el) => [el.id, el]))
  for (const el of elements) {
    for (const bound of el.boundElements ?? []) {
      const label = bound.type === 'text' ? scene.live.get(bound.id) : undefined
      if (label) out.set(label.id, label)
    }
  }
  return [...out.values()]
}

// ---- getScene -------------------------------------------------------------------

const getScene: OpImpl<'getScene'> = async ({ api, docId, title }, raw) => {
  const { full } = params<'getScene'>(raw)
  const scene = readScene(api)
  const live = [...scene.live.values()]
  const selected = api.getAppState().selectedElementIds
  return {
    docId,
    title,
    elementCount: live.length,
    bounds: commonBounds(live),
    viewBackgroundColor: api.getAppState().viewBackgroundColor,
    selectedIds: Object.keys(selected).filter((id) => selected[id] && scene.live.has(id)),
    elements: full ? (live as unknown as ElementJSON[]) : summarizeElements(live)
  }
}

// ---- addElements ----------------------------------------------------------------

/** Build and normalise a batch of skeletons (BAD_PARAMS when the converter rejects them). */
function build(skeletons: readonly ElementJSON[]): ExcalidrawElement[] {
  if (!skeletons.length) return []
  let created: ExcalidrawElement[]
  try {
    created = convertToExcalidrawElements(skeletons as unknown as ExcalidrawElementSkeleton[], {
      regenerateIds: false
    })
  } catch (err) {
    return bad(`could not build elements: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Normalises values and repairs bindings within the batch. Bindings by id
  // were taken out of the skeletons (prepareSkeletons) and are added after,
  // since this would drop any whose target is not in `created`.
  return restoreElements(created, null, { repairBindings: true })
}

const addElements: OpImpl<'addElements'> = async ({ api }, raw) => {
  const p = params<'addElements'>(raw)
  const scene = readScene(api)
  const validated = validateSkeletons(p.elements, new Set(scene.all.map((el) => el.id)))
  const files = api.getFiles()
  for (const el of validated) {
    if (el.type === 'image' && !files[el.fileId as string])
      bad(`image: unknown fileId "${String(el.fileId)}"`)
  }
  const prepared = prepareSkeletons(validated, scene.live, makeId)

  // `pool` holds the latest version of every element involved: live scene
  // elements plus the new ones. Edits below replace entries in it.
  const pool = new Map<string, ExcalidrawElement>(scene.live)
  const createdIds: string[] = []
  const add = (els: readonly ExcalidrawElement[]): void => {
    for (const el of els) {
      if (pool.has(el.id)) bad(`duplicate id "${el.id}" after conversion`)
      pool.set(el.id, el)
      createdIds.push(el.id)
    }
  }
  const get = (id: string): ExcalidrawElement => pool.get(id) ?? bad(`no element with id "${id}"`)

  // Pass 1: everything the converter can place on its own.
  add(build(prepared.skeletons))

  // Pass 2: arrows bound at both ends without a position are routed between
  // their (now built) targets, then converted so labels work for them too.
  const routedIds = new Set(prepared.routed.map((el) => el.id as string))
  const ends = new Map<string, { start?: string; end?: string }>()
  for (const b of prepared.bindings)
    ends.set(b.arrowId, { ...ends.get(b.arrowId), [b.side]: b.targetId })
  add(
    build(
      prepared.routed.map((skel) => {
        const { start, end } = ends.get(skel.id as string)!
        if (routedIds.has(start!) || routedIds.has(end!))
          bad(`arrow ${skel.id}: cannot bind to another arrow`)
        return { ...skel, ...routeArrow(get(start!), get(end!)) }
      })
    )
  )

  // Bindings by id: the arrow records the binding, the target lists the arrow.
  for (const { arrowId, side, targetId } of prepared.bindings) {
    const arrow = get(arrowId) as ExcalidrawArrowElement
    const target = get(targetId)
    const gap = routedIds.has(arrowId) ? ROUTE_GAP : undefined
    const binding = arrowBinding(arrow, side, target, gap)
    pool.set(
      arrowId,
      newElementWith(arrow, { [side === 'start' ? 'startBinding' : 'endBinding']: binding })
    )
    if (!target.boundElements?.some((b) => b.id === arrowId)) {
      pool.set(
        targetId,
        newElementWith(target, {
          boundElements: [...(target.boundElements ?? []), { id: arrowId, type: 'arrow' }]
        })
      )
    }
  }
  // Frame membership the converter could not set (pre-existing elements, routed arrows and their labels).
  for (const { id, frameId } of prepared.frameMembers) {
    const el = get(id)
    pool.set(id, newElementWith(el, { frameId }))
    for (const bound of el.boundElements ?? []) {
      const label = bound.type === 'text' ? pool.get(bound.id) : undefined
      if (label) pool.set(label.id, newElementWith(label, { frameId }))
    }
  }
  // Frames keep the geometry the agent gave them (the converter prefers computed boxes).
  for (const [id, box] of prepared.frameBoxes) pool.set(id, newElementWith(get(id), box))

  const created = createdIds.map(get)
  const replaced = new Map<string, ExcalidrawElement>()
  for (const [id, el] of pool)
    if (scene.live.has(id) && scene.live.get(id) !== el) replaced.set(id, el)

  // Fresh elements get their fractional index from the scene (appended on top).
  for (const el of created) (el as { index: string | null }).index = null
  commit(api, scene, replaced, created)
  if (p.scrollTo !== false) api.scrollToContent(created, { fitToContent: true, animate: true })
  return { ids: createdIds, bounds: commonBounds(created) }
}

// ---- updateElements -------------------------------------------------------------

const updateElements: OpImpl<'updateElements'> = async ({ api }, raw) => {
  const p = params<'updateElements'>(raw)
  if (!Array.isArray(p.elements) || p.elements.length === 0)
    bad('elements must be a non-empty array')
  if (p.elements.length > MAX_ELEMENTS_PER_CALL) {
    bad(`elements has ${p.elements.length} entries (max ${MAX_ELEMENTS_PER_CALL})`)
  }
  const scene = readScene(api)
  const replaced = new Map<string, ExcalidrawElement>()
  const remeasure: string[] = []
  for (const patch of p.elements as unknown[]) {
    if (!isRecord(patch) || typeof patch.id !== 'string') bad('each element patch needs an id')
    const el = scene.live.get(patch.id) ?? bad(`no element with id "${patch.id}"`)
    if (replaced.has(el.id)) bad(`element ${el.id} appears twice`)
    const { changes, textChanged } = applyPatch(el, patch as ElementPatch)
    if (
      typeof changes.frameId === 'string' &&
      !scene.live.get(changes.frameId)?.type.endsWith('frame')
    ) {
      bad(`element ${el.id}: frameId "${changes.frameId}" is not a frame`)
    }
    if (typeof changes.fileId === 'string' && !api.getFiles()[changes.fileId]) {
      bad(`element ${el.id}: unknown fileId "${changes.fileId}"`)
    }
    replaced.set(el.id, newElementWith(el, changes as Partial<ExcalidrawElement>))
    if (textChanged) remeasure.push(el.id)
  }
  // Re-measure changed texts (wrapping inside their container) on the smallest
  // subset that keeps the container reference alive, and take only the
  // measured fields back so nothing else is touched.
  for (const id of remeasure) {
    const text = replaced.get(id) as ExcalidrawTextElement
    const container = text.containerId
      ? (replaced.get(text.containerId) ?? scene.live.get(text.containerId))
      : null
    const restored = restoreElements(container ? [container, text] : [text], null, {
      refreshDimensions: true,
      repairBindings: true
    })
    const measured = restored.find((el) => el.id === id) as ExcalidrawTextElement | undefined
    if (!measured) continue
    const { x, y, width, height } = measured
    replaced.set(id, newElementWith(text, { x, y, width, height, text: measured.text }))
  }
  commit(api, scene, replaced)
  return { updated: [...replaced.keys()], bounds: commonBounds([...replaced.values()]) }
}

// ---- deleteElements -------------------------------------------------------------

const deleteElements: OpImpl<'deleteElements'> = async ({ api }, raw) => {
  const p = params<'deleteElements'>(raw)
  const ids = validateIds(p.ids)
  const scene = readScene(api)
  // Unknown or already-deleted ids are ignored; the result says what went.
  const plan = planDelete(ids, scene.all)
  const replaced = new Map<string, ExcalidrawElement>()
  for (const id of plan.deleted)
    replaced.set(id, newElementWith(scene.live.get(id)!, { isDeleted: true }))
  for (const [id, patch] of plan.patches)
    replaced.set(id, newElementWith(scene.live.get(id)!, patch))
  const selected = api.getAppState().selectedElementIds
  const gone = new Set(plan.deleted)
  const kept: Record<string, true> = {}
  for (const id of Object.keys(selected)) if (selected[id] && !gone.has(id)) kept[id] = true
  if (plan.deleted.length) commit(api, scene, replaced, [], { selectedElementIds: kept })
  return { deleted: plan.deleted }
}

// ---- exportImage ----------------------------------------------------------------

function clampNumber(v: unknown, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`${name} must be a number`)
  return Math.min(max, Math.max(min, v))
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'))
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

const exportImage: OpImpl<'exportImage'> = async ({ api }, raw) => {
  const p = params<'exportImage'>(raw)
  const scene = readScene(api)
  const elements =
    p.ids === undefined
      ? [...scene.live.values()]
      : withLabels(scene, pick(scene, validateIds(p.ids)))
  if (!elements.length) bad('nothing to export: the drawing is empty')
  const maxWidthOrHeight = clampNumber(
    p.maxSize,
    'maxSize',
    EXPORT_SIZE.min,
    EXPORT_SIZE.max,
    EXPORT_SIZE.default
  )
  const exportPadding = clampNumber(
    p.padding,
    'padding',
    0,
    EXPORT_PADDING.max,
    EXPORT_PADDING.default
  )
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    mimeType: MIME_TYPES.png,
    exportPadding,
    maxWidthOrHeight,
    appState: {
      ...api.getAppState(),
      exportBackground: p.background !== false,
      exportWithDarkMode: p.dark === true,
      exportEmbedScene: false,
      exportScale: 1
    }
  })
  const [pngBase64, bitmap] = await Promise.all([blobToBase64(blob), createImageBitmap(blob)])
  const { width, height } = bitmap
  bitmap.close()
  return { pngBase64, width, height, elementCount: elements.length }
}

// ---- scrollTo -------------------------------------------------------------------

const scrollTo: OpImpl<'scrollTo'> = async ({ api }, raw) => {
  const p = params<'scrollTo'>(raw)
  const scene = readScene(api)
  const target =
    p.ids === undefined
      ? [...scene.live.values()]
      : withLabels(scene, pick(scene, validateIds(p.ids)))
  api.scrollToContent(target, { fitToContent: true, animate: true })
  return { ok: true }
}

export const agentOps: { [K in AgentDocOp]: OpImpl<K> } = {
  getScene,
  addElements,
  updateElements,
  deleteElements,
  exportImage,
  scrollTo
}

export const isAgentDocOp = (op: unknown): op is AgentDocOp =>
  typeof op === 'string' && Object.prototype.hasOwnProperty.call(agentOps, op)

/**
 * Resolve with the editor's API once it exists and has finished loading its
 * scene, polling every 50 ms; null after `timeoutMs`.
 */
export function waitForEditor(
  getApi: () => ExcalidrawImperativeAPI | null,
  timeoutMs: number
): Promise<ExcalidrawImperativeAPI | null> {
  const ready = (): ExcalidrawImperativeAPI | null => {
    const api = getApi()
    return api && !api.getAppState().isLoading ? api : null
  }
  const first = ready()
  if (first) return Promise.resolve(first)
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      const api = ready()
      if (api) return resolve(api)
      if (Date.now() >= deadline) return resolve(null)
      setTimeout(tick, 50)
    }
    setTimeout(tick, 50)
  })
}
