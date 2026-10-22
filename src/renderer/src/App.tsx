import { useCallback, useEffect, useRef } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement
} from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { MenuAction } from '../../shared/ipc'
import '@excalidraw/excalidraw/index.css'
import './app.css'
import { AppMainMenu } from './components/AppMainMenu'
import { AppWelcomeScreen } from './components/AppWelcomeScreen'
import { saveLibrary } from './library'
import { useMenuOwnedShortcuts } from './shortcuts'
import { useTheme } from './theme'
import { useDocument } from './useDocument'

const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false as const }
}

function App(): React.JSX.Element {
  const doc = useDocument()
  const { preference, theme, setPreference } = useTheme()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const lastEditorTheme = useRef(theme)
  useMenuOwnedShortcuts()

  const { setApi, save, onChange: onDocChange } = doc
  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api
      setApi(api)
    },
    [setApi]
  )

  const onSave = useCallback(() => void save({ saveAs: false }), [save])
  const onSaveAs = useCallback(() => void save({ saveAs: true }), [save])

  // Native menu actions arrive from main.
  useEffect(() => {
    const openDialog = (dialog: AppState['openDialog']): void =>
      apiRef.current?.updateScene({ appState: { openDialog: dialog } })

    return window.sketchbook.onMenu((action: MenuAction) => {
      switch (action) {
        case 'save':
        case 'save-and-close': // main closes the window once the save succeeds
          return onSave()
        case 'save-as':
          return onSaveAs()
        case 'export-image':
          return openDialog({ name: 'imageExport' })
        case 'mermaid':
          return openDialog({ name: 'ttd', tab: 'mermaid' })
        case 'new':
          return window.sketchbook.newWindow()
        case 'open':
          return window.sketchbook.open()
      }
    })
  }, [onSave, onSaveAs])

  const onChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles
  ): void => {
    onDocChange(elements, appState, files)
    // Theme can also change via Excalidraw's own shortcut (Alt+Shift+D). Adopt it as a
    // manual choice, but only when the editor's theme itself changed: right after the
    // `theme` prop changes, onChange still reports the old theme for one tick.
    if (appState.theme !== lastEditorTheme.current) {
      lastEditorTheme.current = appState.theme
      if (appState.theme !== theme) setPreference(appState.theme)
    }
  }

  // Open http(s) element links in the system browser rather than a new Electron window.
  const onLinkOpen = (
    element: NonDeletedExcalidrawElement,
    event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>
  ): void => {
    const link = element.link
    if (link && /^https?:\/\//i.test(link)) {
      event.preventDefault()
      window.sketchbook.openExternal(link)
    }
  }

  return (
    <div className="sketchbook-app">
      <Excalidraw
        excalidrawAPI={handleApi}
        initialData={doc.initialData}
        onChange={onChange}
        onLibraryChange={saveLibrary}
        onLinkOpen={onLinkOpen}
        name={doc.name}
        theme={theme}
        aiEnabled={false}
        UIOptions={UI_OPTIONS}
      >
        <AppMainMenu
          onSave={onSave}
          onSaveAs={onSaveAs}
          theme={preference}
          onThemeChange={setPreference}
        />
        <AppWelcomeScreen />
      </Excalidraw>
    </div>
  )
}

export default App
