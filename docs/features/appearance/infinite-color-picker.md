# Infinite color picker

## What it is

Every colour control in Material Roblox uses a **continuous picker** — a
two-dimensional saturation/value field plus a hue ring and alpha slider — with
numeric entry, never a finite swatch-only chooser. Swatches, recent colours,
and an eyedropper (where the platform provides one) are conveniences layered on
top, not replacements.

## How to use it

- **Numeric entry** in hex/HEX8, RGB/RGBA, HSL/HSLA, HSV/HSB, HWB, CIELAB/LCH,
  OKLab/OKLCH, and CMYK. The built-in **translator converts bidirectionally**
  between all of them, preserves alpha, identifies the active space and gamut,
  and warns before clipping.
- An **accessible-contrast readout** shows contrast of the current colour
  against the relevant foreground/background so AA decisions are visible while
  you choose.
- Any translated representation copies in one action.

### The animated rainbow

The picker also offers a continuously cycling rainbow as one of its choices,
reachable from the same control every other colour comes from:

- It is stored as a **sentinel marker, never a colour string**, and it never
  joins the swatch palette — call sites that append alpha to stored values
  would otherwise produce broken declarations that fail silently.
- The animation runs **in the stylesheet**, driven by one global duration
  variable published once for the whole app; per-element durations would drift.
- Speed is stored as a level mapped to time in one documented place — seconds
  are a unit nobody has an intuition for.
- Hue interpolates **through the wheel**, not across it: two stops from red to
  red would otherwise fade through grey.
- Under reduced motion the rainbow **settles on ONE deliberate hue** rather
  than slowing down — a slow cycle is still motion.

## Failure modes

- Out-of-gamut numeric entry clamps with a visible warning naming the target
  space, never silently.
- If the stylesheet animation is unavailable, the sentinel renders as its
  fallback hue instead of no background at all.

## Security considerations

Purely local UI state; nothing about colour choices leaves the device.

## Verification status

Implemented in code. Translator round-trip tests and captures are ROADMAP
Phase 2 work.

## Suggested articles

- [Theme & appearance editor](theme-appearance-editor.md)
- [Fonts & typography](fonts-typography.md)
