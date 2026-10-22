// Window shell: the tab strip plus one DocumentEditor per *mounted* tab.
//
// Tabs model. App owns tab order, the active tab and an MRU list; main owns which
// docs belong to this window, their paths on disk and the save prompts.
//
// Performance. An Excalidraw instance is heavy (several canvases, a scene, caches),
// so at most MAX_MOUNTED editors — the most recently used tabs — are mounted. The
// others are "evicted": just before unmounting, the scene is serialized into the
// tab's `doc.contents` and its dirty/save-as flags into `init`, so a remount picks
// up exactly where it left off (minus undo history). Tabs that were never shown
// are not mounted at all until first activated.
//
// Render isolation. Editors receive only props that are stable for their lifetime
// (`doc`, `init`, the shared `events` object, theme) plus their own `active`
// boolean, so switching tabs re-renders the strip and two editor wrappers, never
// the Excalidraw trees. Dirty state and names flow up into App through callbacks
// that fire on transitions only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { serializeAsJSON } from '@excalidraw/excalidraw'
import type { LibraryItems } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import './app.css'
import { TAB_STRIP_HEIGHT } from '../../shared/chrome'
import type { DocPayload, MenuAction } from '../../shared/ipc'
import { docName } from './blob'
import { bridge } from './bridge'
import { TabStrip, type TabInfo } from './components/TabStrip'
import { DocumentEditor } from './DocumentEditor'
import { loadLibrary, saveLibraryJSON, serializeLibrary } from './library'
import { setPortalOwner } from './portalGuard'
import { useForwardStrayKeys, useMenuOwnedShortcuts, useTabNumberShortcuts } from './shortcuts'
import type { EditorEvents, EditorHandle, EditorInit } from './tabs'
import { useTheme } from './theme'

/** Editors kept alive at once (the most recently used tabs). */
export const MAX_MOUNTED = 5

const DEFAULT_BACKGROUND = '#ffffff'

type Tab = {
  docId: string
  /** What the editor mounts from: main's payload, or an eviction snapshot. */
  doc: DocPayload
  /** Carried-over state for a remount after eviction. */
  init: EditorInit | undefined
  /** Bumped when main replaces the document, so its editor remounts. */
  load: number
  /** Current path on disk (updated on save). */
  path: string | null
  dirty: boolean
  /** "Untitled N" numbering, assigned when the tab is created. */
  untitled: number
  background: string
}

type Model = {
  tabs: Tab[]
  activeId: string | null
  /** All tab ids, most recently used first. */
  mru: string[]
  /** Mounted tab ids, most recently used first (≤ MAX_MOUNTED). */
  mounted: string[]
}

const EMPTY_MODEL: Model = { tabs: [], activeId: null, mru: [], mounted: [] }

function nextUntitled(tabs: Tab[]): number {
  const used = new Set(tabs.filter((t) => !t.path).map((t) => t.untitled))
  let n = 1
  while (used.has(n)) n++
  return n
}

function newTab(doc: DocPayload, tabs: Tab[]): Tab {
  return {
    docId: doc.docId,
    doc,
    init: undefined,
    load: 1,
    path: doc.path,
    dirty: !!doc.recovered,
    untitled: doc.path ? 0 : nextUntitled(tabs),
    background: DEFAULT_BACKGROUND
  }
}

function tabTitle(tab: Tab): string {
  return docName(tab.path) ?? (tab.untitled > 1 ? `Untitled ${tab.untitled}` : 'Untitled')
}

const emptyScene = (): string => serializeAsJSON([], {}, {}, 'local')

function App(): React.JSX.Element {
  const { preference, theme, setPreference } = useTheme()
  const [fullScreen, setFullScreen] = useState(false)

  // The model lives in a ref (read synchronously by IPC handlers and the close
  // flow) mirrored into state for rendering.
  const [model, setModelState] = useState<Model>(EMPTY_MODEL)
  const modelRef = useRef(model)
  const commit = useCallback((next: Model) => {
    modelRef.current = next
    setModelState(next)
  }, [])
  const updateTab = useCallback(
    (docId: string, patch: (tab: Tab) => Tab) => {
      const m = modelRef.current
      let changed = false
      const tabs = m.tabs.map((t) => {
        if (t.docId !== docId) return t
        const next = patch(t)
        changed ||= next !== t
        return next
      })
      if (changed) commit({ ...m, tabs })
    },
    [commit]
  )

  const editors = useRef(new Map<string, EditorHandle>())

  // ---- activation & eviction -------------------------------------------------

  /** Snapshot an editor that is about to unmount into its tab. */
  const evict = useCallback((tab: Tab): Tab => {
    const snap = editors.current.get(tab.docId)?.snapshot()
    // Still loading (or never registered): remount from the same payload.
    if (!snap) return tab
    const { contents, ...init } = snap
    return {
      ...tab,
      doc: { docId: tab.docId, path: tab.path, contents },
      init,
      dirty: init.dirty
    }
  }, [])

  const activate = useCallback(
    (docId: string) => {
      const m = modelRef.current
      if (!m.tabs.some((t) => t.docId === docId)) return
      if (m.activeId === docId && m.mounted[0] === docId) return
      const mounted = [docId, ...m.mounted.filter((id) => id !== docId)]
      const evicted = new Set(mounted.slice(MAX_MOUNTED))
      commit({
        tabs: evicted.size ? m.tabs.map((t) => (evicted.has(t.docId) ? evict(t) : t)) : m.tabs,
        activeId: docId,
        mru: [docId, ...m.mru.filter((id) => id !== docId)],
        mounted: mounted.slice(0, MAX_MOUNTED)
      })
    },
    [commit, evict]
  )

  const openDocs = useCallback(
    (docs: DocPayload[], activeDocId: string) => {
      const m = modelRef.current
      let tabs = m.tabs
      let mru = m.mru
      for (const doc of docs) {
        const existing = tabs.find((t) => t.docId === doc.docId)
        if (existing) {
          // Main replaced this tab's document (e.g. opened a file into a pristine
          // untitled tab): fresh editor, fresh state.
          tabs = tabs.map((t) =>
            t.docId === doc.docId
              ? {
                  ...newTab(
                    doc,
                    tabs.filter((o) => o.docId !== doc.docId)
                  ),
                  load: t.load + 1
                }
              : t
          )
        } else {
          tabs = [...tabs, newTab(doc, tabs)]
          mru = [...mru, doc.docId]
        }
      }
      commit({ ...m, tabs, mru })
      activate(tabs.some((t) => t.docId === activeDocId) ? activeDocId : (docs[0]?.docId ?? ''))
    },
    [activate, commit]
  )

  const removeTab = useCallback(
    (docId: string) => {
      const m = modelRef.current
      if (!m.tabs.some((t) => t.docId === docId)) return
      const tabs = m.tabs.filter((t) => t.docId !== docId)
      const mru = m.mru.filter((id) => id !== docId)
      const mounted = m.mounted.filter((id) => id !== docId)
      const activeId = m.activeId === docId ? (mru[0] ?? null) : m.activeId
      commit({ tabs, activeId, mru, mounted })
      // Mount the MRU neighbour if it had been evicted.
      if (activeId) activate(activeId)
    },
    [activate, commit]
  )

  // ---- saving & closing ------------------------------------------------------

  /** Save (not Save As). Works for mounted editors and for evicted snapshots. */
  const saveDoc = useCallback(
    async (docId: string): Promise<boolean> => {
      const handle = editors.current.get(docId)
      if (handle) return handle.save({ saveAs: false })
      const tab = modelRef.current.tabs.find((t) => t.docId === docId)
      if (!tab) return false
      try {
        const result = await bridge.save(docId, tab.doc.contents ?? emptyScene(), {
          saveAs: !!tab.init?.forceSaveAs
        })
        if (!result) return false
        updateTab(docId, (t) => ({
          ...t,
          path: result.path,
          dirty: false,
          doc: { ...t.doc, path: result.path, recovered: false },
          init: t.init && { ...t.init, dirty: false, forceSaveAs: false }
        }))
        bridge.setDirty(docId, false)
        return true
      } catch (err) {
        console.error('Save failed', err)
        return false
      }
    },
    [updateTab]
  )

  const closing = useRef(new Set<string>())
  const closeTab = useCallback(
    async (docId: string) => {
      if (closing.current.has(docId)) return
      closing.current.add(docId)
      try {
        const decision = await bridge.requestCloseDoc(docId)
        if (decision === 'cancel') return
        if (decision === 'save' && !(await saveDoc(docId))) return
        removeTab(docId)
        bridge.docClosed(docId)
        // Main treats some remaining tab as active until told otherwise; report
        // after every close, even when the active tab didn't change.
        const { activeId } = modelRef.current
        if (activeId) bridge.setActiveDoc(activeId)
      } catch (err) {
        console.error('Close failed', err)
      } finally {
        closing.current.delete(docId)
      }
    },
    [removeTab, saveDoc]
  )

  // ---- shared library ---------------------------------------------------------

  const libraryJSON = useRef<string | null>(null)
  const librarySyncing = useRef(new Set<string>())
  const onLibraryChange = useCallback((docId: string, items: LibraryItems) => {
    // Echo of our own updateLibrary() below.
    if (librarySyncing.current.has(docId)) return
    const json = serializeLibrary(items)
    libraryJSON.current ??= serializeLibrary(loadLibrary())
    if (json === libraryJSON.current) return
    libraryJSON.current = json
    saveLibraryJSON(json)
    // Excalidraw keeps a library per instance; push the change to the other
    // mounted editors. Evicted/unmounted ones read it from storage on mount.
    for (const [id, handle] of editors.current) {
      const api = id !== docId ? handle.getApi() : null
      if (!api) continue
      librarySyncing.current.add(id)
      api
        .updateLibrary({ libraryItems: items, merge: false })
        .catch((err) => console.error('Library sync failed', err))
        .finally(() => librarySyncing.current.delete(id))
    }
  }, [])

  // ---- editor events (identity-stable for the App's lifetime) ----------------

  const events = useMemo<EditorEvents>(
    () => ({
      register: (docId, handle) => {
        if (handle) editors.current.set(docId, handle)
        else editors.current.delete(docId)
      },
      onDirtyChange: (docId, dirty) =>
        updateTab(docId, (t) => (t.dirty === dirty ? t : { ...t, dirty })),
      onPathChange: (docId, path) =>
        updateTab(docId, (t) => (t.path === path ? t : { ...t, path })),
      onBackgroundChange: (docId, color) =>
        updateTab(docId, (t) => (t.background === color ? t : { ...t, background: color })),
      onLibraryChange,
      getInitialLibrary: loadLibrary,
      onThemePreferenceChange: setPreference
    }),
    [onLibraryChange, setPreference, updateTab]
  )

  // ---- IPC --------------------------------------------------------------------

  const handleMenu = useCallback(
    (action: MenuAction) => {
      const m = modelRef.current
      const { activeId, tabs } = m
      if (!activeId) return
      const index = tabs.findIndex((t) => t.docId === activeId)
      switch (action) {
        case 'next-tab':
        case 'prev-tab': {
          if (tabs.length < 2) return
          const step = action === 'next-tab' ? 1 : -1
          return activate(tabs[(index + step + tabs.length) % tabs.length].docId)
        }
        case 'close-tab':
          return void closeTab(activeId)
        default:
          return editors.current.get(activeId)?.menu(action)
      }
    },
    [activate, closeTab]
  )

  useEffect(() => {
    let cancelled = false
    bridge.getInitialState().then(
      (state) => {
        if (cancelled) return
        setFullScreen(state.fullScreen)
        // Docs main pushed before this resolved are already tabs; keep them.
        const known = new Set(modelRef.current.tabs.map((t) => t.docId))
        const fresh = state.docs.filter((d) => !known.has(d.docId))
        openDocs(fresh, modelRef.current.activeId ?? state.activeDocId)
      },
      (err) => console.error('getInitialState failed', err)
    )
    const unsubscribers = [
      bridge.onOpenDocs(openDocs),
      bridge.onActivateDoc(activate),
      bridge.onSaveAndClose((docId) => void saveDoc(docId)),
      bridge.onMenu(handleMenu),
      bridge.onFullScreenChange(setFullScreen)
    ]
    return () => {
      cancelled = true
      unsubscribers.forEach((off) => off())
    }
  }, [activate, handleMenu, openDocs, saveDoc])

  const { activeId } = model
  useEffect(() => {
    if (!activeId) return
    bridge.setActiveDoc(activeId)
    setPortalOwner(activeId)
    editors.current.get(activeId)?.focus()
  }, [activeId])

  // ---- keyboard ---------------------------------------------------------------

  useMenuOwnedShortcuts()
  const selectTabNumber = useCallback(
    (index: number | 'last') => {
      const { tabs } = modelRef.current
      const tab = index === 'last' ? tabs.at(-1) : tabs[index]
      if (tab) activate(tab.docId)
    },
    [activate]
  )
  useTabNumberShortcuts(selectTabNumber)
  const focusActive = useCallback((): HTMLElement | null => {
    const id = modelRef.current.activeId
    if (!id) return null
    editors.current.get(id)?.focus()
    return document.activeElement as HTMLElement | null
  }, [])
  useForwardStrayKeys(focusActive)

  // ---- tab strip --------------------------------------------------------------

  const reorder = useCallback(
    (docId: string, targetId: string, after: boolean) => {
      const m = modelRef.current
      const moving = m.tabs.find((t) => t.docId === docId)
      if (!moving) return
      const rest = m.tabs.filter((t) => t.docId !== docId)
      const at = rest.findIndex((t) => t.docId === targetId)
      if (at < 0) return
      rest.splice(after ? at + 1 : at, 0, moving)
      commit({ ...m, tabs: rest })
    },
    [commit]
  )
  const onCloseTab = useCallback((docId: string) => void closeTab(docId), [closeTab])
  const onRefocus = useCallback(() => void focusActive(), [focusActive])

  const tabInfos = useMemo<TabInfo[]>(
    () =>
      model.tabs.map((t) => {
        const title = tabTitle(t)
        return { docId: t.docId, title, tooltip: t.path ?? title, dirty: t.dirty }
      }),
    [model.tabs]
  )
  const activeTab = model.tabs.find((t) => t.docId === activeId)

  // Mounted editors in a stable DOM order (by docId) so switching never moves nodes.
  const mountedTabs = useMemo(() => {
    const ids = new Set(model.mounted)
    return model.tabs
      .filter((t) => ids.has(t.docId))
      .sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
  }, [model.mounted, model.tabs])

  return (
    <div className={`sketchbook-app sketchbook-app--${theme}`}>
      <TabStrip
        tabs={tabInfos}
        activeId={activeId}
        fullScreen={fullScreen}
        theme={theme}
        background={activeTab?.background ?? DEFAULT_BACKGROUND}
        onActivate={activate}
        onClose={onCloseTab}
        onNewTab={bridge.newTab}
        onReorder={reorder}
        onRefocus={onRefocus}
      />
      <div className="sketchbook-editors" style={{ top: TAB_STRIP_HEIGHT }}>
        {mountedTabs.map((tab) => (
          <DocumentEditor
            key={`${tab.docId}:${tab.load}`}
            doc={tab.doc}
            init={tab.init}
            active={tab.docId === activeId}
            theme={theme}
            themePreference={preference}
            events={events}
          />
        ))}
      </div>
    </div>
  )
}

export default App
