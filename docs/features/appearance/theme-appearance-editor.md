# Theme & appearance editor

## What it is

Material Roblox conforms to Material Design 3 and lets you customize it: a
persisted theme (light / dark / system), density, an accent seed colour, full
UI font customization with live preview and CJK-safe fallback — plus a
first-class appearance editor for **every rendered element**, with no exempt
surface.

## How to use it

- **Settings → Appearance** for global controls: theme, density (compact /
  cosy / comfortable), accent seed via the infinite colour picker, font family,
  size scale, weight.
- **Every element** exposes *Edit appearance…* from its right-click context
  menu, with an accessible keyboard equivalent. For tabs, normal right-click
  keeps tab management and adds the editor; Shift+right-click opens it directly.
- The editor opens as a **non-modal anchored dialog beside the exact element**,
  tracks that anchor while open, handles viewport-edge collision, and returns
  focus to the originating element on close.
- Typography reaches word-processor depth: every installed and bundled font is
  searchable with a live typeface preview; size as stepper and free entry;
  weight; italic/oblique; underline style and colour; single/double
  strikethrough; overline; capitalization and small caps; super/subscript;
  text colour; highlight; outline; shadow; glow where supported; character and
  word spacing; line height; baseline offset; direction; alignment. Unsupported
  properties stay visible with a clear platform-capability explanation rather
  than disappearing or silently dropping saved values.

## Configuration

- Named presets ship alongside user-saved themes; presets and per-element state
  **export/import as files**, so a customized look survives reinstall and can be shared.
- Per-property reset, per-element reset, and a global reset all exist.
- A customization surface that cannot represent a value says so and keeps your
  input — it never silently drops what you typed.

## Failure modes

- If a custom font stops resolving at runtime, the CJK-safe fallback stack
  applies and Settings shows which family actually rendered.
- Restoring older themes never resurrects values the current schema dropped;
  anything unmigratable is reported at import time.

## Security considerations

Appearance data is local UI state. Theme files are plain JSON with bounded
size and schema validation on import.

## Verification status

Implemented in code. Per-element editing tests and both-theme contrast captures
are ROADMAP Phase 2 work.

## Suggested articles

- [Infinite color picker](infinite-color-picker.md)
- [Fonts & typography](fonts-typography.md)
- [Tabbed navigation](../interface/tabs.md)
