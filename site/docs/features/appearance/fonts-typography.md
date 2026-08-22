# Fonts & typography

## What it is

Full control over the type the interface renders: family chosen from installed
plus bundled faces, size scale, weight, and the word-processor-depth properties
listed in the [appearance editor](theme-appearance-editor.md) — all with live
preview and CJK-safe fallback.

## How to use it

- **Settings → Appearance → Font** for global family/size/weight.
- The font picker groups families, renders **each name in its own face**, and
  offers size as both a stepper and free entry.
- Every picker is itself customizable to the same standard — the colour picker
  offers a swatch grid, recent and custom colours, a spectrum, and direct hex /
  RGB / HSL entry with live preview and contrast readout.

### Vendored fonts are downloaded complete, by a committed script

The site (and optionally the app) can vendor **Roboto Flex** and **Noto Sans
HK**. The rule that makes this trustworthy: fonts are never fetched by hand.

`scripts/fetch-fonts.mjs` (optional, never run by CI):

- Sends a **modern browser User-Agent** so Google Fonts serves the full woff2
  set — one family request commonly returns dozens of `@font-face` blocks
  (weights × styles × unicode-range subsets). A naive fetch vendors one file
  and silently drops every non-latin range.
- Downloads **every** file the response references, preserving
  `font-weight` and `unicode-range` exactly, rewriting only `src`.
- Never declares an axis the binary lacks — a static font claimed as variable
  would be synthesized by the browser (faux-bold, wrong metrics, no error).
- Records **SHA-256 per file** in `site/assets/fonts/MANIFEST.json` and fails
  loudly naming URL and status on any miss.

## Failure modes

- A `@font-face` family name one character different from what the markup asks
  produces total fallback with no error — the app therefore verifies loaded
  families at runtime (`document.fonts.check`) and reports the effective face
  in Settings.
- Without vendored fonts the system stacks apply; nothing degrades beyond
  appearance.

## Security considerations

Font files are fetched once from Google's canonical endpoint by the script you
run deliberately, hashed into a manifest, and served locally afterwards. The
running site loads zero remote fonts.

## Verification status

Implemented (system stacks + vendoring path). Runtime font-loading assertions
are ROADMAP Phase 2 work.

## Suggested articles

- [Theme & appearance editor](theme-appearance-editor.md)
- [Infinite color picker](infinite-color-picker.md)
