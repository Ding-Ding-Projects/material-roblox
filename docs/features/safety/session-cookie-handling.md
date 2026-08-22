# Session cookie handling

## What it is

Some Roblox surfaces (economy, presence) require your authenticated session.
Material Roblox accepts a `.ROBLOSECURITY` cookie through a secure paste flow
and stores it in the **OS-backed encrypted vault** (`safeStorage`), never in
localStorage, logs, or exports.

## How to use it

1. Open the **Session** tab.
2. Paste the cookie value into the masked field (it renders as dots; there is
   no reveal toggle — you paste it, you never need to read it).
3. The app verifies whoami, shows the account name, and marks connected
   surfaces as unlocked with an explanation of what each unlocks.
4. Disconnect deletes the vault entry immediately and says so.

The cookie value is injected only inside the main process on allowlisted
Roblox requests. The renderer can ask "am I connected?" but can never read the
value back.

## Configuration

| Aspect | Behaviour |
| --- | --- |
| Storage | OS credential vault via `safeStorage`, service `roblox` |
| Transport | Main process only, host allowlist (`*.roblox.com`, `*.rbxcdn.com`) |
| Renderer visibility | Presence boolean only — value never crosses IPC |

## Failure modes

- An expired or invalid cookie is reported at verify time with a re-connect
  action at exactly the surface that failed — not a dead-end error elsewhere.
- Vault unavailability (rare OS-level failure) fails closed: the app reports
  that it cannot store the secret rather than falling back to plaintext.

## Security considerations

- The paste field is masked and never logged, echoed, exported, or written to
  history snapshots.
- Requests carrying the cookie are bounded by size/timeout like every other
  network call; redirects to non-allowlisted hosts are rejected.
- Disconnecting revokes local storage only — sign out of Roblox in your
  browser if you want the session itself invalidated.

## Verification status

Implemented in code (vault + allowlist + masked flow). Automated tests are
ROADMAP Phase 2 work.

## Suggested articles

- [Local history](../interface/local-history.md)
- [Exports](../interface/exports.md)
- [Two-factor authenticator](two-factor-authenticator.md)
