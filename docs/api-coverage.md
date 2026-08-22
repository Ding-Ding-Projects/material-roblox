# Roblox API coverage

Every Roblox platform endpoint Material Roblox uses, grouped by surface, with
authentication requirements and rate-limit notes. All traffic flows through the
main process against the host allowlist (`*.roblox.com`, `*.rbxcdn.com`);
the renderer never fetches cross-origin itself.

| Group | Endpoints (representative) | Auth | Rate-limit notes |
| --- | --- | --- | --- |
| Users | `GET /users/search`, `GET /users/{id}`, `POST /users/usernames/users` | Public | Search is throttled harder; client keeps ~150 ms spacing |
| Thumbnails | `GET /headshot-thumbnail`, `GET /full-body-thumbnail` (batch) | Public | Batch up to 100 ids per call; results cached locally |
| Friends | `GET /friends/{id}/count`, `GET /friends/{id}/followers?limit=…` | Public | Paginated with `cursor`; polite page pacing |
| Groups | `GET /groups/{id}`, roles, members count, shout wall (public fields) | Public | Shout history public only; no group-admin actions |
| Games | Universe/place details, icons, media, `favorites`/`visits` counts | Public | Icons batched like thumbnails |
| Badges | Badges for a universe, badge info, awarded dates | Public | Standard pacing |
| Catalog / Marketplace | `GET /search/items/catalog?…` with category/price/creator filters, item details, limited/serial info where public | Public | Search v2 endpoints preferred; 429 backs off exponentially |
| Inventory | `GET /users/{id}/canview-inventory`, asset-type inventories with pagination | Public (private inventories reported honestly as inaccessible) | Respects visibility rules — never scrapes around them |
| Economy (auth) | Robux balance, transaction summary | `.ROBLOSECURITY` required | Lowest-frequency polling of any surface |
| Presence (auth) | `POST /presence/presence-users` for saved users | `.ROBLOSECURITY` required | Respectful interval (minutes, not seconds); user-configured |
| Account info (auth) | whoami-style account metadata for session verification | `.ROBLOSECURITY` required | Called once on connect and after cookie changes |

## Cross-cutting behaviour

- **Client throttle**: ~150 ms between calls; exponential backoff on `429`
  honouring `Retry-After`.
- **Typed errors**: every failure surfaces a status-specific message with the
  recovery action at the surface that failed.
- **No scraping**: only documented REST endpoints; nothing requiring
  authentication renders fake empty states — it explains what connecting
  unlocks.
- **Bounded payloads** (default 5 MiB) and timeouts (15 s default) on every
  request through the allowlisted proxy channel.

## Verification status

Endpoint set implemented in code. Contract tests against live responses are
deliberately deferred (ROADMAP Phase 2); shapes follow the documented platform
APIs as of authorship.

## Suggested articles

- [Session cookie handling](features/safety/session-cookie-handling.md)
- [Getting started](features/getting-started/index.md)
