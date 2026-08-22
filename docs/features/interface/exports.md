# Exports

## What it is

Every record, view, list, log, document, and setting the app owns can leave the
app. A surface that renders data with no way out of it is incomplete, and
"you can copy it from the screen" is not an export.

## How to use it

1. Select data (a list, a profile card, a chat session, history entries).
2. Choose **Export** — or open the command palette and type "export".
3. Pick a format. The offer is per-datum, not one favourite:

| Data shape | Formats |
| --- | --- |
| Tabular | CSV, TSV |
| Structured records | JSON, JSONL/NDJSON, YAML, TOML, XML |
| Prose / reports | Markdown, HTML |
| Queryable | SQL (INSERT statements) |
| Archives | ZIP (7z options where applicable: LZMA2/LZMA/PPMd/BZip2/Deflate, levels store→ultra, AES-256 content **and** encrypted headers so filenames hide too) |

4. State what is lost *before* running: if a format cannot carry a field, the
   dialog names it up front rather than truncating quietly.
5. Round trips are real wherever the shape allows: exported settings import
   back; exported lists re-import.

Exports state their encoding (UTF-8 unless there is a reason), line endings,
and schema/version so another tool can read them. After saving, one action
opens the file or folder in VS Code as a workspace root when VS Code is
installed — and says so honestly when it is not.

## Configuration

Export location uses the native save dialog each time; there is no hidden
default directory that quietly accumulates files.

## Failure modes

- Cancelled exports write nothing.
- A failed write surfaces the OS error with the target path, not a generic
  failure toast.

## Security considerations

Secret-bearing fields (session cookie values, TOTP seeds, vault contents) are
**excluded by default and the exclusion is stated in the export summary**, not
silently dropped. Deliberate secret export is a separate named action behind
super-confirmation that warns it writes usable secrets in the clear.

## Verification status

Implemented in code. Format round-trip tests are ROADMAP Phase 2.

## Suggested articles

- [Bulk actions](bulk-actions.md)
- [Local history](local-history.md)
- [Two-factor authenticator](../safety/two-factor-authenticator.md) (export omits secrets, and says so)
