// The window's document lifecycle: initial load, pushed loads, dirty/empty
// tracking, debounced crash-recovery autosave, and save / save as.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, hashElementsVersion, serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState
} from '@excalidraw/excalidraw/types'
import type { DocPayload } from '../../shared/ipc'
import { docName, parseContents, type LoadedScene } from './blob'
import { loadLibrary } from './library'

const AUTOSAVE_DELAY_MS = 1000

// One fetch per window, even if React (StrictMode) runs our state initializer twice.
let initialDocRequest: Promise<DocPayload> | null = null
const getInitialDocOnce = (): Promise<DocPayload> =>
  (initialDocRequest ??= window.sketchbook.getInitialDoc())

/** The parts of a file's appState worth applying when opening it (not view/UI state). */
type DocumentAppState = Pick<
  AppState,
  'viewBackgroundColor' | 'gridSize' | 'gridStep' | 'gridModeEnabled'
>

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

export type DocumentController = {
  /** Promise for Excalidraw's `initialData` prop (created once per window). */
  initialData: Promise<ExcalidrawInitialDataState>
  /** File basename for Excalidraw's `name` prop (default export filename). */
  name: string | undefined
  /** Pass to Excalidraw's `excalidrawAPI` prop. */
  setApi: (api: ExcalidrawImperativeAPI) => void
  /** Pass to Excalidraw's `onChange` prop. */
  onChange: (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles
  ) => void
  save: (opts: { saveAs: boolean }) => Promise<void>
}

export function useDocument(): DocumentController {
  const sketchbook = window.sketchbook
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [name, setName] = useState<string | undefined>(undefined)

  // Scene version at the last load/save. `null` = take it from the next settled onChange
  // (Excalidraw re-restores initialData, so we baseline on what it actually ends up with).
  const baseline = useRef<number | null>(null)
  // Recovered docs are dirty until saved, even though nothing changed since load.
  const forceDirty = useRef(false)
  // After a failed load, never overwrite the original file in place.
  const forceSaveAs = useRef(false)
  // Messages to show once the editor is ready (toast / error dialog).
  const pendingToast = useRef<string | null>(null)
  const pendingError = useRef<string | null>(null)

  const lastVersion = useRef<number | null>(null)
  const dirty = useRef(false)
  const empty = useRef<boolean | null>(null)
  const saving = useRef(false)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyMeta = useCallback((doc: DocPayload) => {
    setName(docName(doc.path))
    forceDirty.current = !!doc.recovered
    forceSaveAs.current = false
    pendingToast.current = doc.recovered ? 'Recovered unsaved changes' : null
  }, [])

  const loadFailed = useCallback((err: unknown) => {
    console.error('Failed to load document', err)
    forceSaveAs.current = true
    pendingError.current = `Couldn't open this file: ${errorText(err)}`
  }, [])

  // ---- initial load (once per window) ------------------------------------
  const [initialData] = useState<Promise<ExcalidrawInitialDataState>>(async () => {
    const libraryItems = loadLibrary()
    let doc: DocPayload
    try {
      doc = await getInitialDocOnce()
    } catch (err) {
      loadFailed(err)
      return { libraryItems }
    }
    applyMeta(doc)
    if (!doc.contents) return { libraryItems }
    try {
      const scene = await parseContents(doc.contents)
      return {
        elements: scene.elements,
        appState: documentAppState(scene.appState),
        files: scene.files,
        libraryItems,
        scrollToContent: true
      }
    } catch (err) {
      loadFailed(err)
      return { libraryItems }
    }
  })

  // ---- dirty / empty / autosave --------------------------------------------
  const cancelAutosave = (): void => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = null
  }

  const serialize = (api: ExcalidrawImperativeAPI): string =>
    serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')

  const scheduleAutosave = (): void => {
    cancelAutosave()
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null
      const api = apiRef.current
      if (api && dirty.current) sketchbook.autosave(serialize(api))
    }, AUTOSAVE_DELAY_MS)
  }

  /** Recompute dirty/empty from the scene and notify main only on transitions. */
  const evaluate = (elements: readonly ExcalidrawElement[]): void => {
    const version = hashElementsVersion(elements)
    if (baseline.current === null) baseline.current = version

    const isEmpty = !elements.some((el) => !el.isDeleted)
    if (isEmpty !== empty.current) {
      empty.current = isEmpty
      sketchbook.setEmpty(isEmpty)
    }

    const isDirty = forceDirty.current || version !== baseline.current
    if (isDirty !== dirty.current) {
      dirty.current = isDirty
      sketchbook.setDirty(isDirty)
    }

    if (version !== lastVersion.current) {
      lastVersion.current = version
      if (isDirty) scheduleAutosave()
      else cancelAutosave()
    }
  }

  /** Show anything queued during load, once the editor can display it. */
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
    if (apiRef.current && (pendingError.current || pendingToast.current)) {
      // Defer: calling setState from inside onChange re-enters Excalidraw's update cycle.
      const api = apiRef.current
      queueMicrotask(() => flushMessages(api))
    }
  }

  // ---- documents pushed by main into this (empty) window --------------------
  useEffect(() => {
    return sketchbook.onLoadDoc(async (doc) => {
      const api = apiRef.current
      if (!api) return
      applyMeta(doc)
      try {
        const scene = doc.contents ? await parseContents(doc.contents) : null
        api.updateScene({
          elements: scene?.elements ?? [],
          appState: scene ? documentAppState(scene.appState) : null,
          captureUpdate: CaptureUpdateAction.NEVER
        })
        if (scene) api.addFiles(Object.values(scene.files))
        api.history.clear()
        api.scrollToContent(undefined, { animate: false })
      } catch (err) {
        loadFailed(err)
      }
      baseline.current = hashElementsVersion(api.getSceneElementsIncludingDeleted())
      evaluate(api.getSceneElementsIncludingDeleted())
      flushMessages(api)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- save ------------------------------------------------------------------
  const save = useCallback(async ({ saveAs }: { saveAs: boolean }) => {
    const api = apiRef.current
    if (!api || saving.current) return
    saving.current = true
    const version = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    try {
      const result = await sketchbook.save(serialize(api), {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
  }, [])

  useEffect(() => cancelAutosave, [])

  return { initialData, name, setApi, onChange, save }
}
