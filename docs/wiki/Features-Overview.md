# Features overview

A tour of everything Material Roblox ships. Every entry links to its full
article in the repository, which is where the detail lives — this page is the
map, not the territory.

The one-paragraph version: **a Material Design 3 Windows desktop app for
browsing public Roblox platform data**, wrapped in an unusually complete
interface (tabs, palette, regex builder, bulk actions, exports, history),
deep appearance customization, a set of playful-but-honest safety features,
and personalization that runs from language modes to ADHD accommodations.

## Roblox explorer

| Surface | What it shows |
| --- | --- |
| Home | Landing with quick lookup, recent searches, service health chips |
| Users | Lookup by username or id, profile card with avatar renders, created/updated dates, description |
| Friends | Friends / followers / following lists with counts, bulk select, export |
| Groups | Group info, roles, member counts, public shout wall |
| Games | Universe and place details, icons, stats (visits, favorites, playing), badges per game |
| Marketplace | Catalog search with category/price/creator filters, item cards, limited/serial info where public |
| Inventory | Public inventories by asset type with pagination and bulk export |
| Economy | Authenticated: Robux balance and transaction summary (requires session) |
| Presence | Authenticated presence polling for saved users at a respectful interval |
| Session | Connect `.ROBLOSECURITY` through a secure paste flow; verify whoami; disconnect; clear disclosure of what is stored |
| Compare | Side-by-side two-user comparison: mutuals, badge and game overlaps |

Cross-cutting behaviour: every list gets bulk actions and export, every
search bar gets the regex builder, thumbnails degrade gracefully offline,
calls are client-throttled (~150 ms spacing) with exponential backoff on
`429`, private inventories are reported honestly as inaccessible rather than
scraped around, and nothing that needs authentication fakes an empty state —
it explains what connecting unlocks.

Full endpoint table:
[API coverage](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/api-coverage.md) ·
[Getting started](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/getting-started/index.md)

## Interface

- **[Tabbed navigation](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/tabs.md)** —
  browser-style tab strip docking to any edge (left default), pinning,
  groups with colours and collapse, reordering, four discovery searches
  (strip, group contents, group names, all tabs), text-based bulk close with
  previews and pinned-tab protection, per-tab appearance editing via the
  context menu or Shift+right-click, persistence across restarts.
- **[Command palette](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/command-palette.md)** —
  `Ctrl+Shift+F`; lists every command, page, destination, and setting;
  rows render live controls inline; selecting teleports to the exact element.
- **[Search & regex builder](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/search-and-regex-builder.md)** —
  plain-text search everywhere by default with an anchored full regex builder
  beside every field, dropdown, context menu, and settings surface; guided
  construction plus raw editor, flags, live matches, capture groups.
- **[Notifications](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/notifications.md)** —
  non-blocking corner toasts plus a searchable reviewable centre with bulk
  dismiss and export honouring active filters.
- **[Bulk actions](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/bulk-actions.md)** —
  multi-select with shift-ranges and keyboard equivalents on every list,
  honest select-all scoping, preview counts before anything happens,
  destructive batches behind super confirmation, honest partial results.
- **[Exports](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/exports.md)** —
  JSON, JSONL, YAML, TOML, XML, CSV, TSV, Markdown, HTML, SQL, and ZIP;
  encoding and schema stated; secrets excluded and the export says so; one
  click to open the result in VS Code when installed.
- **[Local history](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/local-history.md)** —
  append-only local Git snapshots for documents *and* every user-managed
  record including settings; date picker plus action filter; restore is
  itself recorded, so undo can be undone.
- **[Changelog viewer](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/interface/changelog-viewer.md)** —
  every released version in-app, calendar date filter, regex search, commit
  links on every entry.

## Appearance

- **[Theme & appearance editor](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/appearance/theme-appearance-editor.md)** —
  light/dark/system themes, density, accent seed, and per-element
  *Edit appearance…* on every rendered surface, not a hand-picked subset.
- **[Infinite color picker](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/appearance/infinite-color-picker.md)** —
  continuous spectrum plus numeric entry, bidirectional translator across
  HEX/RGB/HSL/HSV/HWB/LAB/LCH/OKLab/OKLCH/CMYK with alpha preserved and
  contrast readouts, animated rainbow option (reduced motion settles on one
  hue), recent colours, eyedropper where available.
- **[Fonts & typography](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/appearance/fonts-typography.md)** —
  word-processor depth: family, size as stepper and free entry, weight,
  italic, underline/strikethrough styles, spacing, line height, alignment,
  with CJK-safe fallbacks and runtime verification that the chosen face
  actually loaded.
- **[App logo presets](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/appearance/app-logo-presets.md)** —
  shipped presets plus bounded local custom-image conversion (decoded in a
  sandbox, size-bounded, never uploaded anywhere), resettable to the shipped
  mark.

## Safety

- **[Session cookie handling](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/session-cookie-handling.md)** —
  `.ROBLOSECURITY` lives only in the OS credential vault over encrypted
  storage; the renderer never sees the value; disconnect clears it.
- **[Destructive super confirmation](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/destructive-super-confirmation.md)** —
  two independently operated keys plus a full-range confirmation slider gate
  every irreversible action, with an always-visible emergency exit.
- **[Toy locks](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/toy-locks.md)** —
  lock any element behind its own password or TOTP factor; explicitly a fun
  speed bump, not security; recovery is self-service and stated plainly.
- **[Unlock ladder](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/unlock-ladder.md)** —
  dim-sum question → ten sums → whack-a-mole → clock; graded server-side
  against single-use nonces; budget-capped per hour; clears the *wait*, never
  credentials, never refunds attempts.
- **[Support tickets](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/support-tickets.md)** —
  the joke recovery desk: it opens your application-data folder so you can
  delete it yourself; nothing is ever sent anywhere, and it says so.
- **[Two-factor authenticator](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/two-factor-authenticator.md)** —
  built-in RFC 6238 codes verified against published test vectors, QR pairing
  drawn in-process with manual base32 alongside, secrets vault-stored,
  ordinary exports omit secrets and say so.

## Personalization

- **[Language modes & funny levels](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/language-modes-funny-levels.md)** —
  English / playful Cantonese / bilingual, plus two independent funny-level
  sliders (1 serious – 5 maximum playfulness) styling voice while facts stay
  exact in every message category including errors.
- **[School mode](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/school-mode.md)** —
  one shared, user-renamable switch that suppresses Cantonese, funny levels,
  vocabulary, and all dim-sum capabilities live across apps; unlock needs the
  locally set credential.
- **[Personal vocabulary upload](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/personal-vocabulary-upload.md)** —
  local-only bounded JSON replacement list applied at the text boundary;
  fail-closed to shipped wording; never leaves the machine.
- **[Narrator](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/narrator.md)** —
  opt-in spoken narration with per-language voice pickers resolved from the
  platform at runtime, rate/pitch controls, serialized queue, ducks under
  screen readers.
- **[ADHD modes](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/adhd-modes.md)** —
  five independent off-by-default accommodations (focus spotlight, low
  stimulation, time awareness, one thing at a time, momentum nudges); plain
  non-judgemental copy; never framed as medical.
- **[Dim sum surprise](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/dim-sum-surprise.md)** —
  10% startup draw of a bilingual dish card from the public photo catalog;
  non-blocking, auto-dismissing, deliberately not opt-out-able.
- **[Scheduled settings](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/scheduled-settings.md)** —
  time/weekday/date rules in the local timezone with deterministic
  precedence, plus validated external sources for any schedulable value.

## Platform

- **[File converter](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/file-converter.md)** —
  categorized adapter catalog with bundled offline converters (structured
  data formats, images via canvas, PDF inspect/split/merge/reorder/rotate/
  metadata), byte-signature detection, sandboxed bounded execution, atomic
  writes, resumable unlimited-length queue, unavailable formats listed
  disabled with their exact missing dependency.
- **[Ollama suite manager](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/ollama-suite-manager.md)** —
  exhaustive local model catalog against Ollama's documented API only,
  evidence-backed hardware-fit verdicts, batch pulls with honest partial
  outcomes, streamed chat sessions, allowlisted harness launches with
  preflight preview.
- **[Auto-updater](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/auto-updater.md)** —
  Chrome-style background checks against this repository's Releases with a
  non-blocking ready banner, explicit unsigned-feed warning, restart-only
  installation, visible failures.
- **[Line counts & estimates](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/line-counts-and-estimates.md)** —
  CI-counted breakdown in every release with exclusions stated, generated
  code separated, and agent-vs-human attribution by surviving blame lines.
- **[Status reporting](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/status-reporting.md)** —
  real workflow data on the website; unrun checks are shown as unrun, never
  passed.
- **[Embed graphic](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/embed-graphic.md)** —
  byte-identical Open Graph image pair committed and served, so pasted links
  render a real product picture rather than a grey card.

## Honest boundaries

- Automated test suites and built-artifact screenshot evidence were
  deliberately skipped during the ultra-speed delivery pass and are tracked,
  unticked, in
  [ROADMAP Phase 2](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/ROADMAP.md).
- The installer is unsigned by permanent policy; SmartScreen will warn.
- Delivery target is Windows 10+ x64 only.
