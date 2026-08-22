# Local history

## What it is

Every user-managed record the app owns — documents, settings, accounts,
connected sessions, generator rules — is snapshotted into a **local,
Git-backed version history** kept in an isolated repository beside the app's
data directory (never a `.git` inside your own folders). Any creation, edit, or
deletion can be undone.

## How to use it

- Open **History** from any record's context menu or the command palette.
- Browse revisions with labels that say what changed ("Deleted the GitHub
  account", not "Updated"). Unchanged states record nothing.
- **Restore is itself recorded as a new revision**, never a rewrite: undo can
  be undone, and that undo undone. History is append-only; a destructive
  restore that discards what it replaced would make experimenting unsafe, so
  the app does not have one.
- **Filter** by date (advanced calendar with month/year jump, range, presets,
  typed ISO dates validated inline without discarding what you typed) and by
  action — the real actions derived from the history itself (created, updated,
  deleted, restored, undone, imported, settings changed) with counts beside
  each, composable with text search carrying the regex builder.

## Configuration

Retention and pruning are explicit policies you set; nothing auto-deletes
without one. Restores of settings restore the configuration that ran *with*
those settings — restoring an account without its configuration would be a
subtly wrong state.

## Failure modes

- A history write failure never fails the operation you actually asked for;
  it logs and carries on.
- Snapshots preserve whatever encryption live data uses: ciphertext stays
  ciphertext, so history is never more sensitive than its store. Encryption
  binding uses stable identifiers that survive delete-and-restore cycles, not
  row ids that change under them.

## Security considerations

Secret-bearing records enter history only as redacted metadata or encrypted
snapshots whose keys stay in the OS credential vault. Plaintext secrets never
become Git data.

## Verification status

Implemented in code. Restore/undo interaction tests are ROADMAP Phase 2.

## Suggested articles

- [Exports](exports.md)
- [Notifications](notifications.md)
- [Session handling](../safety/session-cookie-handling.md)
