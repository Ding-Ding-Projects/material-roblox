# Command palette

## What it is

A single searchable entry point to every command, tab, documentation article,
setting, and appearance control in the app — opened with **`Ctrl+Shift+F`**.
That literal shortcut is the discoverable default on Windows; `Ctrl+K` is
intentionally not a competing binding.

## How to use it

1. Press `Ctrl+Shift+F`.
2. Type to filter. Results are ranked across titles, keywords, and groups.
3. Setting results render as **rich rows**: the live switch, slider, select, or
   colour control appears inline in the palette row and uses the same
   validation, persistence, localization, funny-level styling, and history
   recording as the Settings surface. Changing it in the palette changes it
   everywhere.
4. Destination results (tabs, articles, settings sections) **teleport**: the app
   navigates to the owning surface, selects the correct tab or group, scrolls
   the exact element into view, focuses it, and flashes a brief highlight.
5. Keyboard: arrows move, `Enter` activates, `Esc` closes. Size toggles between
   a bounded card (default) and full-window.

## Configuration

Palette contents are automatic: every registered setting, tab, and article is
indexed at boot by the owning module. Nothing needs manual registration, so a
feature cannot quietly miss the palette.

## Failure modes

- An empty query shows recent destinations; an unmatched query shows an honest
  "no results" message naming what was searched.
- If a teleport target's surface failed to initialize (its module degraded at
  boot), the row renders disabled with that reason instead of teleporting into
  nothing.

## Security considerations

The palette indexes UI only. It never surfaces secret values — credential
fields appear as controls without revealing stored content.

## Verification status

Implemented in code. Palette coverage tests and captures are ROADMAP Phase 2.

## Suggested articles

- [Search & regex builder](search-and-regex-builder.md)
- [Tabbed navigation](tabs.md)
- [Notifications](notifications.md)
