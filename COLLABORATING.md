# Collaborating on Sketchbook

Welcome, and thanks for your interest. Sketchbook is a small, focused project: an offline
macOS whiteboard built on the [Excalidraw](https://github.com/excalidraw/excalidraw) component.
This guide covers how to get set up and how changes land.

If you're an AI coding agent, read [AGENTS.md](AGENTS.md) instead (or as well).

## Prerequisites

- macOS on Apple Silicon (the only build target today)
- Node 24
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`'s `packageManager`,
  or `npm i -g pnpm@10`)
- Git

## Setup

```bash
git clone https://github.com/3333444n/sketchbook.git
cd sketchbook
pnpm i
pnpm dev
```

## Dev loop

| Command                     | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`                  | Launches the app with hot reload for the renderer; main/preload rebuild and restart. |
| `pnpm typecheck`            | Type-checks node (main, preload, shared) and web (renderer) projects.                |
| `pnpm test`                 | Vitest unit tests (`src/**/__tests__/**/*.test.ts`).                                 |
| `pnpm test:e2e`             | Builds, then runs the Playwright `_electron` e2e suite against the production app.   |
| `pnpm lint` / `pnpm format` | ESLint / Prettier.                                                                   |
| `pnpm build:mac`            | Builds an ad-hoc-signed arm64 dmg into `dist/`.                                      |
| `pnpm screenshots`          | Builds, then regenerates the README images in `docs/images/`.                        |

### Debugging

- **Renderer:** View → Toggle Developer Tools (⌥⌘I). Check the console for CSP violations
  when something fails to load.
- **Main process:** `console.log` output from `src/main/*` appears in the terminal running
  `pnpm dev`. For the packaged app, run the binary from a terminal to see logs:
  `/Applications/Sketchbook.app/Contents/MacOS/Sketchbook`.
- **Breakpoints in main:** `.vscode/launch.json` contains debug configurations.
- **Recovery journals** live in `~/Library/Application Support/<app name>/recovery/`. Delete
  them to reset a stuck recovery state.

## Project structure

```
src/
  shared/ipc.ts      IPC contract shared by all layers
  main/              Electron main process (windows, files, menu, recovery, protocol)
  preload/           contextBridge API (window.sketchbook)
  renderer/          React app embedding Excalidraw
tests/e2e/           Playwright _electron end-to-end tests
scripts/             Icon and README-screenshot generators
docs/                Architecture, IPC, offline, performance, testing, releasing, ADRs
build/               Icons and entitlements for electron-builder
```

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Branching and commits

- `main` is always releasable. Work on feature branches (`feat/tab-drag`, `fix/save-dialog`)
  and open a pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `chore: ...`, `build: ...`, `ci: ...`.
  Add `!` for breaking changes (for example an incompatible IPC contract change).
- Keep PRs small and about one thing.

## Proposing a change

1. **Open an issue** describing the problem or idea before writing a large change.
2. **If it's architectural** (new process, IPC shape, storage format, security posture,
   offline guarantees, dependencies with a large footprint), write an ADR in
   [docs/adr/](docs/adr/README.md) and link it from the PR.
3. Open a PR that references the issue.

## PR checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] e2e passes locally when the change touches files, windows, tabs or offline behaviour
- [ ] No new network requests (see [docs/offline.md](docs/offline.md))
- [ ] IPC changes start in `src/shared/ipc.ts` and update preload, main, renderer and
      [docs/ipc-contract.md](docs/ipc-contract.md) together
- [ ] Docs and ADRs updated where behaviour or architecture changed
- [ ] `pnpm screenshots` re-run if the change visibly alters the UI shown in the README
- [ ] Manually tested in `pnpm dev` (and in a packaged build for packaging changes)

The same list is in [.github/pull_request_template.md](.github/pull_request_template.md).

## Coding style

- Prettier (`.prettierrc.yaml`: single quotes, no semicolons, 100 columns, no trailing commas)
  and ESLint (`eslint.config.mjs`) are configured. Run `pnpm format` and `pnpm lint`.
- TypeScript everywhere; avoid `any`. Validate untrusted input (IPC arguments, file contents).
- Keep `src/main/fileio.ts`, `src/main/recovery.ts` and `src/main/registry.ts` free of `electron` imports so they stay
  unit-testable.
- Comments explain _why_, not _what_.

## Testing expectations

- New pure logic in main gets Vitest unit tests.
- New user-visible flows (file IO, tabs, close/quit, export) get an e2e test.
- Bug fixes come with a test that fails without the fix when practical.

Details: [docs/testing.md](docs/testing.md).

## Releasing

Maintainers only. Full steps in [docs/building-and-releasing.md](docs/building-and-releasing.md).

1. Bump `version` in `package.json` and commit (`chore: release vX.Y.Z`).
2. Tag `vX.Y.Z` and push the tag. CI builds the dmg and uploads it as a workflow artifact.
3. Or build locally with `pnpm build:mac`.
4. Create a GitHub Release for the tag and attach the dmg.
5. The dmg is **ad-hoc signed, not notarized**. Release notes must tell users how to open it
   (System Settings → Privacy & Security → "Open Anyway", or `xattr -cr /Applications/Sketchbook.app`).

## Bugs and feature requests

Use the [issue templates](https://github.com/3333444n/sketchbook/issues/new/choose). For bugs,
include the Sketchbook version, macOS version, steps to reproduce, and a sample `.excalidraw`
file if possible. Drawing-engine bugs that also reproduce on excalidraw.com belong upstream at
[excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/issues).

Security issues: **don't open a public issue.** See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree
to uphold it.
