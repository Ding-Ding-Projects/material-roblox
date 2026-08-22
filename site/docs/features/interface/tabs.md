# Tabbed navigation

## What it is

Every surface in Material Roblox lives in a browser-style tab rather than one
long scrolling page. The tab strip docks to the **left edge by default** —
a vertical rail shows more tabs legibly than a horizontal row — and can be
docked to any edge from its context menu or Settings. Below 900 px of window
width the rail collapses to icons automatically.

Tabs carry the full behaviour set, not just navigation:

- **Overflow** when tabs exceed the strip, never silent clipping.
- **Reorder** by drag or keyboard; **pin/unpin** into a stable dedicated region.
- **Groups**: name, colour, collapse/expand, move tabs between groups through
  the *Move… into group…* picker (a real picker dialog with search, never an
  ever-growing menu list).
- **Four discovery searches**: current strip, inside every group, group names,
  and a master search across all open tabs — each with plain-text default and a
  full regex builder.
- **Bulk close** containing/not-containing text, with preview, counts, and
  pinned tabs excluded by default.
- **Persistence** of order, pins, groups, colours, and collapsed state across restarts.

## How to use it

- Right-click a tab for management actions; choose *Edit tab appearance…* for
  that tab's typography and colours. Shift+right-click opens the editor directly.
- Right-click empty strip space for strip-level actions including dock edge.
- Keyboard: `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle; arrow keys move within the
  strip (`aria-orientation` follows the dock edge).

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Dock edge | Strip context menu → Dock, or Settings → Interface | Left |
| Collapse threshold | automatic at ≤900 px width | on |

## Failure modes

- A collapsed group is revealed temporarily by search results without losing
  your collapsed preference.
- If persisted state is unreadable, the app falls back to defaults and shows a
  notification saying so instead of failing silently.

## Security considerations

Tabs hold UI state only; no credentials or secrets live in tab persistence.

## Verification status

Implemented in code. Automated interaction tests and built-artifact captures
are tracked as ROADMAP.md Phase 2 work.

## Suggested articles

- [Command palette](command-palette.md) — teleport straight to any tab or setting
- [Search & regex builder](search-and-regex-builder.md)
- [Theme & appearance editor](../appearance/theme-appearance-editor.md)
