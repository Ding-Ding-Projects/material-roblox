# Material Roblox v1.0.0-build.7


## Code name

**Abalone and Chicken Congee · 鮑魚雞粥** — [dish photo](https://github.com/Ding-Ding-Projects/dim-sum-photos/releases/download/catalog-v1/hk-dish-0212-abalone-chicken-congee.png)

Code names come once-per-project from the public dim-sum catalog at
Ding-Ding-Projects/dim-sum-photos. The photo links to the published public asset;
nothing is copied into this repository.

## Highlights

- Workflow YAML: quote the step name, restore the Node setup step
- Timestamp step moves below checkout, which was erasing it
- Notes step trusts the exported env first, file second
- Release notes step reads the env FILE, not its path
- Pipeline shakedown: ghost identifier and catalog reality fixes
- Adversarial pass: boot link fix plus eight confirmed defects closed
- Integrate site, workflows and documentation onto main
- One-click scripts trio at the repository root
- Site, workflows and repository documentation
- Restore the manifest the baseline only claimed to include
- Integration wiring: aggregator boot, lock probe, editor flag
- Integrate Roblox surfaces onto main

## Project size

| Area | Files | Lines | Non-blank |
| --- | ---: | ---: | ---: |
| App source · JavaScript | 64 | 32244 | 29388 |
| App source · HTML | 1 | 68 | 64 |
| Stylesheets (src/ + app/) | 7 | 5583 | 4799 |
| Tests | 0 | 0 | 0 |
| Site * | 20 | 4558 | 4175 |
| Scripts (scripts/) | 10 | 1770 | 1596 |
| Docs (docs/ + root *.md) | 48 | 3040 | 2325 |
| Workflows (.github/) | 2 | 330 | 273 |
| **Project total** | **152** | **47593** | **42620** |

_Tests: 0 lines — the test suite has deliberately not been written yet (the ultra-speed delivery pass skipped it; see ROADMAP.md)._

| Excluded from project total | Reason |
| --- | --- |
| .gitignore | not project source (tooling/config data) |
| assets/logo-mono.svg | not project source (tooling/config data) |
| assets/logo.svg | not project source (tooling/config data) |
| build-installer.bat | not project source (tooling/config data) |
| build.bat | not project source (tooling/config data) |
| download-dependencies.bat | not project source (tooling/config data) |
| electron-builder.yml | not project source (tooling/config data) |
| hooks/pre-push.sample | not project source (tooling/config data) |
| LICENSE | not project source (tooling/config data) |
| package.json | not project source (tooling/config data) |
| site/docs/api-coverage.md | not project source (tooling/config data) |
| site/docs/dev/CONTRACT.md | not project source (tooling/config data) |
| site/docs/features/appearance/app-logo-presets.md | not project source (tooling/config data) |
| site/docs/features/appearance/fonts-typography.md | not project source (tooling/config data) |
| site/docs/features/appearance/infinite-color-picker.md | not project source (tooling/config data) |
| site/docs/features/appearance/README.md | not project source (tooling/config data) |
| site/docs/features/appearance/theme-appearance-editor.md | not project source (tooling/config data) |
| site/docs/features/getting-started/index.md | not project source (tooling/config data) |
| site/docs/features/interface/bulk-actions.md | not project source (tooling/config data) |
| site/docs/features/interface/changelog-viewer.md | not project source (tooling/config data) |
| site/docs/features/interface/command-palette.md | not project source (tooling/config data) |
| site/docs/features/interface/exports.md | not project source (tooling/config data) |
| site/docs/features/interface/local-history.md | not project source (tooling/config data) |
| site/docs/features/interface/notifications.md | not project source (tooling/config data) |
| site/docs/features/interface/README.md | not project source (tooling/config data) |
| site/docs/features/interface/search-and-regex-builder.md | not project source (tooling/config data) |
| site/docs/features/interface/tabs.md | not project source (tooling/config data) |
| site/docs/features/personalization/adhd-modes.md | not project source (tooling/config data) |
| site/docs/features/personalization/dim-sum-surprise.md | not project source (tooling/config data) |
| site/docs/features/personalization/language-modes-funny-levels.md | not project source (tooling/config data) |
| site/docs/features/personalization/narrator.md | not project source (tooling/config data) |
| site/docs/features/personalization/personal-vocabulary-upload.md | not project source (tooling/config data) |
| site/docs/features/personalization/README.md | not project source (tooling/config data) |
| site/docs/features/personalization/scheduled-settings.md | not project source (tooling/config data) |
| site/docs/features/personalization/school-mode.md | not project source (tooling/config data) |
| site/docs/features/platform/auto-updater.md | not project source (tooling/config data) |
| site/docs/features/platform/embed-graphic.md | not project source (tooling/config data) |
| site/docs/features/platform/file-converter.md | not project source (tooling/config data) |
| site/docs/features/platform/line-counts-and-estimates.md | not project source (tooling/config data) |
| site/docs/features/platform/ollama-suite-manager.md | not project source (tooling/config data) |
| site/docs/features/platform/README.md | not project source (tooling/config data) |
| site/docs/features/platform/status-reporting.md | not project source (tooling/config data) |
| site/docs/features/safety/destructive-super-confirmation.md | not project source (tooling/config data) |
| site/docs/features/safety/README.md | not project source (tooling/config data) |
| site/docs/features/safety/session-cookie-handling.md | not project source (tooling/config data) |
| site/docs/features/safety/support-tickets.md | not project source (tooling/config data) |
| site/docs/features/safety/toy-locks.md | not project source (tooling/config data) |
| site/docs/features/safety/two-factor-authenticator.md | not project source (tooling/config data) |
| site/docs/features/safety/unlock-ladder.md | not project source (tooling/config data) |
| workflow-start.txt | not project source (tooling/config data) |
| node_modules/ | build output / dependencies — not project code |
| dist/ | build output / dependencies — not project code |
| out/ | build output / dependencies — not project code |
| release/ | build output / dependencies — not project code |
| coverage/ | build output / dependencies — not project code |
| .git/ | build output / dependencies — not project code |
| .vite/ | build output / dependencies — not project code |
| package-lock.json (and other lockfiles) | generated dependency manifests |
| *.png / binaries | binary assets carry no meaningful line count |

**Grand total (everything counted, exclusions included): 50243 lines**

| Attribution (surviving lines at HEAD) | Lines |
| --- | ---: |
| Agent-written | 47593 |
| Human-written | 0 |

> Method: per-file `git blame --porcelain`; a surviving line is agent-written when its blamed commit's author email contains "anthropic" or the commit carries a `Co-Authored-By:` trailer naming Claude; everything else is human-written. Deleted lines belong to nobody. Reproduce locally with `node scripts/count-lines.mjs`.


## Workflow timing

- **Workflow started:** 2026-08-22T20:18:20.0189260Z
- **Workflow completed:** 2026-08-22T20:20:18.1496850Z
- **Workflow duration:** 00:01:58

## Checks actually run

By standing project policy, **no tests and no lint ran** in Actions — nothing in
this workflow gates the release, so none is claimed. What actually ran:

- Dependency install (
pm ci)
- Electron runtime materialization + icon generation
- ^[lectron-builder --win squirrel packaging
- Artifact verification: Setup executable present, Get-AuthenticodeSignature
  confirms **NotSigned**, RELEASES and the full .nupkg present
- Documentation index, changelog data, social preview, and line count generation

## Installation notes (Windows 10+ x64)

Download `MaterialRobloxSetup.exe` below and run it. This is a genuine
Squirrel.Windows installer.

> [!WARNING]
> **This installer is unsigned — by permanent project policy, not by accident.**
> Windows SmartScreen and Microsoft Defender may show an unknown-publisher
> warning ("Windows protected your PC"). Choose *More info* → *Run anyway* if you
> trust this build. No authenticity or signature verification is claimed or implied.

A portable ZIP build is not offered.

