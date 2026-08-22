# Scheduled settings

## What it is

A persisted scheduler for appearance and language values: schedule the active
language mode, theme, density, accent colour, fonts, and other customization
values so they change on a time window or weekday set — or from an external
validated source.

## How to use it

**Settings → Scheduled** → New rule:

- Pick what it controls (theme, language mode, accent, …) and the value to apply.
- Choose an optional start/end date, a start and end time, and either **every
  day** (all weekdays inside the selected time window — never seven duplicated
  rules) or an explicit weekday set.
- Date/time pickers are native and keyboard-accessible; values are interpreted
  in your configured local timezone, and the UI states that timezone and its
  daylight-saving behaviour.

### Semantics that are explicit, not guessed

| Case | Behaviour |
| --- | --- |
| Cross-midnight windows | Supported: `22:00–06:00` spans midnight |
| Equal start/end | Treated as zero-length; documented in the rule editor |
| Invalid partial input | Reported inline; nothing silently applies |
| Empty schedule | No-op with honest copy |

Rules resolve deterministically (the later matching rule wins; precedence is
documented and tested). Every edit is recorded by local version history like
any settings change. When a temporary override ends, your base settings return.

## External sources

A rule may take its value from local data, a validated versioned HTTPS API, or
a Home Assistant boolean entity (`on` activates the rule's settings, `off`
leaves base settings or another matching rule in effect).

Boundaries: versioned responses allowlisted to known setting fields, bounded
by size and timeout and validated before application; network access stays in
the privileged process; redirects rejected; credentials never embedded in URLs;
loopback-only HTTP for explicitly bounded development routes. Home Assistant
tokens live in the OS credential vault under a stable key — never in schedules,
exports, logs, or source.

External refresh happens on activation plus a bounded background interval,
with generation guards so an older response cannot overwrite a newer setting.
Network failure, malformed data, offline operation, auth failure, and rate
limiting are non-blocking: last valid state is retained, a localized
notification offers recovery, and a remote value is never silently persisted as
your permanent base setting.

## Verification status

Implemented in code. Timezone-boundary tests are ROADMAP Phase 2 work.

## Suggested articles

- [Theme & appearance editor](../appearance/theme-appearance-editor.md)
- [Language modes & funny levels](language-modes-funny-levels.md)
