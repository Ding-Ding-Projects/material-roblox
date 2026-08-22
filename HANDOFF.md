# Handoff

Factual handoff for the next owner of this repository. Everything below was
true at authorship time; update rather than trust where the tree has moved on.
Last refreshed 2026-08-22 after the first releases shipped and the post-release
hardening lanes started.

## Where the project stands

Phase 1 shipped. Two real releases exist and are verified:

- `v1.0.0-build.7` — published non-draft, installer verified downloadable,
  carries the full Phase 1 feature set, CI-counted line table, workflow
  timing, and a dim-sum code name from the public catalog. The README line
  counts and human-time estimate quote this release's table.
- `v1.0.0-build.8` — same pipeline, published non-draft and verified
  downloadable.

The website is live at
https://ding-ding-projects.github.io/material-roblox/ with Open Graph tags
served in markup (`og:title/description/url/type/site_name/image` plus
dimensions/alt and `twitter:card summary_large_image`). The repository
homepage field points at that URL.

## Scope delivered

The ultra-speed delivery pass produced a complete first implementation across
six lanes working from `docs/dev/CONTRACT.md`:

- **Lane A (shell)** — Electron main/preload, IPC modules, bootstrap, core
  stores, packaging config, build scripts (`ensure-electron.mjs`,
  `gen-icons.mjs`).
- **Lane B (Roblox)** — API layer and every Roblox surface tab.
- **Lane C (core UX)** — regex builder, palette, notifications centre,
  exporter, bulk actions, history.
- **Lane D (delight)** — locks, ladder, Support Tickets, authenticator, QR,
  narrator, ADHD modes, dim sum, vocabulary.
- **Lane E (tools)** — appearance, colour picker, converter, Ollama manager,
  updater, scheduler, VS Code integration.
- **Lane F (site/repo)** — static site, documentation set, root docs,
  workflows, site/release scripts.

Post-release work then landed on top:

- **Adversarial bug-hunt pass** — eight fixes landed in commit `8087d25`
  after the multi-lens review of the shipped changes.
- **Auditor scripts** — `scripts/audit-imports.mjs` (static import/export
  link auditor over renderer ES modules) and `scripts/check-workflows.mjs`
  (workflow structure auditor) are committed and run green. Note for whoever
  reads a partial tree: in this documentation lane's snapshot only
  `audit-imports.mjs` was present on disk under `scripts/`; the pair lands
  together through the auditors lane's integration.
- **Wiki content** — `docs/wiki/` now holds the five wiki pages
  (`Home.md`, `_Sidebar.md`, `Features-Overview.md`,
  `Development-and-Building.md`, `FAQ.md`) plus a README explaining the
  mirror. See the manual step below before expecting them on the wiki.
- **Records refreshed** — `CHANGELOG.md` gained its real `[1.0.0] -
  2026-08-22` section (Keep-a-Changelog format, `[Unreleased]` left empty
  above it), and `ROADMAP.md` gained the dated Phase 1.5 post-release
  hardening checklist naming the four in-flight lanes.

## Release pipeline shakedown history (do not rediscover these)

Each of these cost a release-run failure to find. They are fixed in the tree;
this list exists so nobody relearns them from scratch:

1. **Ghost identifier** — a workflow expression referenced an identifier that
   did not exist, so the expansion silently produced an empty value instead
   of an error and the run failed later with a misleading message. Fix:
   explicit step outputs bound by id, plus a fallback read path, so a missing
   value fails loudly where it is produced.
2. **Catalog field** — the code-name step initially read the wrong JSON field
   of the public dim-sum catalog entry. The bilingual names live under
   `name.en` / `name.zhHant`; `scripts/release-meta.mjs` reads exactly those
   (with a legacy `zh` fallback).
3. **Env parsing** — `GITHUB_ENV` is the *path* of the env file, not its
   contents. Reading it as if it were the file body produced empty metadata.
   The notes-assembly step now reads the exported variable directly and uses
   the env-file parse only as fallback.
4. **Checkout-erased timestamp** — recording the workflow start timestamp
   before checkout meant the workspace clean wiped it. Fix visible in
   `release.yml`: the timestamp step runs *after* checkout, writes both a
   step output and a `workflow-start.txt` file, and the duration is reported
   as `--missing--` rather than estimated when either stamp is unavailable.
5. **YAML step-name colon** — an unquoted step name containing a colon breaks
   YAML parsing. Any step name with punctuation gets single-quoted (see the
   timestamp step's name).

## Verification state — honest

- Releases: verified. Both tags published non-draft with downloadable
  Squirrel artifacts (`Setup.exe`, `RELEASES`, `.nupkg`), unsigned by policy
  with the `NotSigned` assertion green in the pipeline.
- Site: verified live, OG tags served; embed rendering in Discord should be
  spot-checked once more whenever the preview image changes meaningfully
  (the crawler caches aggressively — change the URL, not just the bytes).
- Auditors: green (see note above about which script was observed where).
- Tests: **still none** — deliberate during the ultra-speed pass, tracked
  unticked in ROADMAP Phase 2. A tests lane is in flight under Phase 1.5.
- Captures: **still none** — no built-artifact screenshot evidence has been
  published, and nothing fake stands in for it. A captures lane is in flight
  under Phase 1.5.
- Installer lifecycle (install → update → uninstall) has not been exercised
  end-to-end locally; ROADMAP Phase 2 tracks it before any stable promotion.

## Remaining known gaps / manual steps

1. **Tests lane** — in flight (Phase 1.5). Do not tick anything in
   ROADMAP until its evidence exists.
2. **Captures lane** — in flight (Phase 1.5); every user-facing
   surface needs a real built-artifact capture eventually.
3. **Polish-fixes lane** — in flight (Phase 1.5).
4. **Wiki initialization is manual.** The wiki Git remote returns 404 until
   the first page is created through the web UI (Settings → Wiki → create
   *Home*); there is no API route to initialize an empty wiki. After that
   first page exists, copy `docs/wiki/*.md` up (see `docs/wiki/README.md`).
   Until then the wiki does not exist, however complete `docs/wiki/` is.
5. **Discussion pinning is manual.** Pinning a Discussion has no API field,
   so pinning/unpinning the changelog Announcement thread can only be done
   in the web UI by a human.
6. **Status Hub emission-schema drift** belongs to the Status Hub project,
   not this repository — recorded here so nobody goes hunting for a fix owed
   here. Nothing in material-roblox depends on it.
7. Repository-root social preview upload (Settings → General → Social
   preview → upload the root `social-preview.png`) remains a manual step;
   the served Pages copy is already generated and byte-checked by CI.
8. ROADMAP Phase 2 leftovers beyond the two lanes above: design-reference
   parity captures, accessibility audit pass, local install/update/uninstall
   verification.

## External dependencies

- GitHub Releases + Actions publication rights on this account (token chain
  wired: `RELEASE_TOKEN || ORG_TOKEN || GITHUB_TOKEN`).
- Public dim-sum catalog reachability affects only the cosmetic code name;
  releases never block on it.
- Google Fonts reachability affects only the optional font vendoring script;
  the app and site ship system stacks regardless.

## Working agreements still in force

See `AGENTS.md` (sanitized engineering rules) and `docs/dev/CONTRACT.md`
(module boundaries). Notably: no tests/lint in Actions (standing decision),
permanent no-signing policy, Squirrel-only Windows installers, bilingual
commit messages with the single fixed co-author trailer, ordinary English in
every committed file.
