# Unlock ladder

## What it is

Every surface that can lock you out ships something better than watching a
countdown: a ladder of small games that clears the **wait**, escalating only as
it goes. It is offered exactly once per lockout — falling to the bottom leaves
you where you started, so it can only ever improve your afternoon.

## The rungs, in order

1. **Dim sum** — one dish, four choices. Right: the wait ends.
2. **Ten easy sums** — after five wrong dishes. Single- and double-digit
   arithmetic; every one must be right. (Under School mode the dim-sum rung is
   *absent*, not skipped with a message — a message naming a hidden thing is
   exactly what that mode forbids.)
3. **Whack-a-mole** — after a single wrong sum. Hit enough moles inside the
   round.
4. **The clock** — after a lost round. The ladder is not offered again for that
   lockout; you simply serve the wait you were already serving.

## The five lines that make it safe

- **It clears the WAITING, never the CREDENTIAL.** Winning returns you to the
  ordinary unlock prompt; you still need your password or code. Guessing a
  dumpling is not an authentication factor and is unreachable as one.
- **It never refunds the attempt budget.** The ladder returns exactly the same
  number of attempts the wait would have — never one more.
- **It is budgeted** because a machine can play it: at most a small fixed
  number of ladder skips per rolling hour (three), after which the clock is the
  only way through for everyone.
- **It never slows the escalation it skips** — the underlying lockout still
  lengthens with each consecutive lockout.
- **Answers are graded against a single-use nonce** consumed before grading;
  wrong answers cannot be retried against the same question and right ones
  cannot be replayed. Challenges expire.

Two easy-to-miss rules that cost a rung when missed: a timed game cannot be
won faster than it lasts (early submissions are rejected), and each mole can be
hit only once against a genuinely visible target.

## Tone

Nothing here is a punishment. Copy is plain about the facts — how long is
left, how many tries remain, what winning actually gets you — at every funny
level and in every language mode.

## Verification status

Implemented in code (nonce grading in the main process). Rung-transition tests
are ROADMAP Phase 2 work.

## Suggested articles

- [Toy locks](toy-locks.md)
- [Support tickets](support-tickets.md)
- [Dim sum surprise](../personalization/dim-sum-surprise.md)
