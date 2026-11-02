# Status and roadmap

## Where things stand

- **v1.1.0** was released on 2026-11-02:
  <https://github.com/3333444n/sketchbook/releases/tag/v1.1.0> (ad-hoc-signed arm64 dmg). It
  adds the agent bridge below.
- **v1.0.0** was released on 2026-10-22:
  <https://github.com/3333444n/sketchbook/releases/tag/v1.0.0> (ad-hoc-signed arm64 dmg).
- Shipped: offline Excalidraw editor, real `.excalidraw` files, tabs (MRU budget of 5 mounted
  editors) and multiple windows, frameless window with the traffic lights in the tab strip,
  double-click to rename a tab, crash-recovery journal, PNG/SVG export with embedded scene,
  Mermaid to diagram, Open Recent, Finder file association, light/dark/system theme.
- Automated checks: typecheck, lint, Vitest unit tests and Playwright e2e (offline, documents,
  tabs, rename, export, packaged smoke test) all pass locally. CI runs typecheck, unit tests
  and the build, and packages the dmg on `v*` tags.
- **The agent bridge** (shipped in v1.1.0): an opt-in Unix socket plus a
  bundled MCP server so local agents (Claude Code, Claude Desktop, Cursor, Codex) can read and
  edit the open drawing and get a PNG back ([agent-bridge.md](agent-bridge.md),
  [ADR 0009](adr/0009-agent-bridge-unix-socket-mcp.md)). Verified by unit tests on every
  side (settings, socket server, config snippets, scene helpers, MCP server and client), the
  e2e agent spec, the packaged MCP smoke test ([testing.md](testing.md)) and one manual
  Claude Code session against the app with all eight tools (a login mockup and a user flow
  were drawn; it found the bound-label bug fixed in `update_elements`).

### Not verified by automation

These were checked by hand at most, or not at all. Re-check them when touching the related code:

- Traffic-light placement and the tab strip's double-click-to-zoom.
- Menu accelerators firing exactly once (not also in Excalidraw).
- Double-clicking a `.excalidraw` file in Finder (cold start and while running).
- Close/quit prompts on dirty tabs, switching past the 5-editor budget, and recovery after a
  crash (listed in [testing.md](testing.md#manual-checklist-before-a-release)).
- Agent bridge: a session with a real MCP client is a manual check (done once with Claude
  Code; repeat it before a release, see the
  [manual checklist](testing.md#manual-checklist-before-a-release)). Undo per call, the
  dirty marker, labels following their container, eviction, both menu toggles, persistence
  across relaunch and the stdio MCP server are covered by `tests/e2e/agent.spec.ts` and
  `packaged.spec.ts`.

## Ideas for next iterations

Not committed to; roughly in order of value.

### Updates

There is no update mechanism today ([building-and-releasing.md](building-and-releasing.md#updates)).
Options:

1. **"Check for Updates…" menu item that opens the Releases page** in the browser via
   `shell.openExternal`. No network from the app; fits the offline rules as they stand.
2. **On-demand version check**: on that menu click only, fetch the latest release from the
   GitHub API, compare with `app.getVersion()`, and offer to open the download page. Never
   runs in the background. This needs an exception to "no update checks" in
   [offline.md](offline.md) and AGENTS.md, a narrow allow-rule in the main-process network
   block, and an ADR. Recommended option.
3. **Real auto-update** (`electron-updater` / Squirrel.Mac). On macOS this requires a
   Developer ID signature, so it depends on the signing item below; also needs a `zip` target
   and a background network call.

### Other

- **Developer ID signing and notarization**, to remove the Gatekeeper step
  ([building-and-releasing.md](building-and-releasing.md#future-developer-id-signing-and-notarization)).
- **Intel / universal builds.**
- **CI coverage:** run `pnpm lint` and the e2e suite in CI (neither runs there yet).
- **More e2e tests** for the gaps listed above (close/quit prompts, eviction, crash recovery).
- **Keep undo history across eviction**, or make the budget configurable (measure first; see
  [performance.md](performance.md)).
- **Agent bridge follow-ups:** let agents add images (today `image` needs a `fileId` already
  in the drawing), a per-connection approval or activity indicator in the tab strip, a
  `get_image` of just the viewport, and reporting the "Untitled N" number in `list_drawings`
  (the tab strip numbers untitled tabs in the renderer; main's `docTitle` says "Untitled" for
  all of them). Each is a new validated surface; see
  [ADR 0009](adr/0009-agent-bridge-unix-socket-mcp.md). The bridge's paths are macOS-only
  (`~/Library/Application Support`, `Contents/Resources`, `sun_path`); they would need
  porting with the rest of the app if Windows or Linux ever happen. Notarization is
  unchanged by the bridge: the MCP server runs the app's own ad-hoc-signed binary.
