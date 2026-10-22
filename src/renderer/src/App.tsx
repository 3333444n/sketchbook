// Window shell: fetches the window's document and hosts its editor. App-level
// concerns (theme, shape library, menu-owned shortcuts) live here and are shared
// by every editor.

import { useCallback, useEffect, useState } from 'react'
import '@excalidraw/excalidraw/index.css'
import './app.css'
import type { DocPayload } from '../../shared/ipc'
import { bridge } from './bridge'
import { DocumentEditor } from './DocumentEditor'
import { loadLibrary, saveLibrary } from './library'
import { useMenuOwnedShortcuts } from './shortcuts'
import { useTheme } from './theme'

function App(): React.JSX.Element {
  // `load` counts documents shown in this window: main reuses the docId when it pushes a
  // file into an empty window, and each load must get a fresh editor.
  const [current, setCurrent] = useState<{ doc: DocPayload; load: number } | null>(null)
  const show = useCallback(
    (doc: DocPayload) => setCurrent((prev) => ({ doc, load: (prev?.load ?? 0) + 1 })),
    []
  )
  const { preference, theme, setPreference } = useTheme()
  useMenuOwnedShortcuts()

  useEffect(() => {
    let cancelled = false
    // A doc pushed by main before this resolves wins over the initial one.
    const showInitial = (doc: DocPayload): void => {
      if (!cancelled) setCurrent((prev) => prev ?? { doc, load: 1 })
    }
    bridge.getInitialDoc().then(showInitial, (err) => {
      console.error('getInitialDoc failed', err)
      showInitial({ docId: 'untitled', path: null, contents: null })
    })
    // Main pushes a document into this (empty) window: show it in a fresh editor.
    const unsubscribe = bridge.onLoadDoc(show)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [show])

  return (
    <div className={`sketchbook-app sketchbook-app--${theme}`}>
      {current && (
        <DocumentEditor
          key={current.load}
          doc={current.doc}
          active
          theme={theme}
          themePreference={preference}
          onThemePreferenceChange={setPreference}
          getInitialLibrary={loadLibrary}
          onLibraryChange={saveLibrary}
        />
      )}
    </div>
  )
}

export default App
