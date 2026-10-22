// The window's title bar: macOS traffic-light inset, one tab per document, a "+"
// button, and empty space that drags the window (and zooms on double-click, which
// `-webkit-app-region: drag` gets from macOS for free).
//
// Its background is painted with the active drawing's canvas colour — through the
// same dark-mode filter Excalidraw applies to its canvas — so strip and canvas read
// as one surface with no seam.

import { memo, useEffect, useRef, useState } from 'react'
import type { Theme } from '@excalidraw/excalidraw/element/types'
import { TAB_STRIP_HEIGHT, TRAFFIC_LIGHT_INSET } from '../../../shared/chrome'

export type TabInfo = {
  docId: string
  title: string
  /** Tooltip: the full path, or the title for untitled docs. */
  tooltip: string
  dirty: boolean
}

type Props = {
  tabs: TabInfo[]
  activeId: string | null
  fullScreen: boolean
  theme: Theme
  /** The active drawing's `viewBackgroundColor`. */
  background: string
  onActivate: (docId: string) => void
  onClose: (docId: string) => void
  onNewTab: () => void
  onReorder: (docId: string, targetId: string, after: boolean) => void
  /** Double-click a tab title to rename the drawing. */
  onRename: (docId: string, name: string) => void
  /** Return keyboard focus to the active editor after a click in the strip. */
  onRefocus: () => void
}

const DND_TYPE = 'application/x-sketchbook-tab'

export const TabStrip = memo(function TabStrip({
  tabs,
  activeId,
  fullScreen,
  theme,
  background,
  onActivate,
  onClose,
  onNewTab,
  onReorder,
  onRename,
  onRefocus
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  // The edit being finished; guards against the blur fired when the input unmounts
  // (after Enter/Escape) committing a second time.
  const finishing = useRef<string | null>(null)

  const startRename = (docId: string): void => {
    finishing.current = null
    setEditingId(docId)
  }

  const finishRename = (docId: string, value: string | null): void => {
    if (finishing.current === docId) return
    finishing.current = docId
    setEditingId(null)
    const tab = tabs.find((t) => t.docId === docId)
    const name = value?.trim()
    if (tab && name && name !== tab.title) onRename(docId, name)
    onRefocus()
  }

  // Keep the active tab visible when it changes or the tab set changes.
  useEffect(() => {
    if (!activeId) return
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-doc-id="${CSS.escape(activeId)}"]`
    )
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  // Vertical wheel scrolls the strip sideways when tabs overflow.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      if (el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Fade the edges that have tabs scrolled out of view (set on the DOM directly:
  // scrolling must not re-render the strip).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => {
      el.dataset.fadeStart = String(el.scrollLeft > 1)
      el.dataset.fadeEnd = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [tabs.length])

  const endDrag = (): void => {
    setDragId(null)
    setDropHint(null)
  }

  return (
    <div
      className={`sketchbook-tabstrip sketchbook-tabstrip--${theme}`}
      style={{
        height: TAB_STRIP_HEIGHT,
        paddingLeft: fullScreen ? 8 : TRAFFIC_LIGHT_INSET
      }}
    >
      <div
        className="sketchbook-tabstrip__bg"
        style={{ backgroundColor: background }}
        aria-hidden
      />
      <div className="sketchbook-tabstrip__tabs" ref={scrollRef} role="tablist">
        {tabs.map((tab) => {
          const active = tab.docId === activeId
          const hint = dropHint?.id === tab.docId ? dropHint : null
          const editing = editingId === tab.docId
          return (
            <div
              key={tab.docId}
              data-doc-id={tab.docId}
              role="tab"
              aria-selected={active}
              title={tab.tooltip}
              draggable={!editing}
              className={[
                'sketchbook-tab',
                active && 'sketchbook-tab--active',
                tab.dirty && 'sketchbook-tab--dirty',
                dragId === tab.docId && 'sketchbook-tab--dragging',
                hint && (hint.after ? 'sketchbook-tab--drop-after' : 'sketchbook-tab--drop-before'),
                editing && 'sketchbook-tab--editing'
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseDown={(e) => {
                if (e.button === 0) onActivate(tab.docId)
                // Middle button: no autoscroll cursor.
                if (e.button === 1) e.preventDefault()
              }}
              onMouseUp={(e) => {
                if (e.button === 0 && !editing) onRefocus()
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.docId)
                }
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_TYPE, tab.docId)
                e.dataTransfer.effectAllowed = 'move'
                setDragId(tab.docId)
              }}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(DND_TYPE)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientX > rect.left + rect.width / 2
                if (dropHint?.id !== tab.docId || dropHint.after !== after) {
                  setDropHint({ id: tab.docId, after })
                }
              }}
              onDragLeave={() => {
                if (dropHint?.id === tab.docId) setDropHint(null)
              }}
              onDrop={(e) => {
                const from = e.dataTransfer.getData(DND_TYPE)
                e.preventDefault()
                if (from && hint && from !== tab.docId) onReorder(from, tab.docId, hint.after)
                endDrag()
              }}
              onDragEnd={endDrag}
            >
              {editing ? (
                <input
                  className="sketchbook-tab__rename"
                  aria-label="Rename drawing"
                  defaultValue={tab.title}
                  autoFocus
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // Keep typing out of Excalidraw's and the app's shortcut handlers.
                    e.stopPropagation()
                    if (e.key === 'Enter') finishRename(tab.docId, e.currentTarget.value)
                    else if (e.key === 'Escape') finishRename(tab.docId, null)
                  }}
                  onBlur={(e) => finishRename(tab.docId, e.currentTarget.value)}
                />
              ) : (
                <span
                  className="sketchbook-tab__title"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startRename(tab.docId)
                  }}
                >
                  {tab.title}
                </span>
              )}
              <button
                type="button"
                className="sketchbook-tab__close"
                aria-label={`Close ${tab.title}`}
                title={tab.dirty ? 'Unsaved changes — close' : 'Close tab'}
                tabIndex={-1}
                draggable={false}
                onMouseDown={(e) => {
                  // Don't activate the tab (or steal focus) just to close it.
                  e.stopPropagation()
                  e.preventDefault()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.docId)
                }}
              >
                <span className="sketchbook-tab__dot" aria-hidden />
                <svg className="sketchbook-tab__x" viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M4.5 4.5l7 7m0-7l-7 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="sketchbook-tabstrip__new"
        aria-label="New tab"
        title="New tab"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNewTab}
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <path
            d="M8 3.5v9m-4.5-4.5h9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <div className="sketchbook-tabstrip__drag" />
    </div>
  )
})
