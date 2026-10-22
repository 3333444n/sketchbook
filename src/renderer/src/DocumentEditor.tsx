// One drawing: an Excalidraw instance plus its document lifecycle. Self-contained
// so a window can later host several of these (tabs), with only the active one
// receiving menu actions.

import { useCallback, useEffect, useEffectEvent, useRef } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
  Theme
} from '@excalidraw/excalidraw/element/types'
import type { AppState, LibraryItems } from '@excalidraw/excalidraw/types'
import type { DocPayload, MenuAction } from '../../shared/ipc'
import { bridge } from './bridge'
import { AppMainMenu } from './components/AppMainMenu'
import { AppWelcomeScreen } from './components/AppWelcomeScreen'
import type { ThemePreference } from './theme'
import { useDocument } from './useDocument'

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false as const,
    // Excalidraw hides its theme toggle when the `theme` prop is controlled unless forced on.
    toggleTheme: true
  }
}

type Props = {
  doc: DocPayload
  /** Only the active editor responds to menu actions. */
  active: boolean
  theme: Theme
  themePreference: ThemePreference
  onThemePreferenceChange: (pref: ThemePreference) => void
  /** Read when the editor mounts, so each new editor starts with the latest library. */
  getInitialLibrary: () => LibraryItems
  onLibraryChange: (items: LibraryItems) => void
}

export function DocumentEditor({
  doc,
  active,
  theme,
  themePreference,
  onThemePreferenceChange,
  getInitialLibrary,
  onLibraryChange
}: Props): React.JSX.Element {
  const editor = useDocument(doc, getInitialLibrary)
  const { save, getApi } = editor
  const lastEditorTheme = useRef(theme)

  const onSave = useCallback(() => void save({ saveAs: false }), [save])
  const onSaveAs = useCallback(() => void save({ saveAs: true }), [save])

  const handleMenu = useEffectEvent((action: MenuAction) => {
    const openDialog = (dialog: AppState['openDialog']): void =>
      getApi()?.updateScene({ appState: { openDialog: dialog } })
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
      // Main handles these natively; forward if they ever arrive here.
      case 'new':
        return bridge.newWindow()
      case 'open':
        return bridge.open()
    }
  })

  useEffect(() => {
    if (!active) return
    return bridge.onMenu((action) => handleMenu(action))
  }, [active])

  const onChange = (elements: readonly ExcalidrawElement[], appState: AppState): void => {
    editor.onChange(elements, appState)
    // Theme can also change via Excalidraw's own shortcut (Alt+Shift+D). Adopt it as a
    // manual choice, but only when the editor's theme itself changed: right after the
    // `theme` prop changes, onChange still reports the old theme for one tick.
    if (appState.theme !== lastEditorTheme.current) {
      lastEditorTheme.current = appState.theme
      if (appState.theme !== theme) onThemePreferenceChange(appState.theme)
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
      bridge.openExternal(link)
    }
  }

  return (
    <Excalidraw
      excalidrawAPI={editor.setApi}
      initialData={editor.initialData}
      onChange={onChange}
      onLibraryChange={onLibraryChange}
      onLinkOpen={onLinkOpen}
      name={editor.name}
      theme={theme}
      aiEnabled={false}
      UIOptions={UI_OPTIONS}
    >
      <AppMainMenu
        onSave={onSave}
        onSaveAs={onSaveAs}
        theme={themePreference}
        onThemeChange={onThemePreferenceChange}
      />
      <AppWelcomeScreen />
    </Excalidraw>
  )
}
