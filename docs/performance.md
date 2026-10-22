# Performance: tabs and the editor budget

Decision record: [ADR 0006](adr/0006-tabs-with-mru-editor-budget.md).

## The model

- **One renderer process per window.** All tabs in a window live in the same page. No
  `WebContentsView` per tab.
- **At most 5 mounted Excalidraw editors per window**, chosen by most recent use (MRU).
- **Inactive mounted editors** stay mounted but hidden. They don't receive keyboard or menu
  actions, and don't render while hidden.
- **Evicted tabs** (beyond the 5 most recently used) are unmounted. Before unmounting, the
  editor's scene is snapshotted to JSON (`serializeAsJSON`) and kept in memory. Activating the
  tab remounts an editor from that snapshot.

| Tab state          | Excalidraw mounted | Switch cost                    | Undo history |
| ------------------ | ------------------ | ------------------------------ | ------------ |
| Active             | yes, visible       | n/a                            | kept         |
| Recent (top 5 MRU) | yes, hidden        | instant                        | kept         |
| Evicted            | no, JSON snapshot  | remount (parse + first render) | **lost**     |

Dirty state, path and the recovery journal are unaffected by eviction: main owns them, and
the snapshot carries the latest scene.

## Why 5

Each mounted editor holds its own scene, caches, canvases and React tree. Mounting every
tab makes memory and change-handling cost grow with the tab count. One process per tab is
far heavier still (100+ MB each). Five keeps switching between the tabs you're actually using
instant, while bounding memory. It's a constant; change it only with measurements.

## Measured

Production build (v1.0.0) on Apple Silicon, one window, 8 documents of 300 shapes each, heap
read after a forced GC:

| Scenario                                         | Result         |
| ------------------------------------------------ | -------------- |
| JS heap, 1 tab open                              | 14 MB          |
| JS heap, 8 tabs open (5 mounted, 3 evicted)      | 19 MB          |
| Switch to a mounted (hidden) tab                 | about 25–33 ms |
| Switch to an evicted tab (remount from snapshot) | about 33 ms    |

Switch times run from the click until two `requestAnimationFrame` callbacks have fired, so
they include the first painted frame. Eight tabs cost about 5 MB of heap over one, and an
evicted tab comes back about as fast as a mounted one at this drawing size; the budget is
there to bound memory as tab counts and drawings grow.

## Rules for contributors

- Per-document state belongs in `DocumentEditor` / `useDocument`. No global per-scene state.
- Anything that runs on Excalidraw's `onChange` runs for every edit. Keep it cheap and
  debounced (autosave is debounced to 1 s).
- Hidden editors must not handle keys: check the `active` prop before acting on keyboard or
  menu events.
- Eviction must snapshot first. Never unmount an editor whose latest scene isn't captured.

## Measuring

Use a production build (`pnpm build:unpack` then run the app in `dist/mac-arm64/`); dev mode
with React StrictMode and HMR is not representative.

- **Memory per window:** Activity Monitor → Memory, or `ps -o rss,command -ax | grep -i sketchbook`.
  The renderer is the "Helper (Renderer)" process. Compare 1, 5 and 20 tabs with a medium
  drawing (a few hundred elements) in each.
- **Heap:** DevTools (⌥⌘I) → Memory → heap snapshot after opening tabs; check that evicted
  tabs leave no detached Excalidraw trees.
- **Tab switch time:** DevTools → Performance, record a switch to a hidden tab and to an
  evicted tab. Hidden should be a frame or two; evicted is dominated by scene restore.
- **Typing/drawing latency:** Performance panel while drawing with 5 mounted editors; hidden
  editors should show no work.

Record numbers in the PR description when changing the budget or the eviction logic.
