# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest release | yes |
| older releases | best-effort; update first |

This project ships frequent unsigned releases with a Chrome-style updater;
running the latest build is the primary security control.

## Reporting a vulnerability

Open a GitHub issue marked `security` **without exploit details**, or contact
the maintainers through the Ding-Ding-Projects organization. You will get an
acknowledgement and a fix-or-decision within a reasonable window. Please do not
open pull requests containing unreported exploit paths.

## Security posture

### Process isolation

- Electron 33 with `contextIsolation: true`; the preload exposes one generic
  validated bridge (`invoke`/`on`) — no direct `ipcRenderer` surface, no
  Node in the renderer.
- Strict Content-Security-Policy delivered as a meta tag: `default-src 'self'`,
  images restricted to self/https/data, styles self + inline tokens.

### Network

- All Roblox/API traffic happens in the main process against a host allowlist
  (`*.roblox.com`, `*.rbxcdn.com`, this repository's own API endpoints).
  The renderer never fetches cross-origin itself.
- Requests are bounded (size + timeout), redirects to non-allowlisted hosts are
  rejected, and no ambient network access exists anywhere else — the file
  converter's sandbox runs with networking disabled entirely.

### Secrets

- Session cookies, TOTP seeds, and lock credentials live only in the
  OS-backed encrypted credential vault via `safeStorage`. They never enter
  localStorage, logs, exports, history snapshots, screenshots, or Git history.
- The renderer can ask whether it is connected; it cannot read secret values
  back across IPC.
- Exports exclude secrets by default and say so; deliberate secret export is a
  separate named action behind super-confirmation.

### Signing stance (transparency)

Installers are **unsigned by permanent project policy**. Consequences stated
plainly:

- Windows SmartScreen / Microsoft Defender will warn about an unknown
  publisher; you choose *Run anyway* at your own discretion.
- Update integrity relies on HTTPS transport plus package hash validation and
  staged swap with rollback — **not** on signature verification, which is never
  claimed anywhere.
- If you need signed software as a hard requirement, this project is not the
  right fit today; that stance is durable, not an oversight.

## Known limitations

- A malicious local process with your user privileges could read vault contents
  exactly as any other app's vault data; the OS is the boundary there.
- The unlock ladder and toy locks are user-experience features, deliberately
  not security boundaries, and are documented as such everywhere they appear.
