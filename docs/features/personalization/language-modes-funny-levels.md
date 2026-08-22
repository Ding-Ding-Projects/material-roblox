# Language modes & funny levels

## What it is

Every user-facing surface ships a persisted language mode — **English, playful
Hong Kong-style Cantonese, or bilingual** — plus two independent funny-level
sliders (one per language) from 1 (fully serious) to 5 (maximum playfulness).
Both sliders ship at level 5.

## How it behaves

- The mode affects **all copy**: navigation, headings, buttons, dialogs,
  errors, notifications, documentation chrome. Bilingual mode shows both
  without crowding: primary label prominent, compact secondary.
- Cantonese is playful Hong Kong style and stays respectful — humour never
  mocks the user, their data loss, their money, or disability.
- **The funny level applies to every message category with no exemptions**,
  including destructive, financial, security, accessibility, and error copy.
  You are told at first run and in the setting itself that it styles all of
  them, that defaults are level 5, and that you can change or reset either at
  any time.
- **Voice changes; facts never do.** At any level the message still names what
  happened or is about to happen, what is affected, and your options — which
  file, which account, which action is irreversible, what the error actually
  was. A warning nobody can act on is a broken warning, not a funny one.

## Configuration

| Setting | Range | Default |
| --- | --- | --- |
| Language mode | EN / playful Cantonese / bilingual | English |
| English funny level | 1–5 | 5 |
| Cantonese funny level | 1–5 | 5 |

Both persist across restarts and are reachable from Settings and the command
palette.

## Failure modes

A string missing from one catalog falls back through the chain (bilingual →
primary → secondary → key) rather than rendering raw keys to users.

## Security considerations

Localization resources are separate from logic; facts embedded in messages
(numbers, paths, identifiers) pass through unchanged at every level by
construction.

## Verification status

Implemented in code with inline catalogs. All-modes/all-levels render tests are
ROADMAP Phase 2 work.

## Suggested articles

- [School mode](school-mode.md)
- [Personal vocabulary upload](personal-vocabulary-upload.md)
- [Narrator](narrator.md)
