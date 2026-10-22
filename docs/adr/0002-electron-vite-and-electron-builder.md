# 0002. Build with electron-vite and package with electron-builder

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

An Electron app has three build targets (main, preload, renderer) with different
environments: Node for main, a sandboxed preload, and a browser for the renderer. We need a
fast dev loop with hot reload, TypeScript everywhere, React for the renderer, and a macOS dmg
with a file association.

Alternatives: hand-rolled Vite or webpack configs per target; Electron Forge (with its Vite
plugin); electron-builder vs Forge makers for packaging.

## Decision

We will use **electron-vite 6** (scaffolded from the `@quick-start/electron` react-ts
template) to build main, preload and renderer from one config
([`electron.vite.config.ts`](../../electron.vite.config.ts)), and **electron-builder 26**
([`electron-builder.yml`](../../electron-builder.yml)) to produce an ad-hoc-signed arm64 dmg.
Package manager is pnpm, runtime Node 24, Electron pinned to an exact version (44.9.3).

## Consequences

- One config, Vite speed, HMR in the renderer and automatic restarts for main and preload.
- electron-builder handles dmg layout, icons, `fileAssociations` and signing options
  declaratively, and leaves room for Developer ID signing and notarization later.
- Two tools to keep current, and electron-vite releases track Vite majors.
- Pinning Electron exactly means upgrades are deliberate; we test them rather than drift.
