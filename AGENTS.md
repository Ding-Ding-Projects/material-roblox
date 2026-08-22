# AGENTS.md

Engineering rules for any agent (or human) working in this repository. This
file is a **sanitized mirror** of shared engineering rules: it contains
ordinary English only, no machine names, paths, credentials, or private
identifiers, and it is never edited to diverge from the canonical source — the
canonical rules live in a separate private instructions repository and are
mirrored here so any contributor sees them without needing access to that.

## Language hygiene

- This is a public repository. Every committed file — source, comments, docs,
  commit messages, issues, releases, the website — uses ordinary English.
- Commit messages are bilingual: a concise factual English subject plus a
  playful Hong Kong-style Cantonese line in the body saying the same thing.
  Humour roasts the old code, never people; facts stay exact.

## Working discipline

- **Pull before work.** Inspect for uncommitted changes, fetch, and reconcile
  with the normal non-destructive policy before using the tree as a base.
- **Contract first.** `docs/dev/CONTRACT.md` owns module boundaries and
  conventions; fix code or contract together, never let them drift.
- **Scoped changes with proportionate checks.** Run the checks your change
  actually affects locally in the changing task; their verdicts inform the work
  even though CI does not gate on them (below).
- **Preserve unrelated work.** Never discard, reset, or overwrite someone
  else's uncommitted changes to make a pass look complete.
- **No force-push.** History rewriting requires an explicit reviewed request
  from the owner; a mistake is fixed with a forward commit.

## Completion and integration

- Work merges into the default branch and pushes; branch-only or stash-only
  endings are not completion.
- Clean up only what the task itself created, after proving each removed ref is
  merged into the pushed default branch. Anything holding uncommitted,
  unmerged, or unpushed work is kept and reported.
- Keep `README.md`, feature docs under `docs/`, this file, `ROADMAP.md`
  (checklist format), and `HANDOFF.md` current in the same task that changes
  behaviour.
- Scan open issues on every touched repository during the task; fix actionable
  ones automatically, comment blockers honestly, close only verified fixes.

## CI and releases

- **GitHub Actions runs no tests and no lint. Nothing gates a release.**
  A workflow builds, packages, publishes, and attaches evidence — that is its
  whole job. Local checks still run in the task that changes code; they just
  never block a build. This is a standing owner decision: do not reintroduce
  gating steps "to be safe".
- Every successful run publishes exactly one new, uniquely tagged, non-draft
  release carrying a real installer.
- Windows delivery only: genuine Squirrel.Windows (`Setup.exe`, `RELEASES`,
  full `.nupkg`, deltas where available) for every supported installer. Other
  installer technologies are migrated away, not kept as fallbacks.
- **Permanent no-signing policy:** never request, generate, store, or invoke a
  code-signing certificate or signer service. Installers ship unsigned with
  prominent disclosure in release notes and install instructions.
- Release notes include end-to-end workflow timing, the line-count table from
  the committed counter, the checks that actually ran (and explicitly which did
  not), the unsigned disclosure, and install guidance including SmartScreen
  warnings.
- Runner selection prefers a compatible online self-hosted runner, falling back
  to a pinned cloud image. Every job bootstraps its own dependencies from
  canonical upstreams into user-scoped cacheable locations.
- Safe outputs upload behind `if: ${{ always() }}` with bounded retention so
  failed builds keep their evidence.

## Dependencies and bundling

- Apps bundle every dependency they need inside the installer; "install X and
  try again" wording anywhere is a defect. Prefer portable distribution forms;
  never require elevation where a user-scoped path exists.
- One-click scripts at the root (`build.bat`, `build-installer.bat`,
  `download-dependencies.bat`) fetch their own dependencies, pin versions,
  verify recorded digests, stay idempotent and silent-capable, and report each
  phase honestly. They never touch signing or secrets.
- Never commit installed dependencies, lockfile churn from incidental installs,
  or absolute local toolchain paths.

## Quality minimums

- Accessibility is a completion blocker, not polish: keyboard reachability,
  visible focus, correct roles/names/states, WCAG AA contrast in both themes,
  reduced-motion respect, adequate touch targets.
- No clipped or truncated content at narrow widths or 100–200% scale; validate
  longest localized strings.
- Decorative-looking UI must be functional or plainly labelled as a static
  preview.
- Destructive actions get the two-key super-confirmation gate; informational
  messages use non-blocking notifications.

## Public-repo language note

Private conversational vocabulary, if you use one elsewhere, never appears in
this repository — not in prose, identifiers, comments, or generated files.
This mirror intentionally describes rules without reproducing any private
terms.

## Vocabulary hash lock — method only

Builds may be gated on possession and currency of a canonical agent-instructions
dictionary:

1. The dictionary itself is **never committed here** — committing it would leak
   it, and a Chut enforced by publishing the private thing has defeated itself.
2. Its **hash is also never committed**: a pinned digest goes stale when terms
   change and becomes a ritual somebody bumps instead of a check.
3. Instead, builds derive the digest at run time from the private source and
   compare against a lock file that lives **beside that private source**, outside
   every public repository.
4. Fail-open for outsiders (no private source configured → skip with reason),
   fail-closed for staleness (source present but lock missing/mismatched →
   refuse).
5. Honest limitation: this proves possession and currency of the dictionary,
   nothing more. It cannot prove how anyone spoke while working; that duty stays
   per-author, checked per reply.

Reference implementation pattern: `scripts/check-vocabulary.mjs` in this
repository, with a sample pre-push hook at `hooks/pre-push.sample`.

---

*Sanitized mirror — label kept visible so nobody edits this file expecting
changes to propagate. Canonical rules live in the private instructions
repository.*
