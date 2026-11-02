# 0009. Local agent bridge over a Unix socket with a bundled MCP server

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Users want to tell an AI coding agent (Claude Code, Claude Desktop, Cursor, Codex) to draw or
tweak a diagram in the tab they are looking at, watch it happen, and let the agent look at the
result. Sketchbook's own rules constrain how: the app makes no network requests
([ADR 0003](0003-app-protocol-and-bundled-fonts.md), [offline.md](../offline.md)), the
renderer never supplies file paths and main validates every message
([ADR 0004](0004-native-dialogs-and-atomic-writes.md)), and per-document state stays inside
one editor among several mounted ones ([ADR 0006](0006-tabs-with-mru-editor-budget.md)).

The agent runs as a separate process the user already trusts with their files, on the same
machine, as the same user. The de-facto way those agents talk to tools is the Model Context
Protocol over stdio: the client spawns a server process and exchanges JSON-RPC on its pipes.
That server needs a way into the running app, and the app needs to be able to say no.

Other facts that shaped the design (verified before implementation):

- A packaged Electron binary started with `ELECTRON_RUN_AS_NODE=1` behaves as plain Node: no
  GUI, no single-instance lock, `process.resourcesPath` set. The `runAsNode` fuse is on by
  default in Electron 44.
- electron-vite 6 splits runtime modules shared by two entries into `out/main/chunks/`. A
  file copied out of `out/main/` on its own cannot resolve those.
- Excalidraw 0.18.1's imperative API can replace the element list in one call with
  `captureUpdate: IMMEDIATELY`, which records one undo step and fires `onChange`.
- `exportToBlob` needs the fonts, which only the renderer has.

## Decision

We will add an **opt-in local agent bridge** to the app and ship an **MCP server** with it.

- **Opt-in, off by default.** `Agent ▸ Allow Agent Connections` toggles the bridge and persists
  the choice in `userData/settings.json` (`allowAgentConnections`). Nothing listens until the
  user turns it on; turning it off closes every connection immediately.
- **Unix domain socket in `userData/agent/`.** Main listens on `agent.sock` with the directory
  at mode `0700` and the socket at `0600`, so only the same user can connect. When the
  `userData` path is too long for `sun_path`, the socket moves to a hashed name under the
  temp directory. A **pointer file** `agent.json` (`{ protocol, socketPath, version, pid }`)
  next to it tells clients where the socket is and which process owns it; both files are
  removed on stop and quit, and a stale socket from a crash is probed and replaced on start.
- **NDJSON request/response, validated in main like IPC.** One JSON object per line:
  `{ id, method, params }` in, `{ id, result }` or `{ id, error: { code, message } }` out.
  Main parses each line, checks the method against a fixed list and type-checks every
  parameter with hand-written guards and limits (frame size, element and id counts, docId
  pattern, type whitelist) before anything reaches a document. Errors have a small fixed set
  of codes. A bad line never crashes main or the connection.
- **Generic main → renderer request/response.** Main answers `listTabs` and `newDrawing`
  itself from the registry. Every per-document method is forwarded to the window that hosts
  the `docId` over two new IPC channels, `agent:request` (M→R) and `agent:response` (R→M),
  with a `requestId`, a timeout and a check that only that window may answer. The renderer
  activates the tab (remounting it if it was evicted), waits for its editor to be ready, runs
  one operation at a time per document and answers exactly once.
- **The renderer applies edits through the Excalidraw API as single undo steps.** Add,
  update and delete each end in one `updateScene({ captureUpdate: IMMEDIATELY })`, so an agent
  call undoes with one ⌘Z, marks the tab dirty and is autosaved to the recovery journal like a
  user edit. The user's file still only changes on ⌘S. Images are rendered in the renderer
  with `exportToBlob` and returned as PNG.
- **A bundled stdio MCP server.** `src/mcp/` is built as a second electron-vite entry
  (`out/main/mcp.js`) and shipped as `Contents/Resources/mcp/index.js`, outside the asar. MCP
  clients run it with the app's own binary in node mode:
  `ELECTRON_RUN_AS_NODE=1 Sketchbook.app/Contents/MacOS/Sketchbook …/Resources/mcp/index.js`.
  It exposes eight tools, finds the socket through the pointer file, opens one connection per
  call, and answers `tools/list` even when the app is closed (each call then reports
  `NOT_RUNNING` or `DISABLED` with a hint).
- **A type-only shared contract, enforced at build time.** `src/shared/agent.ts` carries the
  method, result and error types for all three sides and no runtime code. Limits are literals
  repeated on each side. A build plugin fails the build if `mcp.js` has any import other than
  Node built-ins or references `electron`, so the copied file stays self-contained.
- **The `runAsNode` fuse stays on.** `electron-builder.yml` must never set
  `electronFuses.runAsNode: false`; the MCP server depends on it.

### Alternatives considered

- **Localhost TCP with a token file.** Reachable by any local process (and, misconfigured, by
  the LAN); needs a secret to approximate what filesystem permissions give a Unix socket for
  free, and it blurs the "no network" rule.
- **Watching `.excalidraw` files on disk.** Only works for saved files, cannot target a tab,
  fights the editor over writes, breaks undo and the recovery journal, and gives the agent no
  way to see the result.
- **A separate npm package, or forking `excalidraw-app`.** A second repo to version and
  install, with a contract that drifts from the app; a fork contradicts
  [ADR 0001](0001-embed-excalidraw-in-electron.md).
- **Running the MCP server inside the Electron main process over stdio.** The app's stdio is
  owned by the launcher (Finder, `open`), and every MCP client expects to spawn its own server
  process; a long-lived GUI process cannot be that.

## Consequences

Positive:

- Any local MCP client can draw in the tab the user is looking at, read the scene and get a
  PNG back, with no network and no accounts. Setup is one copied config snippet.
- Agent edits are ordinary edits: one undo step each, dirty marker, autosave, nothing written
  to the user's file without ⌘S.
- The bridge is off until the user turns it on, and the same-user trust model matches what the
  agent already has (it can read and write the user's files regardless).
- The pure parts (`agentServer.ts`, `settings.ts`, `agentConfig.ts`, `agentScene.ts`,
  `src/mcp/`) are unit-tested in plain Node.

Negative and costs:

- A new validated input surface in main. Every method and limit must be guarded there, and the
  renderer re-validates element shapes before touching the scene.
- Same-user trust only: any process running as the user can connect while the bridge is on.
  There is no per-client authorisation or audit beyond the menu toggle.
- A per-document operation **activates that tab** in its window (without raising the window).
  An agent working on another tab switches what the user sees.
- The app grows by the self-contained MCP bundle (about 930 kB: the MCP SDK and zod), and
  `@modelcontextprotocol/server` and `zod` become runtime dependencies.
- Paths are macOS-only (`~/Library/Application Support`, `Contents/Resources`, `sun_path`
  limits), like the rest of the app.
- `agentOps.ts` uses Excalidraw internals (`convertToExcalidrawElements`, `restoreElements`,
  `newElementWith`, binding and fractional-index behaviour of `updateScene`). Re-check it on
  every Excalidraw upgrade ([upgrading-excalidraw.md](../upgrading-excalidraw.md)).
- The three sides share types but not code, so a limit changed on one side must be changed on
  the others by hand.
