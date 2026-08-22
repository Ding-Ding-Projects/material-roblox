# Development and building

How to build Material Roblox from source, how it is put together, and which
standing decisions shape both.

## Build from source

```bat
git clone https://github.com/Ding-Ding-Projects/material-roblox.git
cd material-roblox
build.bat
```

`build.bat` assumes a fresh Windows install and touches nothing by hand: it
installs every dependency it needs (Node, npm packages, the pinned Electron
runtime) into user-scoped locations, builds the real app, verifies the
binary exists, then offers to launch it.

| Script | What it does |
| --- | --- |
| `build.bat` | One-click build; `/s`, `--silent`, or `SILENT=1` runs with no prompts for CI and agents |
| `build-installer.bat` | Produces the same unsigned Squirrel installer the release workflow publishes (`Setup.exe`, `RELEASES`, `.nupkg` under `dist\squirrel-windows\`); never publishes, never tags |
| `download-dependencies.bat` | Fetches every build/test dependency from canonical upstreams into user-scoped locations; `build.bat` calls it rather than duplicating it |

Both root scripts are idempotent — a warm checkout re-verifies and skips
what is already present — report each phase honestly, exit non-zero on the
first real failure, and never touch signing credentials or certificates.

## Architecture in one page

- **Stack** — Electron 33 with a vanilla-JavaScript ES-module renderer. No UI
  frameworks, no CDN assets, everything bundled at build time.
- **Process split** — all network access lives in the main process behind an
  allowlisted proxy channel (`*.roblox.com`, `*.rbxcdn.com`, this
  repository's own Releases/Pages hosts). The renderer talks to it through
  exactly one validated generic bridge exposed by the preload script:
  `window.mrb.invoke(channel, payload)` plus `on(channel, cb)`.
- **Secrets** — session cookie, TOTP seeds, and lock credential hashes live
  only in the OS-backed encrypted vault over `safeStorage`. Never in
  localStorage, logs, or exports.
- **Renderer core** — small single-purpose modules under `src/js/core/`
  (store, i18n, ui helpers, router/tabs, settings, appearance, locks,
  authenticator, narrator, ADHD modes, dim sum, vocabulary, colour picker,
  converter, Ollama manager, updater, scheduler, VS Code integration), each
  self-registering during boot; one failing feature degrades alone instead of
  killing the app.
- **Roblox surfaces** — `src/js/features/roblox/`: an API layer plus one file
  per tab, sharing search-bar, card, and thumbnail components.
- **Styling** — Material Design 3 role tokens as `--mrb-*` custom properties
  for light and dark, component classes prefixed `.mrb-`, per-feature
  stylesheets injected by their owning module.

The full specification — ownership map, IPC channel catalogue, exact module
exports, bootstrap order, CSS and i18n conventions, accessibility minimums —
is the [development contract](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/dev/CONTRACT.md).
If code and contract disagree, one of them is fixed in the same change.

## Repository scripts

| Script | Purpose |
| --- | --- |
| `scripts/ensure-electron.mjs` | Materialize the pinned Electron binary into `node_modules` |
| `scripts/gen-icons.mjs` | Generate app icon assets |
| `scripts/gen-social-preview.mjs` | Draw the Open Graph image pair and assert the two copies are byte-identical |
| `scripts/count-lines.mjs` | The exact line-count table every release publishes |
| `scripts/build-changelog.mjs` | Changelog data for the site from git tags |
| `scripts/build-docs-index.mjs` | Docs index plus site copy of feature articles |
| `scripts/release-meta.mjs` | Release tag plus once-per-project dim-sum code name from the public catalog |
| `scripts/fetch-fonts.mjs` | Optional complete font vendoring (never run by CI) |
| `scripts/check-vocabulary.mjs` | Vocabulary hash-lock method; fails closed when stale, fail-open for outsiders |
| `scripts/audit-imports.mjs` | Static import/export link auditor over renderer ES modules — catches dangling named imports before they become link-time SyntaxErrors |
| `scripts/check-workflows.mjs` | Workflow structure auditor committed alongside the import auditor |

## Packaging

Windows only, via genuine Squirrel.Windows through electron-builder:

- Output lands in `dist/squirrel-windows/`: setup executable, `RELEASES`
  manifest, full `.nupkg`.
- **Code signing is permanently prohibited** on this project. Signing inputs
  are cleared explicitly in the workflow, and a verification step asserts the
  built installer reports `NotSigned` — a *valid* signature fails the run.
  Expect the SmartScreen unknown-publisher warning; release notes say so.
- There is no portable ZIP distribution by decision: Squirrel is the only
  supported install route so update integrity stays in one place.

## CI workflows

Two workflows, both triggered on push and dispatch:

- **Release** (`.github/workflows/release.yml`) — builds the unsigned
  Squirrel installer, asserts it is unsigned and complete, generates the line
  count table, changelog data, docs index, and social preview, computes the
  tag and code name, then publishes exactly one new uniquely tagged non-draft
  GitHub Release carrying the installer, timing, and evidence.
- **Pages** (`.github/workflows/pages.yml`) — deploys the static site to
  https://ding-ding-projects.github.io/material-roblox/.

Standing decisions baked in (do not undo without an owner decision recorded
in the repository):

1. **Actions runs no tests and no lint.** A workflow builds, packages,
   publishes, attaches evidence — that is the whole job. Checks happen where
   a human asked for them: locally, in the task that changed the code.
2. Every push to `main` produces exactly one new release; no test or lint
   verdict can gate or withhold it.
3. Token resolution follows `RELEASE_TOKEN || ORG_TOKEN || GITHUB_TOKEN`.

## Verification status — honest

Automated tests and built-artifact screenshot captures were deliberately
skipped during the ultra-speed delivery pass that produced Phase 1. That is
tracked, unticked, in
[ROADMAP Phase 2](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/ROADMAP.md)
rather than hidden. The local checks that do exist and run green are the two
auditor scripts above (`audit-imports.mjs`, `check-workflows.mjs`); run them
with Node after changing imports or workflows.

## Project scale

At release `v1.0.0-build.7`: **47,593 project lines (42,620 non-blank)**
across 152 files. Reproduce with:

```bat
node scripts\count-lines.mjs
```

Every release publishes the full table with exclusions and attribution
stated.
