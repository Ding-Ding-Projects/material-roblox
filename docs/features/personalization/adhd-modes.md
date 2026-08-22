# ADHD modes

## What it is

Five independent, persisted interface accommodations — not marketing language,
actual modes. They are **modes, plural, independently toggleable**, and every
one of them is **off by default**: a mode that switches itself on has decided
something about you it has no standing to decide.

## The five modes

| Mode | What it does |
| --- | --- |
| **Focus** | Brings the thing being worked on forward and pushes everything else back — dims and de-emphasises, never hides anything you cannot get back in one obvious action |
| **Low stimulation** | Fewer moving things, quieter colour, no non-essential motion, notifications reduced to ones that genuinely need a person; composes with the OS reduced-motion preference (you asked once, you should not ask twice) |
| **Time awareness** | Shows elapsed time where work happens: session length, time since anything changed. Stating a number is the whole feature — nagging is not |
| **One thing at a time** | A single visible current next action chosen by you, persisted like any other state so it survives context switches |
| **Momentum** | A gentle dismissible prompt when something has sat untouched, with a real snooze respected for the stated period rather than thirty seconds |

## Tone rules

Copy is plain, factual, and free of judgement: it says what is true ("nothing
has changed here for 40 minutes"), never what you should feel about it. No
streaks, no rankings, no congratulations, nothing that reads as scolding or a
productivity score. The funny-level sliders still style this copy while the
facts inside stay exact.

**Never presented as medical.** These are interface accommodations — no
diagnosis, no assessment, no advice, no claim of clinical benefit. They are
named for what they DO so anybody can use them without disclosing anything to
a colleague reading over their shoulder.

School and Kids modes interact with them explicitly rather than by accident,
and that interaction is documented in each mode's settings entry.

## Failure modes / security considerations

Modes persist per surface across restarts and reset individually. Purely local
UI state; nothing leaves the device.

## Verification status

Implemented in code. Per-mode interaction tests are ROADMAP Phase 2 work.

## Suggested articles

- [Narrator](narrator.md)
- [Scheduled settings](scheduled-settings.md)
- [Language modes & funny levels](language-modes-funny-levels.md)
