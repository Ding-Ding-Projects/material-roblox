# Two-factor authenticator

## What it is

A built-in RFC 6238 TOTP authenticator for arbitrary accounts — register
secrets, read live codes — plus the QR-based pairing flow used wherever the app
itself grows a factor (toy locks). Local-only: no account, no cloud sync, no
telemetry.

## Registration routes (never retyping)

- Paste an `otpauth://totp/` URI — parameters carried by it are honoured, not
  overwritten with defaults.
- Read a QR from an image file or clipboard.
- Scan with a camera where the platform provides one.
- Manual base32 entry with algorithm/digits/period.

## Pairing done right

- The QR is drawn **in-process from local code** — never a third-party QR web
  service or a remote chart API; no network call belongs anywhere in this flow.
- The **manual secret sits beside the QR** in copyable grouped base32 with
  algorithm, digit count, and period stated, behind an explicit reveal action.
- **Pairing is confirmed before the factor arms**: you type one current code
  back. Without that step a mis-scanned secret locks you out of a thing you
  just set up.

## Reading codes

Current code large and grouped with copy action, live countdown to the period
boundary, next-code peek so nobody starts typing at two seconds left. The
countdown is never colour- or motion-only. When the system clock is skewed far
enough that codes will be refused, the surface says so in plain words rather
than emitting confidently wrong digits.

Standards, not approximation: SHA-1/SHA-256/SHA-512, 6–8 digits, arbitrary
period, defaults matching what the world issues (SHA-1/6/30), verified against
the RFC 6238 published test vectors. Entries are a real list — searchable,
reorderable, groupable, bulk-manageable — named per issuer and account.

## Storage & export

Secrets live in the OS credential vault under stable per-entry keys. Ordinary
exports **omit secrets and say so**; a deliberate secrets export is separate,
named, behind super-confirmation, and warns it writes usable secrets in the
clear.

If an app lock is registered inside the same app's authenticator, the UI says
plainly that the lock is now ornamental — the key sits inside the box it opens
— and lets you do it anyway. It is a for-fun lock.

## Failure modes / security considerations

- Wrong code at pairing → registration does not arm; try again with a fresh
  code.
- Beyond the one-time reveal, no surface displays or characterizes a stored
  secret's value, length, or composition.
- Clock skew is reported, not guessed around.

## Verification status

Implemented in code against RFC test vectors. Automated vector tests are
ROADMAP Phase 2 work.

## Suggested articles

- [Toy locks](toy-locks.md)
- [Unlock ladder](unlock-ladder.md)
- [Session handling](session-cookie-handling.md)
