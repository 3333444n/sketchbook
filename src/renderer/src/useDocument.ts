// One document's lifecycle: load, dirty/empty tracking, debounced crash-recovery
// autosave, and save / save as. All state lives in this hook instance, so several
// editors (tabs) can coexist.

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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type InitialLoad = { data: ExcalidrawInitialDataState; error: string | null }

async function loadDoc(doc: DocPayload, libraryItems: LibraryItems): Promise<InitialLoad> {
  if (!doc.contents) return { data: { libraryItems }, error: null }
  try {
    const scene = await parseContents(doc.contents)
    return {
      data: {
        elements: scene.elements,
        appState: documentAppState(scene.appState),
        files: scene.files,
        libraryItems,
        scrollToContent: true
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
  save: (opts: { saveAs: boolean }) => Promise<void>
  /** Imperative API once Excalidraw has mounted. */
  getApi: () => ExcalidrawImperativeAPI | null
}

export function useDocument(
  doc: DocPayload,
  getInitialLibrary: () => LibraryItems
): DocumentController {
  const { docId } = doc
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [name, setName] = useState(() => docName(doc.path))

  // Scene version at the last load/save; `null` = take it from the first settled
  // onChange (Excalidraw re-restores initialData, so baseline on what it ends up with).
  const baseline = useRef<number | null>(null)
  // Recovered docs are dirty until saved, even though nothing changed since load.
  const forceDirty = useRef(!!doc.recovered)
  // After a failed load, never overwrite the original file in place.
  const forceSaveAs = useRef(false)
  // Shown once the editor is ready.
  const pendingToast = useRef<string | null>(doc.recovered ? 'Recovered unsaved changes' : null)
  const pendingError = useRef<string | null>(null)

  const lastVersion = useRef<number | null>(null)
  // null until first reported, so a fresh editor always tells main its state.
  const dirty = useRef<boolean | null>(null)
  const empty = useRef<boolean | null>(null)
  const saving = useRef(false)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Parsed once per editor instance (an instance's doc prop never changes).
  const [load] = useState(() => loadDoc(doc, getInitialLibrary()))
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

  /** Recompute dirty/empty from the scene; notify main only on transitions. */
  const evaluate = (elements: readonly ExcalidrawElement[]): void => {
    const version = hashElementsVersion(elements)
    if (baseline.current === null) baseline.current = version

    const isEmpty = !elements.some((el) => !el.isDeleted)
    if (isEmpty !== empty.current) {
      empty.current = isEmpty
      bridge.setEmpty(docId, isEmpty)
    }

    // setDirty(true) always goes out before the first autosave: main ignores
    // autosaves from clean windows.
    const isDirty = forceDirty.current || version !== baseline.current
    if (isDirty !== dirty.current) {
      dirty.current = isDirty
      bridge.setDirty(docId, isDirty)
    }

    if (version !== lastVersion.current) {
      const isFirst = lastVersion.current === null
      lastVersion.current = version
      // A recovered scene is already in the journal; don't rewrite it on load.
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
    const api = apiRef.current
    if (api && (pendingError.current || pendingToast.current)) {
      // Defer: setting state from inside onChange re-enters Excalidraw's update cycle.
      queueMicrotask(() => flushMessages(api))
    }
  }

  const save = async ({ saveAs }: { saveAs: boolean }): Promise<void> => {
    const api = apiRef.current
    if (!api || saving.current) return
    saving.current = true
    const version = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    try {
      const result = await bridge.save(docId, serialize(api), {
        saveAs: saveAs || forceSaveAs.current
      })
      if (!result) return // cancelled
      baseline.current = version
      forceDirty.current = false
      forceSaveAs.current = false
      setName(docName(result.path))
      evaluate(api.getSceneElementsIncludingDeleted())
      api.setToast({ message: 'Saved', duration: 1500 })
    } catch (err) {
      console.error('Save failed', err)
      api.updateScene({ appState: { errorMessage: `Couldn't save: ${errorText(err)}` } })
    } finally {
      saving.current = false
    }
  }

  const setApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
  }, [])

  const getApi = useCallback(() => apiRef.current, [])

  useEffect(() => cancelAutosave, [cancelAutosave])

  return { initialData, name, setApi, onChange, save, getApi }
}
