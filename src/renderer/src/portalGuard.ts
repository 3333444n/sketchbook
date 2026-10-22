// Hide body-level dialog portals that belong to hidden (inactive) editors.
//
// Excalidraw 0.18 keeps some UI state in a module-level jotai store shared by every
// instance on the page. Notably `activeConfirmDialogAtom`: opening "Clear canvas"
// (menu, command palette or ⌘⌫) in one editor renders the confirm dialog in *every*
// mounted editor, each as a modal portal appended to <body>. Without this guard the
// topmost of those portals could belong to a hidden tab, and confirming it would
// clear the wrong drawing.
//
// A portal's owner is found by walking its React fiber up to the editor wrapper
// (`.sketchbook-editor[data-doc-id]`). Portals of inactive editors get `display:none`.

const WRAPPER_CLASS = 'sketchbook-editor'

let activeDocId: string | null = null
let started = false
const owners = new WeakMap<Element, string | null>()

type Fiber = { return: Fiber | null; stateNode: unknown }

function fiberOf(el: Element): Fiber | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$')) return (el as unknown as Record<string, Fiber>)[key]
  }
  return null
}

/** docId of the editor that rendered this portal; null = not ours; undefined = not rendered yet. */
function ownerOf(portal: Element): string | null | undefined {
  if (owners.has(portal)) return owners.get(portal)
  const content = portal.firstElementChild
  if (!content) return undefined
  let fiber = fiberOf(content)
  let owner: string | null = null
  while (fiber) {
    const node = fiber.stateNode
    if (node instanceof HTMLElement && node.classList.contains(WRAPPER_CLASS)) {
      owner = node.dataset.docId ?? null
      break
    }
    fiber = fiber.return
  }
  owners.set(portal, owner)
  return owner
}

const pending = new Map<Element, MutationObserver>()

function sync(): void {
  for (const child of Array.from(document.body.children)) {
    if (!child.classList.contains('excalidraw')) continue
    const owner = ownerOf(child)
    if (owner === undefined) {
      // Portal container exists but React hasn't rendered into it yet.
      if (!pending.has(child)) {
        const mo = new MutationObserver(() => {
          mo.disconnect()
          pending.delete(child)
          sync()
        })
        mo.observe(child, { childList: true })
        pending.set(child, mo)
      }
      continue
    }
    const hide = owner !== null && owner !== activeDocId
    ;(child as HTMLElement).style.display = hide ? 'none' : ''
  }
}

/** Call whenever the active tab changes. */
export function setPortalOwner(docId: string | null): void {
  activeDocId = docId
  if (!started) {
    started = true
    new MutationObserver(sync).observe(document.body, { childList: true })
  }
  sync()
}
