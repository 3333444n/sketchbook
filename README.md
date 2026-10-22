<div align="center">

# Sketchbook

**An offline desktop whiteboard, built on Excalidraw.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/3333444n/sketchbook/actions/workflows/ci.yml/badge.svg)](https://github.com/3333444n/sketchbook/actions/workflows/ci.yml)
[![Platform: macOS arm64](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey.svg)](#install)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png" />
  <img alt="Sketchbook window with three tabs open, showing a hand-drawn system architecture diagram" src="docs/images/hero-light.png" width="900" />
</picture>

</div>

## Why

Whiteboards shouldn't need Wi-Fi. Sketchbook is for sketching on a flight, on a train or
anywhere else without internet, and for keeping your drawings as files that are yours. It
wraps the [Excalidraw](https://github.com/excalidraw/excalidraw) editor in a native macOS app. Drawings are ordinary `.excalidraw` files on your disk, and the app never talks to
the network: no accounts, no sync, no telemetry.

## Features

- **Works fully offline.** Every asset, including all of Excalidraw's fonts, ships inside the
  app. It makes zero network requests, and that is enforced by a strict CSP, a main-process
  request block and an end-to-end test.
- **Real `.excalidraw` files** with native Open and Save dialogs, Finder double-click, and
  Open Recent.
- **Tabs and multiple windows.** Drag tabs to reorder them; ⌘N opens another window.
- **Crash recovery.** Unsaved changes are journaled and come back as dirty tabs after a crash.
  Your file only changes when you save.
- **PNG and SVG export** with the scene embedded, so an exported image opens again as an
  editable drawing.
- **Mermaid to diagram.** Paste a flowchart, sequence or class diagram and get editable shapes.
- **Light, dark and system theme.**
- **Keyboard shortcuts** for files and tabs, on top of all of Excalidraw's own.

## Screenshots

<table>
  <tr>
    <td width="50%"><img alt="Tab strip with an unsaved tab marked by a dot" src="docs/images/tabs.png" /><br /><sub>Tabs, with an unsaved change on "Trip ideas"</sub></td>
    <td width="50%"><img alt="Welcome screen of an empty Sketchbook tab" src="docs/images/welcome.png" /><br /><sub>A new tab</sub></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Mermaid to Excalidraw dialog converting a flowchart" src="docs/images/mermaid.png" /><br /><sub>Mermaid to diagram</sub></td>
    <td width="50%"><img alt="Image export dialog with a mind-map preview" src="docs/images/export.png" /><br /><sub>Export as PNG or SVG</sub></td>
  </tr>
</table>

The screenshots are generated from the production build with `pnpm screenshots`.

## Install

Sketchbook runs on macOS 12 or later on Apple Silicon.

1. Download `Sketchbook-<version>-arm64.dmg` from
   [Releases](https://github.com/3333444n/sketchbook/releases).
2. Open it and drag **Sketchbook** into **Applications**.

### First launch

The app is ad-hoc signed but not notarized by Apple, so macOS blocks the first launch
("Apple could not verify…"). Either:

- try to open it once, then go to **System Settings → Privacy & Security**, scroll to
  **Security** and click **Open Anyway** next to the Sketchbook message, or
- run this in Terminal:

  ```sh
  xattr -cr /Applications/Sketchbook.app
  ```

After that it opens normally. On macOS 15 and later, Control-click → Open no longer bypasses
this check.

## Build from source

Requires macOS on Apple Silicon, Node 24 and pnpm 10.

```sh
git clone https://github.com/3333444n/sketchbook.git
cd sketchbook
pnpm i            # install dependencies (also fetches Electron)
pnpm dev          # run with hot reload
pnpm test         # unit tests (Vitest)
pnpm test:e2e     # build, then run the Playwright end-to-end tests
pnpm build:mac    # build dist/Sketchbook-<version>-arm64.dmg
```

More in [docs/building-and-releasing.md](docs/building-and-releasing.md).

## Keyboard shortcuts

| Shortcut     | Action                                 |
| ------------ | -------------------------------------- |
| ⌘T           | New tab                                |
| ⌘N           | New window                             |
| ⌘O           | Open                                   |
| ⌘S           | Save                                   |
| ⇧⌘S          | Save As                                |
| ⇧⌘E          | Export image                           |
| ⌘W           | Close tab                              |
| ⇧⌘W          | Close window                           |
| ⌘1–⌘9        | Go to tab 1–8; ⌘9 goes to the last tab |
| ⌃Tab / ⌃⇧Tab | Next / previous tab (also ⇧⌘] / ⇧⌘[)   |

All of Excalidraw's shortcuts work too (press `?` in the app for the full list).

## How it works

- An Electron app embeds the MIT-licensed `@excalidraw/excalidraw` component (0.18.1); there is
  no fork of excalidraw.com.
- The main process owns files, dialogs, menus and the recovery journal; each window's renderer
  owns its tabs and keeps at most five editors mounted.
- The UI is served from a private `app://` scheme with bundled fonts, a strict CSP and a network
  block, so it behaves the same with Wi-Fi off.

Details: [docs/architecture.md](docs/architecture.md) and the
[architecture decision records](docs/adr/README.md).

## What's not included

Sketchbook leaves out the parts of excalidraw.com that need a server, because the point is a
whiteboard that works anywhere and keeps your data on your machine:

- **Live collaboration and share links**: both need a relay server and accounts.
- **AI features** (text-to-diagram, wireframe-to-code): they call a remote model.
- **Online library browsing** at libraries.excalidraw.com: it's a website. You can still import
  local `.excalidrawlib` files.

## Contributing

Issues and pull requests are welcome. Start with [COLLABORATING.md](COLLABORATING.md) for the
dev loop and PR checklist. AI coding agents should read [AGENTS.md](AGENTS.md). This project
follows the [Contributor Covenant](CODE_OF_CONDUCT.md); report security issues as described in
[SECURITY.md](SECURITY.md).

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT) and the fonts it ships
(Excalifont, Virgil, Nunito, Lilita One, Comic Shanns, Cascadia Code, Liberation Sans, Assistant
and Xiaolai). Their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Sketchbook is an independent project. It is not affiliated with or endorsed by Excalidraw.

## License

[MIT](LICENSE)
