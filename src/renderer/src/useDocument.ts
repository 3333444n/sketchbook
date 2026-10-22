// One document's lifecycle: load, dirty/empty tracking, debounced crash-recovery
// autosave, save / save as, and snapshotting for eviction. All state lives in this
// hook instance, so several editors (tabs) coexist.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hashElementsVersion, serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems
} from '@excalidraw/excalidraw/types'
import type { DocPayload } from '../../shared/ipc'
import { docName, parseContents, type LoadedScene } from './blob'
import { bridge } from './bridge'
import type { EditorEvents, EditorInit, EditorSnapshot, EditorView } from './tabs'

const AUTOSAVE_DELAY_MS = 1000

type DocumentAppState = Pick<
  AppState,
  'viewBackgroundColor' | 'gridSize' | 'gridStep' | 'gridModeEnabled'
>

/** The parts of a file's appState worth applying when opening it (not view/UI state). */
function documentAppState(appState: LoadedScene['appState']): DocumentAppState {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    gridModeEnabled: appState.gridModeEnabled
  }
}

function viewAppState(view: EditorView): Partial<AppState> {
  return {
    scrollX: view.scrollX,
    scrollY: view.scrollY,
    zoom: { value: view.zoom as AppState['zoom']['value'] }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type InitialLoad = { data: ExcalidrawInitialDataState; error: string | null }

async function loadDoc(
  doc: DocPayload,
  init: EditorInit | undefined,
  libraryItems: LibraryItems
): Promise<InitialLoad> {
  if (!doc.contents) return { data: { libraryItems }, error: null }
  try {
    const scene = await parseContents(doc.contents)
    const view = init?.view
    return {
      data: {
        elements: scene.elements,
        appState: { ...documentAppState(scene.appState), ...(view && viewAppState(view)) },
        files: scene.files,
        libraryItems,
        // A remounted tab returns to where the user left it.
        scrollToContent: !view
      },
      error: null
    }
  } catch (err) {
    console.error('Failed to load document', err)
    return {
      data: { libraryItems },
      error:
        "Couldn't open this file. It may be damaged or not an Excalidraw drawing. " +
        'Use Save As to keep your work without overwriting it.'
    }
  }
}

export type DocumentController = {
  /** For Excalidraw's `initialData` prop. */
  initialData: Promise<ExcalidrawInitialDataState>
  /** File basename for Excalidraw's `name` prop (default export filename). */
  name: string | undefined
  /** For Excalidraw's `excalidrawAPI` prop. */
  setApi: (api: ExcalidrawImperativeAPI) => void
  /** For Excalidraw's `onChange` prop. */
  onChange: (elements: readonly ExcalidrawElement[], appState: AppState) => void
  /** Resolves true when the document was written to disk. */
  save: (opts: { saveAs: boolean }) => Promise<boolean>
  /** Serialize the scene for eviction; flushes any pending autosave first. */
  snapshot: () => EditorSnapshot | null
  /** Imperative API once Excalidraw has mounted. */
  getApi: () => ExcalidrawImperativeAPI | null
}

/**
 * @param init  state carried over from an evicted editor of the same document;
 *              undefined for a document's first mount.
 */
export function useDocument(
  doc: DocPayload,
  init: EditorInit | undefined,
  events: EditorEvents
): DocumentController {
  const { docId } = doc
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [name, setName] = useState(() => docName(doc.path))

  // Scene version at the last load/save; `null` = take it from the first settled
  // onChange (Excalidraw re-restores initialData, so baseline on what it ends up with).
  const baseline = useRef<number | null>(null)
  // Recovered docs (and evicted dirty ones) are dirty until saved, even though
  // nothing changed since this editor loaded them.
  const forceDirty = useRef(init ? init.dirty : !!doc.recovered)
  // After a failed load, never overwrite the original file in place.
  const forceSaveAs = useRef(init?.forceSaveAs ?? false)
  // Shown once the editor is ready (only on the document's first mount).
  const pendingToast = useRef<string | null>(
    !init && doc.recovered ? 'Recovered unsaved changes' : null
  )
  const pendingError = useRef<string | null>(null)

  const lastVersion = useRef<number | null>(null)
  // null until first reported, so a fresh editor always tells main its state.
  const dirty = useRef<boolean | null>(null)
  const empty = useRef<boolean | null>(null)
  const background = useRef<string | null>(null)
  const saving = useRef(false)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Parsed once per editor instance (an instance's doc prop never changes).
  const [load] = useState(() => loadDoc(doc, init, events.getInitialLibrary()))
  const initialData = useMemo(() => load.then((result) => result.data), [load])

  useEffect(() => {
    let live = true
    void load.then(({ error }) => {
      if (!live || !error) return
      forceSaveAs.current = true
      const api = apiRef.current
      if (api && !api.getAppState().isLoading) {
        api.updateScene({ appState: { errorMessage: error } })
      } else {
        pendingError.current = error
      }
    })
    return () => {
      live = false
    }
  }, [load])

  const cancelAutosave = useCallback((): void => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = null
  }, [])

  const serialize = (api: ExcalidrawImperativeAPI): string =>
    serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')

  const scheduleAutosave = (): void => {
    cancelAutosave()
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null
      const api = apiRef.current
      if (api && dirty.current) bridge.autosave(docId, serialize(api))
    }, AUTOSAVE_DELAY_MS)
  }

  /** Recompute dirty/empty from the scene; notify main and App only on transitions. */
  const evaluate = (elements: readonly ExcalidrawElement[]): void => {
    const version = hashElementsVersion(elements)
    if (baseline.current === null) baseline.current = version

    const isEmpty = !elements.some((el) => !el.isDeleted)
    if (isEmpty !== empty.current) {
      empty.current = isEmpty
      bridge.setEmpty(docId, isEmpty)
    }

    // setDirty(true) always goes out before the first autosave: main ignores
    // autosaves from clean docs.
    const isDirty = forceDirty.current || version !== baseline.current
    if (isDirty !== dirty.current) {
      dirty.current = isDirty
      bridge.setDirty(docId, isDirty)
      events.onDirtyChange(docId, isDirty)
    }

    if (version !== lastVersion.current) {
      const isFirst = lastVersion.current === null
      lastVersion.current = version
      // A recovered (or evicted) scene is already in the journal; don't rewrite it on load.
      if (isDirty && !isFirst) scheduleAutosave()
      else if (!isDirty) cancelAutosave()
    }
  }

  const flushMessages = (api: ExcalidrawImperativeAPI): void => {
    if (pendingError.current) {
      api.updateScene({ appState: { errorMessage: pendingError.current } })
      pendingError.current = null
    }
    if (pendingToast.current) {
      api.setToast({ message: pendingToast.current })
      pendingToast.current = null
    }
  }

  const onChange = (elements: readonly ExcalidrawElement[], appState: AppState): void => {
    if (appState.isLoading) return
    evaluate(elements)
    if (appState.viewBackgroundColor !== background.current) {
      background.current = appState.viewBackgroundColor
      events.onBackgroundChange(docId, appState.viewBackgroundColor)
    }
    const api = apiRef.current
    if (api && (pendingError.current || pendingToast.current)) {
      // Defer: setting state from inside onChange re-enters Excalidraw's update cycle.
      queueMicrotask(() => flushMessages(api))
    }
  }

  const save = async ({ saveAs }: { saveAs: boolean }): Promise<boolean> => {
    const api = apiRef.current
    if (!api || saving.current) return false
    saving.current = true
    const version = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    try {
      const result = await bridge.save(docId, serialize(api), {
        saveAs: saveAs || forceSaveAs.current
      })
      if (!result) return false // cancelled
      baseline.current = version
      forceDirty.current = false
      forceSaveAs.current = false
      setName(docName(result.path))
      events.onPathChange(docId, result.path)
      evaluate(api.getSceneElementsIncludingDeleted())
      api.setToast({ message: 'Saved', duration: 1500 })
      return true
    } catch (err) {
      console.error('Save failed', err)
      api.updateScene({ appState: { errorMessage: `Couldn't save: ${errorText(err)}` } })
      return false
    } finally {
      saving.current = false
    }
  }

  const snapshot = (): EditorSnapshot | null => {
    const api = apiRef.current
    if (!api || api.getAppState().isLoading) return null
    const contents = serialize(api)
    const isDirty = !!dirty.current
    // The journal must hold the latest scene: an autosave still waiting on its
    // debounce would be lost when the editor unmounts.
    if (autosaveTimer.current) {
      cancelAutosave()
      if (isDirty) bridge.autosave(docId, contents)
    }
    const appState = api.getAppState()
    return {
      contents,
      dirty: isDirty,
      forceSaveAs: forceSaveAs.current,
      view: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value }
    }
  }

  const setApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
  }, [])

  const getApi = useCallback(() => apiRef.current, [])

  useEffect(() => cancelAutosave, [cancelAutosave])

  return { initialData, name, setApi, onChange, save, snapshot, getApi }
}
