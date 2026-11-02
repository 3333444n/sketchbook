// Build-time constants injected by `define` in electron.vite.config.ts
// (main and src/mcp bundles). Not available in Vitest; tests must not read them.

/** package.json `version` at build time. */
declare const __SKETCHBOOK_VERSION__: string
