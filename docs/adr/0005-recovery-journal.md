# 0005. Recovery journal instead of autosave-overwrite

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

excalidraw.com autosaves to browser storage. A desktop app working with real files has two
options for crash safety:

- **Autosave by overwriting the user's file.** Simple, but the file on disk changes without
  the user asking, experiments can't be abandoned with "Don't Save", untitled drawings have no
  file to save to, and it conflicts with the document model macOS users expect.
- **A separate recovery journal.** The user's file changes only on Save; unsaved work is
  protected elsewhere.

## Decision

We will keep a recovery journal:

- The renderer debounces scene changes (1 s) and calls `autosave(docId, contents)`.
- Main writes `userData/recovery/<docId>.json` (`{ docId, path, contents, savedAt }`)
  atomically, and only while the doc is dirty (`src/main/recovery.ts`).
- The journal is deleted after a successful save, after "Don't Save", and when a tab closes.
- At launch, leftover journals are restored as **dirty tabs** with their original path, and
  the user is told their changes were recovered.
- Corrupt journals are moved to `userData/recovery/corrupt/` so they never block startup.
- The user's file only changes on ⌘S.

## Consequences

- A crash or `kill -9` loses at most about a second of work.
- "Don't Save" means what it says.
- Recovered docs need an explicit Save to reach the original file.
- Journals hold full scene copies, including embedded images, in the user's Library folder
  until saved or discarded.
- `docId` is a filename component, so it is validated against a safe pattern.
