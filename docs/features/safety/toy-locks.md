# Toy locks

## What it is

A playful, self-imposed speed bump: lock **any rendered element** — button,
field, tab, appearance property, notification, anything — behind a password or
an OTP code. It exists for fun and self-discipline, and the UI says so every
time.

## How to use it

- Right-click any element → **Lock this element…** (keyboard equivalent
  available). A non-modal anchored wizard opens beside that exact element.
- The wizard names the target, chooses password or TOTP, creates **that
  element's own credential**, chooses an unlock duration (this surface only /
  N minutes / until app close), shows a plain disclosure of what this is and is
  not, and returns focus on completion or cancellation.
- Every lock carries its own credential — no master key, no implicit
  inheritance. Locking a group does not relock members; a locked property in a
  locked tab is two locks with two answers. Bulk locking creates separate
  credentials per element unless you deliberately reuse one.

## What it must never be mistaken for

- **Not encryption.** Nothing is encrypted; a locked element is visually gated.
- **Not protection from other people** who use this machine.
- Recovery is self-service by design: delete the app's data folder
  (`%APPDATA%\material-roblox` — named verbatim in the wizard and the unlock
  prompt) and every lock clears. No reset ticket, no support channel, no risk
  to your content — locks never gate access to your own files.

Locked items stay honest in search: they still appear in tab searches,
settings search, and the palette labelled as locked; activating one prompts to
unlock rather than teleporting past it. Locked tabs are excluded from bulk
closes by default with an explicit include-and-preview option.

Lock creation/change/removal is recorded in local history; the credential
itself never enters snapshots, exports, or logs.

## Configuration

| Aspect | Default |
| --- | --- |
| Method per lock | Password (hashed) or TOTP (your authenticator) |
| Unlock duration | Your choice at creation; explicit *Lock again* action |

## Failure modes

- Wrong attempts get honest, rate-limited feedback naming the recovery route;
  they never wipe content or escalate.
- Restoring older state never silently drops a lock nor resurrects one whose
  credential is gone — where that would happen, the surface stays unlocked and
  says so.

## Security considerations

Passwords are verified against stored hashes (never stored passwords). OTP
secrets live in the OS vault. Neither the app nor its docs display, hint at,
or characterize a stored secret's value, length, or composition beyond the
one-time registration reveal.

## Verification status

Implemented in code. Wizard and unlock-path tests are ROADMAP Phase 2 work.

## Suggested articles

- [Unlock ladder](unlock-ladder.md)
- [Support tickets](support-tickets.md)
- [Two-factor authenticator](two-factor-authenticator.md)
