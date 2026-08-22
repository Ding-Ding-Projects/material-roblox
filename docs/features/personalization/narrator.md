# Narrator (spoken TTS)

## What it is

A spoken narrator for app events, shipped in every user-facing app. It stays
**OFF by default** and is enabled only by you — the opt-in is yours; shipping
it is mandatory.

## How to use it

Enable in **Settings → Narrator**, then choose:

| Control | Options |
| --- | --- |
| Language | English / Cantonese / Both (English then Cantonese, strictly serialized) |
| Voice per language | One picker per narrated language — never one shared picker |
| Rate & pitch | Within platform ranges; default is the voice's own delivery |

### The voice pickers

- Each lists **the voices your machine actually has** for that language,
  resolved from the platform at runtime, plus an explicit **Choose
  automatically** entry that is the shipped default — the app cannot know what
  is installed until it asks, so nothing ships pinned to a named voice.
- Persistence stores the platform's **stable voice identity**, never its
  display name (names are not unique and get localized).
- The list arrives late: platform enumeration commonly returns nothing on the
  first call and fills in behind an event, so the picker subscribes and re-reads
  instead of reporting "no voices installed" on a machine with forty.
- Beneath each picker a status line says what is actually in effect: which
  voice will speak; that a chosen voice is **not installed** and narration is
  falling back while your choice is *kept*; that a network-backed voice goes
  quiet offline; or that no installed voice can read the language at all.

## Coexistence rules

- Infrequent by design: debounced with per-category cooldowns, one utterance at
  a time through a serialized queue; a superseded queued line is replaced, not
  stacked.
- Narrator tone follows the per-language funny level in every category — but
  spoken error narration still names the actual failure and what to do about it.
- Yields to or ducks under an active screen reader, and respects reduced-sound /
  quiet-hours settings where they exist.

## Failure modes

No speech-synthesis capability → the toggle states it plainly instead of
appearing to work silently.

## Security considerations

Narration speaks UI copy only; secret values are never spoken.

## Verification status

Implemented in code. Voice-enumeration edge-case tests are ROADMAP Phase 2
work.

## Suggested articles

- [Language modes & funny levels](language-modes-funny-levels.md)
- [ADHD modes](adhd-modes.md)
