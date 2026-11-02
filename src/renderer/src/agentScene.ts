// Pure helpers behind the agent operations (see agentOps.ts): summarising a
// scene, validating agent input and planning edits as data. Everything that
// needs the Excalidraw runtime (element constructors, measuring text, the
// imperative API) lives in agentOps.ts; this module only imports types so
// Vitest can run it in a plain node environment.
//
// Limits are literals kept in sync with src/shared/agent.ts and the main /
// MCP sides.

import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement
} from '@excalidraw/excalidraw/element/types'
import type {
  AgentError,
  AgentErrorCode,
  Bounds,
  ElementJSON,
  ElementPatch,
  ElementSummary
} from '../../shared/agent'

export const MAX_ELEMENTS_PER_CALL = 2000
export const MAX_IDS_PER_CALL = 5000

/** Element types an agent may create (`addElements`). */
export const ADDABLE_TYPES: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'frame',
  'image'
])

/** Types an arrow's `start` / `end` may reference when the target already exists. */
const BINDABLE_TYPES: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'image',
  'frame'
])

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// ---- errors ------------------------------------------------------------------

export function agentError(code: AgentErrorCode, message: string): AgentError {
  return { code, message }
}

export function isAgentError(err: unknown): err is AgentError {
  if (typeof err !== 'object' || err === null) return false
  const e = err as Record<string, unknown>
  return typeof e.code === 'string' && typeof e.message === 'string' && !(err instanceof Error)
}

const bad = (message: string): AgentError => agentError('BAD_PARAMS', message)

// ---- small predicates --------------------------------------------------------

type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFinite_ = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isPoint = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isFinite_(v[0]) && isFinite_(v[1])
const isPoints = (v: unknown): v is [number, number][] => Array.isArray(v) && v.every(isPoint)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

const isText = (el: ExcalidrawElement): el is ExcalidrawTextElement => el.type === 'text'
const isLinear = (el: ExcalidrawElement): el is ExcalidrawLinearElement =>
  el.type === 'arrow' || el.type === 'line'

/** `ids` as a validated list: non-empty, unique, well-formed. */
export function validateIds(ids: unknown, what = 'ids'): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw bad(`${what} must be a non-empty array`)
  if (ids.length > MAX_IDS_PER_CALL)
    throw bad(`${what} has ${ids.length} entries (max ${MAX_IDS_PER_CALL})`)
  const seen = new Set<string>()
  for (const id of ids) {
    if (!isString(id) || !ID_PATTERN.test(id))
      throw bad(`${what} contains an invalid id: ${String(id)}`)
    seen.add(id)
  }
  return [...seen]
}

// ---- bounds -------------------------------------------------------------------

/** Axis-aligned bounds of `elements` (rotation and linear points taken into account). */
export function commonBounds(elements: readonly ExcalidrawElement[]): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    if (el.isDeleted) continue
    for (const [x, y] of corners(el)) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** The points that bound an element, in scene coordinates. */
function corners(el: ExcalidrawElement): [number, number][] {
  const pts: [number, number][] = isLinear(el)
    ? el.points.map(([px, py]) => [el.x + px, el.y + py])
    : [
        [el.x, el.y],
        [el.x + el.width, el.y],
        [el.x, el.y + el.height],
        [el.x + el.width, el.y + el.height]
      ]
  if (!el.angle) return pts
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const cos = Math.cos(el.angle)
  const sin = Math.sin(el.angle)
  return pts.map(([x, y]) => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos
  ])
}

// ---- summaries ----------------------------------------------------------------

/** Compact, LLM-friendly view of the non-deleted elements (undefined keys omitted). */
export function summarizeElements(elements: readonly ExcalidrawElement[]): ElementSummary[] {
  const byId = new Map<string, ExcalidrawElement>()
  for (const el of elements) if (!el.isDeleted) byId.set(el.id, el)
  const out: ElementSummary[] = []
  for (const el of byId.values()) {
    const s: ElementSummary = {
      id: el.id,
      type: el.type,
      x: round(el.x),
      y: round(el.y),
      width: round(el.width),
      height: round(el.height),
      strokeColor: el.strokeColor,
      backgroundColor: el.backgroundColor,
      strokeWidth: el.strokeWidth,
      strokeStyle: el.strokeStyle,
      fillStyle: el.fillStyle,
      roughness: el.roughness,
      opacity: el.opacity
    }
    if (el.angle) s.angle = el.angle
    if (isText(el)) {
      s.text = el.originalText || el.text
      s.fontSize = el.fontSize
      s.fontFamily = el.fontFamily
      s.textAlign = el.textAlign
      if (el.containerId) s.containerId = el.containerId
    } else if (el.boundElements) {
      const label = el.boundElements.find((b) => b.type === 'text')
      const text = label && byId.get(label.id)
      if (text && isText(text)) s.label = text.originalText || text.text
    }
    if (isLinear(el)) {
      s.points = el.points.map(([x, y]) => [round(x), round(y)])
      if (el.startBinding) s.start = el.startBinding.elementId
      if (el.endBinding) s.end = el.endBinding.elementId
    }
    if (el.groupIds.length) s.groupIds = [...el.groupIds]
    if (el.frameId) s.frameId = el.frameId
    if (el.link) s.link = el.link
    if (el.locked) s.locked = true
    if (el.type === 'image' && el.fileId) s.fileId = el.fileId
    if (el.type === 'frame' && el.name) s.name = el.name
    out.push(s)
  }
  return out
}

const round = (n: number): number => Math.round(n * 100) / 100

// ---- delete -------------------------------------------------------------------

export type DeletePlan = {
  /** Ids to tombstone: the requested ones that exist plus their bound text labels. */
  deleted: string[]
  /** Requested ids that are unknown or already deleted. */
  missing: string[]
  /** Surviving elements whose references to deleted ones must be cut. */
  patches: Map<string, Partial<ExcalidrawElement>>
}

/**
 * Work out what deleting `ids` entails. Labels bound to a deleted container go
 * with it; everything else that pointed at a deleted element is patched:
 * `boundElements` entries are dropped, arrow bindings nulled and frame
 * membership cleared.
 */
export function planDelete(
  ids: readonly string[],
  elements: readonly ExcalidrawElement[]
): DeletePlan {
  const live = new Map<string, ExcalidrawElement>()
  for (const el of elements) if (!el.isDeleted) live.set(el.id, el)

  const deleted = new Set<string>()
  const missing: string[] = []
  for (const id of ids) {
    if (live.has(id)) deleted.add(id)
    else missing.push(id)
  }
  // Bound labels follow their container.
  for (const el of live.values()) {
    if (isText(el) && el.containerId && deleted.has(el.containerId)) deleted.add(el.id)
  }

  const patches = new Map<string, Partial<ExcalidrawElement>>()
  for (const el of live.values()) {
    if (deleted.has(el.id)) continue
    const patch: Record<string, unknown> = {}
    if (el.boundElements?.some((b) => deleted.has(b.id))) {
      const kept = el.boundElements.filter((b) => !deleted.has(b.id))
      patch.boundElements = kept.length ? kept : null
    }
    if (isLinear(el)) {
      if (el.startBinding && deleted.has(el.startBinding.elementId)) patch.startBinding = null
      if (el.endBinding && deleted.has(el.endBinding.elementId)) patch.endBinding = null
    }
    if (el.frameId && deleted.has(el.frameId)) patch.frameId = null
    if (Object.keys(patch).length) patches.set(el.id, patch as Partial<ExcalidrawElement>)
  }
  return { deleted: [...deleted], missing, patches }
}

// ---- update -------------------------------------------------------------------

/** Keys an agent must not set; they are dropped from patches silently. */
const FORBIDDEN_PATCH_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'version',
  'versionNonce',
  'updated',
  'seed',
  'index',
  'isDeleted',
  'boundElements',
  'containerId',
  'startBinding',
  'endBinding',
  'originalText'
])

type Kind = 'number' | 'string' | 'string|null' | 'boolean' | 'string[]' | 'points' | 'object|null'

/** Patchable keys and the value shape each accepts. */
const PATCH_KEYS: Readonly<Record<string, Kind>> = {
  x: 'number',
  y: 'number',
  width: 'number',
  height: 'number',
  angle: 'number',
  strokeColor: 'string',
  backgroundColor: 'string',
  fillStyle: 'string',
  strokeWidth: 'number',
  strokeStyle: 'string',
  roughness: 'number',
  opacity: 'number',
  groupIds: 'string[]',
  frameId: 'string|null',
  roundness: 'object|null',
  link: 'string|null',
  locked: 'boolean',
  customData: 'object|null',
  // text
  text: 'string',
  fontSize: 'number',
  fontFamily: 'number',
  textAlign: 'string',
  verticalAlign: 'string',
  lineHeight: 'number',
  autoResize: 'boolean',
  // linear
  points: 'points',
  startArrowhead: 'string|null',
  endArrowhead: 'string|null',
  // frame
  name: 'string|null',
  // image
  fileId: 'string',
  scale: 'points'
}

/** Keys that only make sense on some element types. */
const KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  text: [
    'text',
    'fontSize',
    'fontFamily',
    'textAlign',
    'verticalAlign',
    'lineHeight',
    'autoResize'
  ],
  arrow: ['points', 'startArrowhead', 'endArrowhead'],
  line: ['points', 'startArrowhead', 'endArrowhead'],
  frame: ['name'],
  image: ['fileId', 'scale']
}

function hasKind(v: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'number':
      return isFinite_(v)
    case 'string':
      return isString(v)
    case 'string|null':
      return v === null || isString(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'string[]':
      return isStringArray(v)
    case 'points':
      return isPoints(v) && v.length >= 2
    case 'object|null':
      return v === null || isRecord(v)
  }
}

export type AppliedPatch = {
  /** Validated changes to hand to `newElementWith` (`text` comes with `originalText`). */
  changes: Record<string, unknown>
  /** The element is a text whose text or font changed: re-measure it. */
  textChanged: boolean
}

/**
 * Turn an agent patch into element changes. Read-only keys are stripped;
 * unknown keys, keys that don't apply to the element's type and ill-typed
 * values are rejected (BAD_PARAMS) so nothing lands in a scene half-applied.
 */
export function applyPatch(el: ExcalidrawElement, patch: ElementPatch): AppliedPatch {
  const changes: Record<string, unknown> = {}
  let textChanged = false
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_PATCH_KEYS.has(key) || value === undefined) continue
    const kind = PATCH_KEYS[key]
    if (!kind) throw bad(`element ${el.id}: unknown key "${key}"`)
    const owner = Object.entries(KEYS_BY_TYPE).find(([, keys]) => keys.includes(key))?.[0]
    if (owner && owner !== el.type && !(owner === 'line' && el.type === 'arrow')) {
      throw bad(`element ${el.id}: "${key}" does not apply to a ${el.type}`)
    }
    if (!hasKind(value, kind)) throw bad(`element ${el.id}: invalid value for "${key}"`)
    changes[key] = value
    if (key === 'text') {
      changes.originalText = value
      textChanged = true
    } else if (key === 'fontSize' || key === 'fontFamily' || key === 'lineHeight') {
      textChanged = true
    } else if (key === 'points') {
      const pts = value as [number, number][]
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      changes.width = Math.max(...xs) - Math.min(...xs)
      changes.height = Math.max(...ys) - Math.min(...ys)
    }
  }
  return { changes, textChanged }
}

// ---- bound text ---------------------------------------------------------------

/** Excalidraw's inset between a container's edge and its bound text. */
export const BOUND_TEXT_PADDING = 5

/**
 * Where a container's bound label belongs, honouring the label's textAlign and
 * verticalAlign (centre / middle by default). The container's whole box is
 * used for every shape; for ellipses and diamonds that matches Excalidraw
 * exactly only for centred text, which is what labels use.
 */
export function boundTextPosition(
  container: ExcalidrawElement,
  text: ExcalidrawTextElement
): { x: number; y: number } {
  const pad = BOUND_TEXT_PADDING
  let x = container.x + (container.width - text.width) / 2
  if (text.textAlign === 'left') x = container.x + pad
  else if (text.textAlign === 'right') x = container.x + container.width - text.width - pad
  let y = container.y + (container.height - text.height) / 2
  if (text.verticalAlign === 'top') y = container.y + pad
  else if (text.verticalAlign === 'bottom') y = container.y + container.height - text.height - pad
  return { x, y }
}

// ---- add ----------------------------------------------------------------------

/** Keys stripped from skeletons: Excalidraw assigns these. */
const FORBIDDEN_SKELETON_KEYS: ReadonlySet<string> = new Set([
  'version',
  'versionNonce',
  'updated',
  'index',
  'isDeleted',
  'boundElements',
  'containerId',
  'startBinding',
  'endBinding'
])

/**
 * Validate the `elements` of an addElements call against the scene's existing
 * ids. Returns cleaned copies (read-only keys removed). Ids are optional; when
 * given they must be unique across the batch and the scene. `start` / `end` /
 * `children` may reference ids in the batch or already in the scene.
 */
export function validateSkeletons(
  elements: unknown,
  existingIds: ReadonlySet<string>
): ElementJSON[] {
  if (!Array.isArray(elements) || elements.length === 0)
    throw bad('elements must be a non-empty array')
  if (elements.length > MAX_ELEMENTS_PER_CALL) {
    throw bad(`elements has ${elements.length} entries (max ${MAX_ELEMENTS_PER_CALL})`)
  }
  const batchIds = new Set<string>()
  const cleaned: ElementJSON[] = []
  elements.forEach((raw, i) => {
    const at = `elements[${i}]`
    if (!isRecord(raw)) throw bad(`${at} must be an object`)
    const type = raw.type
    if (!isString(type) || !ADDABLE_TYPES.has(type)) {
      throw bad(`${at}: unsupported type "${String(type)}" (use ${[...ADDABLE_TYPES].join(' | ')})`)
    }
    if (raw.id !== undefined) {
      if (!isString(raw.id) || !ID_PATTERN.test(raw.id)) throw bad(`${at}: invalid id`)
      if (existingIds.has(raw.id)) throw bad(`${at}: id "${raw.id}" already exists in the drawing`)
      if (batchIds.has(raw.id)) throw bad(`${at}: duplicate id "${raw.id}" in this call`)
      batchIds.add(raw.id)
    }
    const boundBothEnds =
      type === 'arrow' &&
      isRecord(raw.start) &&
      isString(raw.start.id) &&
      isRecord(raw.end) &&
      isString(raw.end.id)
    // Frames size themselves from their children; arrows bound at both ends are routed.
    const positionOptional = type === 'frame' || boundBothEnds
    for (const key of ['x', 'y']) {
      if (raw[key] === undefined ? !positionOptional : !isFinite_(raw[key])) {
        throw bad(`${at}: x and y must be numbers`)
      }
    }
    for (const key of ['width', 'height', 'angle', 'strokeWidth', 'opacity', 'fontSize']) {
      if (raw[key] !== undefined && !isFinite_(raw[key]))
        throw bad(`${at}: ${key} must be a number`)
    }
    if (type === 'text' && !isString(raw.text))
      throw bad(`${at}: text elements need a "text" string`)
    if (type === 'image' && !isString(raw.fileId))
      throw bad(`${at}: image elements need a "fileId"`)
    if (raw.label !== undefined) {
      if (type === 'text' || type === 'line' || type === 'frame' || type === 'image') {
        throw bad(`${at}: a ${type} cannot have a label`)
      }
      if (!isRecord(raw.label) || !isString(raw.label.text))
        throw bad(`${at}: label must be { text }`)
    }
    if (raw.points !== undefined && !isPoints(raw.points))
      throw bad(`${at}: points must be [[x, y], ...]`)
    if (type === 'arrow' || type === 'line') {
      for (const side of ['start', 'end'] as const) {
        const ref = raw[side]
        if (ref === undefined || ref === null) continue
        if (type === 'line') throw bad(`${at}: only arrows can bind with ${side}`)
        if (!isRecord(ref)) throw bad(`${at}: ${side} must be an object`)
        if (ref.id !== undefined && !isString(ref.id))
          throw bad(`${at}: ${side}.id must be a string`)
        if (ref.id === undefined && !isString(ref.type))
          throw bad(`${at}: ${side} needs an id or a type`)
      }
    }
    if (type === 'frame') {
      if (!isStringArray(raw.children)) throw bad(`${at}: frames need a "children" id array`)
    }
    const copy: Rec = {}
    for (const [k, v] of Object.entries(raw))
      if (!FORBIDDEN_SKELETON_KEYS.has(k) && v !== undefined) copy[k] = v
    cleaned.push(copy as ElementJSON)
  })
  // References are checked once every batch id is known.
  const known = (id: string): boolean => batchIds.has(id) || existingIds.has(id)
  cleaned.forEach((el, i) => {
    const at = `elements[${i}]`
    for (const side of ['start', 'end'] as const) {
      const ref = el[side]
      if (isRecord(ref) && isString(ref.id) && !known(ref.id))
        throw bad(`${at}: ${side}.id "${ref.id}" is unknown`)
    }
    if (el.type === 'frame') {
      for (const id of el.children as string[])
        if (!known(id)) throw bad(`${at}: child "${id}" is unknown`)
    }
  })
  return cleaned
}

export type ArrowBindingRef = { arrowId: string; side: 'start' | 'end'; targetId: string }

export type PreparedSkeletons = {
  /**
   * Skeletons for the converter: ids assigned, `{id}` arrow references and
   * pre-existing frame children removed (the converter only resolves ids
   * within its batch, so the caller binds by id afterwards).
   */
  skeletons: ElementJSON[]
  /**
   * Arrows bound at both ends that came without x/y: built after `skeletons`
   * exist, routed between their targets (`routeArrow`). Already have ids and
   * no `start` / `end`.
   */
  routed: ElementJSON[]
  /** Every arrow end bound by id, to targets in the batch or already in the scene. */
  bindings: ArrowBindingRef[]
  /** Elements the converter will not place into their frame (pre-existing ones and routed arrows). */
  frameMembers: { id: string; frameId: string }[]
  /** Frames whose geometry the agent fixed explicitly (re-applied after conversion). */
  frameBoxes: Map<string, Bounds>
}

/**
 * Split an addElements batch into what `convertToExcalidrawElements` can do
 * and what the caller finishes afterwards (bindings by id, routed arrows,
 * frame membership of pre-existing elements). Every skeleton gets an id so
 * the halves can meet. Input must have passed `validateSkeletons`.
 */
export function prepareSkeletons(
  skeletons: readonly ElementJSON[],
  existing: ReadonlyMap<string, ExcalidrawElement>,
  makeId: () => string
): PreparedSkeletons {
  const out: ElementJSON[] = []
  const routed: ElementJSON[] = []
  const bindings: ArrowBindingRef[] = []
  const frameMembers: { id: string; frameId: string }[] = []
  const frameBoxes = new Map<string, Bounds>()
  const routedIds = new Set<string>()
  for (const skel of skeletons) {
    const el: Rec = { ...skel, id: skel.id ?? makeId() }
    const id = el.id as string
    if (el.type === 'arrow') {
      let bound = 0
      for (const side of ['start', 'end'] as const) {
        const ref = el[side]
        if (!isRecord(ref) || !isString(ref.id)) continue
        bindings.push({ arrowId: id, side, targetId: ref.id })
        delete el[side]
        bound++
      }
      if (!isFinite_(el.x) || !isFinite_(el.y)) {
        if (bound < 2) throw bad(`arrow ${id}: give it x and y, or bind both start and end by id`)
        routedIds.add(id)
        routed.push(el as ElementJSON)
        continue
      }
    }
    out.push(el as ElementJSON)
  }
  for (const el of out) {
    if (el.type !== 'frame') continue
    const id = el.id as string
    const children = el.children as string[]
    const inBatch = children.filter((c) => !existing.has(c) && !routedIds.has(c))
    for (const c of children)
      if (existing.has(c) || routedIds.has(c)) frameMembers.push({ id: c, frameId: id })
    el.children = inBatch
    const box = { x: el.x, y: el.y, width: el.width, height: el.height }
    if (isFinite_(box.x) && isFinite_(box.y) && isFinite_(box.width) && isFinite_(box.height)) {
      frameBoxes.set(id, box as Bounds)
    } else if (!inBatch.length) {
      throw bad(`frame ${id}: give it x, y, width and height, or new children to size it from`)
    }
  }
  return { skeletons: out, routed, bindings, frameMembers, frameBoxes }
}

/** Space left between a routed arrow's tip and the shape it points at. */
export const ROUTE_GAP = 4

export type ArrowGeometry = { x: number; y: number; points: [number, number][] }

/**
 * A straight arrow from the centre of `from` to the centre of `to`, trimmed to
 * each shape's outline plus `ROUTE_GAP`. Falls back to centre-to-centre when
 * the shapes overlap.
 */
export function routeArrow(from: ExcalidrawElement, to: ExcalidrawElement): ArrowGeometry {
  const c1 = center(from)
  const c2 = center(to)
  const [dx, dy] = [c2[0] - c1[0], c2[1] - c1[1]]
  const len = Math.hypot(dx, dy)
  if (len < 1)
    return {
      x: c1[0],
      y: c1[1],
      points: [
        [0, 0],
        [1, 1]
      ]
    }
  const dir: [number, number] = [dx / len, dy / len]
  const t1 = edgeDistance(from, dir) + ROUTE_GAP
  const t2 = edgeDistance(to, [-dir[0], -dir[1]]) + ROUTE_GAP
  if (t1 + t2 >= len) {
    return {
      x: c1[0],
      y: c1[1],
      points: [
        [0, 0],
        [round(dx), round(dy)]
      ]
    }
  }
  const x = c1[0] + dir[0] * t1
  const y = c1[1] + dir[1] * t1
  const span = len - t1 - t2
  return {
    x: round(x),
    y: round(y),
    points: [
      [0, 0],
      [round(dir[0] * span), round(dir[1] * span)]
    ]
  }
}

const center = (el: ExcalidrawElement): [number, number] => [
  el.x + el.width / 2,
  el.y + el.height / 2
]

/** Distance from an element's centre to its outline along `dir` (unit vector; rotation ignored). */
function edgeDistance(el: ExcalidrawElement, [ux, uy]: [number, number]): number {
  const hw = el.width / 2
  const hh = el.height / 2
  if (hw <= 0 || hh <= 0) return 0
  switch (el.type) {
    case 'ellipse': {
      // Ray from the centre meets x²/hw² + y²/hh² = 1 at t = 1/√(ux²/hw² + uy²/hh²).
      return 1 / Math.sqrt((ux * ux) / (hw * hw) + (uy * uy) / (hh * hh))
    }
    case 'diamond': {
      // Rhombus |x|/hw + |y|/hh = 1.
      return 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh)
    }
    default: {
      const tx = ux ? hw / Math.abs(ux) : Infinity
      const ty = uy ? hh / Math.abs(uy) : Infinity
      return Math.min(tx, ty)
    }
  }
}

/** Distance from a point to an element's axis-aligned box (0 inside). */
export function distanceToBox(el: ExcalidrawElement, [px, py]: [number, number]): number {
  const dx = Math.max(el.x - px, 0, px - (el.x + el.width))
  const dy = Math.max(el.y - py, 0, py - (el.y + el.height))
  return Math.hypot(dx, dy)
}

/** Where on the target's box (0–1 in each axis) a point lies; for elbow arrows. */
export function fixedPointOn(el: ExcalidrawElement, [px, py]: [number, number]): [number, number] {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  return [
    el.width ? clamp((px - el.x) / el.width) : 0.5,
    el.height ? clamp((py - el.y) / el.height) : 0.5
  ]
}

/**
 * The binding record for one end of `arrow` attached to `target`. `focus: 0`
 * aims the arrow at the target's centre, which is what a routed arrow does and
 * a sensible default for hand-placed ones; Excalidraw recomputes the end
 * point from focus/gap when the target moves.
 */
export function arrowBinding(
  arrow: ExcalidrawLinearElement,
  side: 'start' | 'end',
  target: ExcalidrawElement,
  gap?: number
): NonNullable<ExcalidrawLinearElement['startBinding']> & { fixedPoint?: [number, number] } {
  if (!BINDABLE_TYPES.has(target.type))
    throw bad(`arrow ${arrow.id}: cannot bind ${side} to a ${target.type}`)
  const pt = arrow.points[side === 'start' ? 0 : arrow.points.length - 1]
  const at: [number, number] = [arrow.x + pt[0], arrow.y + pt[1]]
  if ((arrow as { elbowed?: boolean }).elbowed) {
    return { elementId: target.id, focus: 0, gap: 0, fixedPoint: fixedPointOn(target, at) }
  }
  return { elementId: target.id, focus: 0, gap: Math.max(1, gap ?? distanceToBox(target, at)) }
}
