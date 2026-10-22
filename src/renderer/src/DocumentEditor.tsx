// One tab's drawing: an Excalidraw instance plus its document lifecycle.
//
// Several of these stay mounted at once (see App). Inactive ones are hidden with
// `visibility: hidden` rather than `display: none`, so their canvas keeps its size
// and is correct the instant the tab is shown again (no resize / refresh needed).
//
// Keyboard isolation: Excalidraw is left at `handleKeyboardGlobally={false}` (its
// default), so it only handles keydown events that reach its own container. Only the
// active editor's container is focusable/visible, and App focuses it on activation.
// Clipboard (copy/cut/paste) handlers are bound on `document` but each instance
// ignores events unless `document.activeElement` is inside its own container.

import { memo, useCallback, useEffect, useRef } from 'react'
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
import type { EditorEvents, EditorHandle, EditorInit } from './tabs'
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

// Open http(s) element links in the system browser rather than a new Electron window.
function onLinkOpen(
  element: NonDeletedExcalidrawElement,
  event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>
): void {
  const link = element.link
  if (link && /^https?:\/\//i.test(link)) {
    event.preventDefault()
    bridge.openExternal(link)
  }
}

type BodyProps = {
  doc: DocPayload
  init: EditorInit | undefined
  /** The tab's display name (default file name for image exports). */
  name: string
  /** Only read at mount (focus on open). */
  autoFocus: boolean
  theme: Theme
  themePreference: ThemePreference
  events: EditorEvents
  containerRef: React.RefObject<HTMLDivElement | null>
}

/** The Excalidraw tree. Memoized: it does not depend on whether the tab is active. */
const EditorBody = memo(function EditorBody({
  doc,
  init,
  name,
  autoFocus,
  theme,
  themePreference,
  events,
  containerRef
}: BodyProps): React.JSX.Element {
  const { docId } = doc
  const editor = useDocument(doc, init, events)
  const lastEditorTheme = useRef(theme)

  // App calls the handle long after render; route it to this render's closures.
  const latest = useRef(editor)
  latest.current = editor
  const themeRef = useRef(theme)
  themeRef.current = theme

  const onSave = useCallback(() => void latest.current.save({ saveAs: false }), [])
  const onSaveAs = useCallback(() => void latest.current.save({ saveAs: true }), [])

  useEffect(() => {
    const menu = (action: MenuAction): void => {
      const openDialog = (dialog: AppState['openDialog']): void =>
        latest.current.getApi()?.updateScene({ appState: { openDialog: dialog } })
      switch (action) {
        case 'save':
          return onSave()
        case 'save-as':
          return onSaveAs()
        case 'export-image':
          return openDialog({ name: 'imageExport' })
        case 'mermaid':
          return openDialog({ name: 'ttd', tab: 'mermaid' })
      }
    }
    const handle: EditorHandle = {
      save: (opts) => latest.current.save(opts),
      snapshot: () => latest.current.snapshot(),
      menu,
      focus: () => {
        const el = containerRef.current?.querySelector<HTMLElement>('.excalidraw-container')
        if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
      },
      getApi: () => latest.current.getApi()
    }
    events.register(docId, handle)
    return () => events.register(docId, null)
  }, [docId, events, onSave, onSaveAs, containerRef])

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState): void => {
      latest.current.onChange(elements, appState)
      // Theme can also change via Excalidraw's own shortcut (Alt+Shift+D). Adopt it as a
      // manual choice, but only when the editor's theme itself changed: right after the
      // `theme` prop changes, onChange still reports the old theme for one tick.
      if (appState.theme !== lastEditorTheme.current) {
        lastEditorTheme.current = appState.theme
        if (appState.theme !== themeRef.current) events.onThemePreferenceChange(appState.theme)
      }
    },
    [events]
  )

  const onLibraryChange = useCallback(
    (items: LibraryItems) => events.onLibraryChange(docId, items),
    [docId, events]
  )

  return (
    <Excalidraw
      excalidrawAPI={editor.setApi}
      initialData={editor.initialData}
      onChange={onChange}
      onLibraryChange={onLibraryChange}
      onLinkOpen={onLinkOpen}
      name={name}
      theme={theme}
      autoFocus={autoFocus}
      aiEnabled={false}
      UIOptions={UI_OPTIONS}
    >
      <AppMainMenu
        onSave={onSave}
        onSaveAs={onSaveAs}
        theme={themePreference}
        onThemeChange={events.onThemePreferenceChange}
      />
      <AppWelcomeScreen />
    </Excalidraw>
  )
})

type Props = Omit<BodyProps, 'containerRef' | 'autoFocus'> & {
  /** The visible tab. Toggling this re-renders only the wrapper, not Excalidraw. */
  active: boolean
}

export const DocumentEditor = memo(function DocumentEditor({
  active,
  ...body
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Focus on mount only if this tab opens as the active one.
  const autoFocus = useRef(active).current
  return (
    <div
      ref={containerRef}
      data-doc-id={body.doc.docId}
      className={`sketchbook-editor${active ? ' sketchbook-editor--active' : ''}`}
      // Hidden editors are inert: no focus, no pointer events, not in the a11y tree.
      inert={!active}
      aria-hidden={!active}
    >
      <EditorBody {...body} autoFocus={autoFocus} containerRef={containerRef} />
    </div>
  )
})
