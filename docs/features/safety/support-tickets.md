# Support tickets

## What it is

The recovery route for a forgotten toy lock, dressed as a support desk — and
the joke is the point. A locked-out user reaches it from the unlock prompt's
*Forgotten your password?* link, from the lock setting, and from Help.

## How it works

1. Fill a ticket: category, description. You get a locally generated ticket
   number, a severity nobody will honour, and a status that advances.
2. A canned first response arrives with the gravity of a service desk that has
   read the manual once.
3. The "resolution" does the only thing that actually works: **instructions to
   clear the app's data folder yourself**, with the exact path shown and
   copyable beside the button that opens it in your file manager.

## The plain line (unstyled by any funny level)

> Nothing is sent anywhere. No ticket exists outside this machine, no network
> request is made, no data is collected, and nobody is reading this.

This line appears on the desk itself so nobody sits waiting for a reply that
was never coming.

## Boundaries

- The desk **never deletes anything for you**. It opens the folder and stands
  back; deletion is your act in your own file manager. An in-app delete offer
  would be a destructive action behind super-confirmation, never a joke button.
- No real agent's name, no real company's branding, no real case-management
  system, no response time implying a human. The desk is this app's fictional
  one; impersonating a real organization's support is out of bounds.

Tickets are stored locally with everything else, searchable and exportable,
and cleared by exactly the same folder deletion they are pointing at — which
is either a design flaw or the funniest part of it, depending on your funny
level.

## Failure modes

If the file manager cannot be launched, the exact path is shown for manual
navigation instead of pretending the open succeeded.

## Security considerations

Nothing leaves the machine; the desk makes no network calls at all.

## Verification status

Implemented in code. Desk flow tests (create → list → resolve → disclosure
present) are ROADMAP Phase 2 work.

## Suggested articles

- [Toy locks](toy-locks.md)
- [Unlock ladder](unlock-ladder.md)
