# Test suites

Local-only suites using Node's built-in runner (`node:test` + `node:assert/strict`).
**Zero dependencies were added.** Per standing project policy, GitHub Actions still
runs no tests — these suites exist for local runs only.

```
npm test            # node --test "tests/**/*.test.mjs"
```

Node 22+ recommended (glob arguments for `--test`). Note: `node --test tests/`
(directory form) does NOT resolve on this Node/Windows combination — always use
the glob form above.

## Suites

| File | Covers | Status |
| --- | --- | --- |
| `qr.test.mjs` | QR encoder: version selection vs ISO/IEC 18004 byte-mode capacities (level M), determinism, finder/timing/alignment/dark-module shapes, BCH format info (both copies), BCH version info (v7+), and full Reed-Solomon syndrome verification of every block via an independent spec-based codeword walk | RED — surfaces a real defect in `src/js/core/qr.js` (see below) |
| `colorpicker-math.test.mjs` | Colour parser/formatters: every supported space, alpha preservation, round-trips within documented tolerance, gamut clipping flags, WCAG contrast values, rainbow sentinel contract | RED — surfaces a real defect in `src/js/core/colorpicker.js` (see below) |
| `i18n-vocab.test.mjs` | The personal-vocabulary validator (`validateVocabularyText` in `src/js/core/vocabulary.js`, which i18n delegates to): schema/bounds/duplicate-key/unsafe-key fail-closed contract, acceptance boundaries | GREEN |
| `scripts.test.mjs` | `audit-imports.mjs` exit 0; `count-lines.mjs` table self-consistency; hermetic `check-vocabulary.mjs` lifecycle in a temp dir | GREEN with two pinned upstream defects (see below) |

## Import-safety map (plain Node, no DOM)

Verified empirically by importing every renderer module under plain Node:

- **SAFE (42 modules)** — everything under `src/js/core/` except `locks.js`,
  and everything under `src/js/features/roblox/**`. All DOM/window access in
  these files sits inside functions or `init()`; importing them defines
  functions only. (`store.get/set` degrade gracefully without a window by
  returning fallback / false.)
- **UNSAFE (1 module)** — `src/js/core/locks.js`: touches `window` at module
  top level (`window is not defined` on import). Not forced, not shimmed.
- **PENDING** — `src/js/features/roblox/safe-regex.js` does not exist yet
  (another lane adds it); it gets a suite row when it lands.
- Import-safe does NOT mean runnable: UI-mounting functions
  (`mountColorPicker`, `ui.el`, router registration, …) still require a DOM.
  Only pure exports are exercised here.

## Deliberately skipped (with reasons)

| Target | Why skipped |
| --- | --- |
| `scripts/build-changelog.mjs`, `scripts/build-docs-index.mjs` | Write generated output into the tree (`site/docs-index.json` etc.) — a test run must never mutate the checkout |
| `scripts/gen-icons.mjs`, `scripts/gen-social-preview.mjs` | Overwrite committed binary assets |
| `scripts/ensure-electron.mjs`, `scripts/fetch-fonts.mjs` | Download dependencies / network access — tests stay offline |
| `scripts/release-meta.mjs` | Queries GitHub (network, auth context) |
| Any DOM-bound module surface (`ui.js` toolkit, `router.js` tabs, appearance editor, converter UI, ollama chat UI…) | Needs a real renderer; out of scope for dependency-free Node tests. If ever needed, drive the built app headlessly instead of shimming a fake DOM |
| `src/js/features/roblox/api.js` networking | All traffic belongs to main-process IPC per the development contract; there is nothing fetchable from plain Node without faking the bridge |

## Known defects surfaced by this suite (owned outside this lane)

1. **`src/js/core/qr.js` — capacity ladder collapses for versions 4–10.**
   `dataSizeCodewords()` reduces `sum + data` over the block groups but ignores
   each group's block COUNT, so multi-block versions report roughly half or
   quarter capacity (v10 reports max **84** bytes instead of **213**) and
   `addEccAndInterleave` slices blocks from truncated segment data — produced
   symbols fail Reed-Solomon verification. Versions 1–3 are correct (single
   block). One-line fix: reduce `count * data`. Reproduce:
   `encode('A'.repeat(43))` picks v8; spec says v4.
2. **`src/js/core/colorpicker.js` — `parse()` double-gamma-encodes six spaces.**
   The hex/rgb/hsl/hsv/hwb/cmyk branches hand display-referred (gamma-encoded)
   channel values to the shared finisher `fin()`, which treats its inputs as
   linear-sRGB and applies `linearToSrgb` again. `parse('#767676')` returns
   r=g=b≈0.710 (should be 0.463); `hsl(120,100%,50%)` returns (0, 0.735, 0);
   WCAG contrast for #767676 vs white reads 2.05:1 instead of 4.54:1. The CIE
   paths (lab/lch/oklab/oklch) correctly pass linear values and are fine.
   Fix direction: those branches must deliver linear values to `fin()`
   (or bypass the linear encode step).
3. **`scripts/count-lines.mjs` — attribution excludes `tests/` but its
   consistency target includes it.** Line 159 skips `tests/` files during
   blame attribution while line ~184 requires attribution to equal the FULL
   line total, so once any file exists under `tests/` the script exits 1 with
   `attribution total (N-tests) != line total (N)`. One-line fix: attribute
   tests files too (drop the `x.id !== 'tests'` condition).
4. **`scripts/check-vocabulary.mjs` — lock bootstrap is unreachable.**
   The missing-lock branch exits before the `--lock` branch, so the printed
   remedy (`node scripts/check-vocabulary.mjs --lock`) fails with the very
   same "lock file is missing" error. Re-locking an EXISTING lock works.
   Fix direction: handle `relock` before the missing-lock bail-out.

The suites above pin all four signatures, so when the owning lanes fix them
the same tests flip green without edits — and any DIFFERENT regression in
those paths still turns red.
