# School mode

## What it is

One universal, user-renamable mode that makes every playful capability behave
as if it were never installed — for when the interface needs to look serious.
You can rename it; after a rename every surface uses only your chosen name and
never reveals the shipped one.

## How to use it

- Toggle in **Settings → School mode** (or its renamed label).
- Turning it **on** requires nothing. Turning it **off** requires the shared
  locally verified PIN/password or passkey you set at first use.
- The credential lives in the OS-backed store; deleting the app's data record
  resets it by design, and the UI says so rather than claiming real protection.

## What it suppresses

While on, apps force English presentation and make Cantonese, bilingual mode,
funny-level styling, personal vocabulary, and **all dim-sum capabilities**
behave as uninstalled:

- Controls, copy, labels, routes, palette/search results, previews,
  notifications, images, and references are **omitted**, not merely disabled or
  visually concealed.
- The unlock ladder's dim-sum rung is absent (it starts at the sums) because a
  message naming a hidden thing is itself a leak.
- Your prior choices stay stored and return intact when the mode goes off.

## One switch, everywhere

School mode is a single shared record across the user's apps, not a per-app
setting with the same name: turning it on anywhere turns it on everywhere, and
running apps pick the change up **live** without a restart. If an app cannot
read or watch the shared record it says so on the control instead of silently
behaving as if the mode were off.

## Failure modes

- Credential loss: reset by deleting the shared data record (the settings page
  names it verbatim). This is a user-experience lock, not encryption.
- Rename persistence survives restarts and applies to accessible names too.

## Security considerations

This is deliberately not a security boundary. Credential material never enters
exports, sync files, logs, or screenshots.

## Verification status

Implemented in code with live propagation. Suppression-completeness tests are
ROADMAP Phase 2 work.

## Suggested articles

- [Language modes & funny levels](language-modes-funny-levels.md)
- [Dim sum surprise](dim-sum-surprise.md)
- [Unlock ladder](../safety/unlock-ladder.md)
