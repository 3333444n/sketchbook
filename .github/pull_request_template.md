## What and why

<!-- What does this change, and why? Link the issue: "Closes #123". -->

## How I tested it

<!-- Commands run, manual steps, screenshots for UI changes. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] e2e passes locally if this touches files, windows, tabs or offline behaviour
- [ ] No new network requests ([docs/offline.md](https://github.com/3333444n/sketchbook/blob/main/docs/offline.md))
- [ ] IPC changes start in `src/shared/ipc.ts` and update preload, main, renderer and `docs/ipc-contract.md` together
- [ ] Main never writes to a renderer-supplied path
- [ ] Docs updated; ADR added for architectural changes ([docs/adr/](https://github.com/3333444n/sketchbook/blob/main/docs/adr/README.md))
- [ ] `pnpm screenshots` re-run if the README images no longer match the UI
- [ ] Commit messages follow Conventional Commits
