# App logo presets & customization

## What it is

A first-class app-logo customization surface: several shipped,
project-appropriate logo presets plus local custom-image upload. Your choice
persists and applies to the title bar, About surface, and notifications.

## How to use it

1. Open **Settings → Appearance → App logo**.
2. Pick a preset or upload a PNG/JPEG/WebP/SVG from your own files.
3. Adjust crop (keyboard-accessible handles), fit/fill behaviour, focal point,
   background treatment (transparent or a colour through the infinite picker),
   and preview at every display target — small chrome size up to 512 px.
4. Save. Reset returns to the shipped mark in one action.

## What conversion guarantees (and refuses)

Custom images are processed **locally, privately, bounded, and safely**:

- Decoding uses an allowlisted set of formats with the actual bytes verified,
  never the extension or MIME claim.
- Input bytes, decoded pixels, frame count, dimensions, CPU time, memory, and
  output count are bounded; malformed, animated-where-unsupported, or
  decompression-bomb input is rejected without partially applying anything.
- From each accepted source the app generates only the variants its surfaces
  can actually consume, verifying each output's signature, dimensions, alpha
  handling, and decoder round-trip before use.
- Any rasterization, transparency loss, crop, or format loss is reported
  **before** it becomes active; on conversion failure the previous valid logo
  stays active.

## Configuration

| Aspect | Notes |
| --- | --- |
| Persistence | Validated selection + derived assets only; replace/clear purge derived assets |
| Scheduled settings | Logo participates like any appearance value |

## Failure modes

- Cache corruption fails closed to the shipped mark rather than rendering a
  broken image.
- A custom mark changes presentation only — package identity, data directory,
  update feed, and installer identity are constants that no rename can move.

## Security considerations

Images never leave the machine: no upload, no CDN, no remote converter, no
telemetry, no logs, no exports containing your image without your explicit
export action.

## Verification status

Implemented in code. Conversion bounds tests and packaged-icon captures are
ROADMAP Phase 2 work.

## Suggested articles

- [Theme & appearance editor](theme-appearance-editor.md)
- [Scheduled settings](../personalization/scheduled-settings.md)
