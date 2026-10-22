# 0008. Product name "Sketchbook" and Excalidraw attribution

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The Excalidraw code is MIT-licensed, but the name and logo are Excalidraw's trademarks.
Calling the app "Excalidraw" or "Excalidraw Desktop", or using the logo, would suggest it is an
official product and could confuse users about where to get support. The MIT license also
requires keeping the copyright and license notice.

## Decision

- The product is called **Sketchbook**. It has its own original icon and does not use the
  Excalidraw logo.
- It credits Excalidraw plainly: "Built with Excalidraw (MIT)" in the About panel and welcome
  screen, with a link to the Excalidraw repository.
- Excalidraw's license and those of other bundled dependencies are reproduced in
  `THIRD_PARTY_NOTICES.md`.
- Sketchbook's own code is MIT-licensed (`LICENSE`).
- We describe the relationship accurately: Sketchbook embeds the Excalidraw component and is
  not affiliated with or endorsed by the Excalidraw team.

## Consequences

- No trademark ambiguity; users know it's an independent app.
- Users searching for "Excalidraw desktop" may not find it by name, so the README should say
  clearly what it is.
- Bugs in the drawing engine itself should be reported upstream; our issue templates say so.
