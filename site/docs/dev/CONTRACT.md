# Material Roblox — development contract

This document is the single source of truth for module boundaries, exported APIs,
IPC channels, bootstrap order, and conventions. Every implementation lane works
from it. If code and contract disagree, fix the code or update this file in the
same change — never let them drift silently.

---

## 0. Language rules for everything committed here (CRITICAL)

1. This is a **public repository**. All source files, comments, docs, commit messages,
   issues, releases, and the website use **ordinary English** (plus playful Hong Kong-style
   Cantonese in commit bodies and localized copy where required).
2. Never write any private conversational vocabulary term into any file in this
   repository — no exceptions beyond ordinary technical English.
3. Commit messages: concise factual English subject; body adds a playful Cantonese line
   saying the same thing; humor roasts the old code, never people; facts stay exact.
4. Every commit ends with exactly:

   ```
   Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
   ```

   and has author/committer `Claude Fable 5 <noreply@anthropic.com>`.

## 1. Stack

- Electron 33 (Chromium ESM renderer), vanilla JavaScript ES modules, zero UI frameworks,
  zero CDN assets, all dependencies bundled by npm at build time.
- Packaging: electron-builder 26 + squirrel.windows 26.15.3 → unsigned Squirrel installer
  (signing is permanently out of scope for this project).
- Renderer persistence: `localStorage` via the store module; larger blobs and secrets via IPC.

### Repository layout & ownership map

| Path | Owner |
| --- | --- |
| `app/main.js`, `app/preload.js`, `app/ipc/{window,dialog,shell,vault,net}.js`, `src/index.html`, `src/main.mjs`, `src/styles/{tokens,base,components}.css`, `src/js/core/{store,i18n,ui,router,settings,school}.js`, `assets/`, `scripts/ensure-electron.mjs`, `scripts/gen-icons.mjs`, `electron-builder.yml` | Lane A (shell) |
| `src/js/features/roblox/**`, `src/styles/features/roblox.css` | Lane B (Roblox) |
| `src/js/core/{regexbuilder,palette,notify,history,exporter,bulk}.js`, `src/styles/features/coreux.css` | Lane C (core UX) |
| `src/js/core/{locks,ladder,authenticator,narrator,adhd,dimsum,vocabulary,qr}.js`, `src/styles/features/delight.css` | Lane D (delight) |
| `src/js/core/{appearance,colorpicker,converter,ollama,updater,schedule,vscode}.js`, `src/styles/features/tools.css` | Lane E (tools) |
| `site/**`, `docs/**`, root docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `ROADMAP.md`, `HANDOFF.md`), `.github/workflows/*.yml`, `scripts/count-lines.mjs`, `scripts/release-meta.mjs`, `scripts/gen-social-preview.mjs`, `social-preview.png` | Lane F (site/repo) |

Lanes never edit files outside their ownership. Cross-lane needs go through the
registries defined below.

## 2. Process model & security posture

- Main process (`app/main.js`): frameless `BrowserWindow`
  (`titleBarStyle:'hidden'`, custom `.mrb-titlebar` drag region with min/max/close buttons),
  single-instance lock, strict CSP delivered as a meta tag in `index.html`
  (`default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'`).
- Preload exposes **only** a generic bridge:

  ```js
  window.mrb = {
    invoke(channel, payload) -> Promise<any>, // validated allowlist
    on(channel, cb) -> unsubscribe,
    platform, versions
  }
  ```

- Handler modules live in `app/ipc/<area>.js`; each exports
  `register({ ipcMain, win })`. `main.js` requires every `app/ipc/*.js` and calls
  `register` — lanes add handlers by adding a file, never by editing `main.js`.
- Channel names match `^[a-z]+:[a-z]+$`.
- All Roblox/network traffic happens in main via the `net:*` / `roblox:*` channels;
  the renderer never fetches cross-origin itself (images may load directly via `<img>`).
- Secrets (session cookie, TOTP seeds, lock passwords-hashes) live only in the OS-backed
  encrypted vault (`vault:*` over `safeStorage`), never in localStorage, logs, or exports.

## 3. IPC channel catalogue

| Channel | Payload → Result | Notes |
| --- | --- | --- |
| `win:minimize/maximize/close` | `{}` | titlebar controls |
| `dialog:open` | `{filters?, multi?, dir?}` → `string[] \| null` | native picker |
| `dialog:save` | `{defaultName, filters?}` → `path \| null` | |
| `shell:openExternal` | `{url}` (https only) | |
| `shell:openPath` / `shell:showItemInFolder` | `{path}` | |
| `vault:get/set/delete/list` | `{service,key[,value]}` → string/null | safeStorage file store |
| `net:get/post` | `{url, headers?, timeoutMs?=15000, maxBytes?=5242880, body?}` → `{status,json?,text?}` | host allowlist: `*.roblox.com`, `*.rbxcdn.com`, `raw.githubusercontent.com/Ding-Ding-Projects/*`, release asset hosts for this repo, `api.github.com/repos/Ding-Ding-Projects/material-roblox*` |
| `roblox:fetch` | `{url|path, method?, body?, auth?}` → parsed JSON | `auth:true` injects `.ROBLOSECURITY` from vault service `roblox`; cookie value NEVER returned to renderer |
| `hist:append/query/get/restore/prune/export` | see history.js | isomorphic-git repo at `userData/history` |
| `totp:{put,list,code,verify,remove}` | RFC 6238 in main | secrets stay in vault |
| `ladder:{start,answer}` | nonce challenges graded in main | renderer never sees answers pre-grade |
| `update:{check,download,restart}` | GitHub Releases based | unsigned-feed disclosure |
| `ollama:request` | `{path,method,body}` → loopback `127.0.0.1:11434` only | streaming via events `ollama:chunk` |
| `converter:run` | `{adapter,args,inputPath,outputPath}` → utilityProcess sandboxed job | bounded bytes/time |
| `export:write` | `{path,dataB64}` → `{ok,bytes}` | bounded 64 MiB |

Every handler: validate payload shape, bound sizes/timeouts, never echo secrets,
return `{ok:true,...}` or throw an `Error` with a user-actionable message.

## 4. Renderer core modules — exact exports

All under `src/js/core/`. Each module also exports `async function init()`;
the boot sequence calls them in §5 order, wrapped in try/catch so one failing
feature degrades alone (log + disable its surface, never kill the app).

```js
// store.js
export const store = {
  get(key, fallback), set(key, value), remove(key),
  onChange(key, fn) -> unsubscribe,      // CustomEvent 'mrb-store-change'
};
// keys are namespaced 'mrb:' automatically; values JSON-serialized

// settings.js
export const settings = {
  get(path, fallback?),                   // dot path e.g. 'appearance.theme'
  set(path, value),                       // records history entry kind 'settings'
  reset(prefixOrAll),                     // 'appearance' resets group; '*' all
  register(defs),                         // SettingDef[] merged at boot by each lane
  defs(),                                 // all registered definitions
  provenance(path),                       // {source:'user'|'default', default}
  onChange(fn)
};
// SettingDef: { key, type:'toggle'|'slider'|'select'|'text'|'color'|'font'|'path'|'hotkey',
//   def, group, label:{en,yue}, explain:{en,yue}, options?:[{value,label:{en,yue}}],
//   min?,max?,step?, unit? }

// i18n.js
export const i18n = {
  t(key, params?),                        // en→yue→key fallback chain
  lang(): 'en'|'yue'|'bi', setLang(mode), // 'bi' renders both, primary first
  funny(lang): 1..5, setFunny(lang, n),
  voice(category, text): string,          // applies per-language funny-level styling;
                                          // categories: info|ok|warn|error|destructive|neutral
                                          // facts inside `text` are never altered
  schoolActive(): boolean,
  applyVocabulary(text): string,          // personal vocabulary replacements
  loadVocabularyFile(fileObj): Promise<{ok, count}|{ok:false, error}>,
  clearVocabulary(),
};

// ui.js
export const ui = {
  el(tag, attrs?, ...kids),               // hyperscript helper
  injectCss(url),                         // dedup <link> injection for feature css
  toast({title, body, tone='info'|'ok'|'warn'|'error', timeoutMs?, actions?, sticky?}) -> id,
  dismissToast(id),
  anchored(anchorEl, panelEl, opts?) -> closeFn, // paints own surface/border/elevation,
                                                 // viewport-bounded, scrolls internally,
                                                 // never covers anchor, Escape closes,
                                                 // focus returns to anchor
  modal({title, build(bodyEl), actions}) -> closeFn, // blocking decisions ONLY
  superConfirm({title, detailHtml, confirmLabel, onConfirm}), // two independent keys +
                                                              // full-range slider gate +
                                                              // progress/completion anims +
                                                              // always-visible emergency exit
  copyText(text), fmtBytes(n), debounce(fn, ms), escapeHtml(s),
};

// router.js — browser-style tab strip, docks left by default
export const router = {
  registerTab(def),                       // {id,title,icon,render(el,ctx),ctxMenuItems?,
                                          //  closable=true, group?}
  navigate(id), current(), list(), setDock(edge), dock(),
  pin(id,on), createGroup(name,color), renameGroup(id,name,color),
  moveTab(tabId, groupIdOrNull), toggleGroup(groupId,collapsed), groups(),
  search(query,{mode:'plain'|'regex',flags,scope:'strip'|'groups'|'groupNames'|'all'}),
  bulkClose(match,{negate=false,includePinned=false,mode,flags}) -> {preview(),apply()},
  editAppearance(target),                 // delegates to appearance editor (anchored)
};
// Tab context menu carries: pin/unpin, move…into group…(picker), duplicate, close,
// close others, Edit tab appearance…, Lock this tab…
// Shift+right-click opens the appearance editor directly when the platform allows.

// school.js — shared School mode record (single switch across the user's apps)
export const school = {
  active(), set(active,{credentialOk}),   // persists to shared app-data record via fs watcher IPC
  credential: { set(pw), verify(pw), remove() }, // hash stored in vault
  displayName(), setName(name),           // user-renamable mode name
  onChange(fn)                            // live propagation, no restart needed
};
```

## 5. Bootstrap order (`src/main.mjs`, owned by Lane A)

```
store → school → i18n(+vocabulary cache reload) → ui → appearance → narrator → adhd
→ router (mounts strip + registers Settings/Home tabs) → roblox surfaces → notify center
→ palette → locks/ladder/authenticator → dimsum → converter → ollama → updater → schedule
→ history panel registration → ready
```

Lane A writes the imports for ALL modules listed above (paths fixed by this contract);
each module self-registers its tabs/palette entries/settings during `init()`.

## 6. Registries used across lanes

```js
// palette.js (Lane C)
palette.register({ id, title, keywords?, group, action?, control?(rowEl)?, teleport? });
// Ctrl+Shift+F opens; rows render live controls when `control` provided; selecting a
// result teleports: navigate → reveal → focus → brief highlight.

// notify.js (Lane C) wraps ui.toast and adds a reviewable centre:
notify.center(), notify.search(...), bulk actions + export honoured filters.

// regexbuilder.js (Lane C)
attachSearch(inputEl, {onQuery(q,{mode,flags}), placeholder?}) -> controller
openBuilder(inputEl)  // guided literals/classes/anchors/groups/alternation/quantifiers
                      // + raw editor + flags(gimsuy) + sample text + live matches +
                      // capture groups + copy/export; engine = JS RegExp, stated in UI.
                      // Anchored popover beside the field; plain text default.

// exporter.js (Lane C)
exporter.exportData({name, data|rows, formats:['json','jsonl','yaml','toml','xml','csv',
 'tsv','md','html','sql','zip']}) // dialog save, encoding stated, offers Open in VS Code

// bulk.js (Lane C)
bulk.enable(listEl, {getItemId, actions}) // multi-select, shift-range, keyboard,
  // select-all states THIS PAGE vs EVERY MATCH explicitly, inverse, preview counts,
  // destructive batch through ui.superConfirm, progress + honest partial results

// history.js (Lane C API over hist:*)
history.record({kind:'created'|'updated'|'deleted'|'restored'|'undone'|'imported'|'settings',
                label, snapshot?})
history.query({from?,to?,actions?,text?,{mode,flags}}) // date picker + action filter
history.restore(id), label(id,text), prune(policy), exportRedacted(format)

// narrator.js (Lane D): speak(text,{lang:'en'|'yue'|'both'}), serialized queue,
// per-category cooldowns, voice pickers per language ('Choose automatically' default,
// runtime enumeration + late-population handling), rate/pitch, status line beneath
// pickers naming effective voice/fallbacks/offline caveats, ducks under screen readers

// locks.js (Lane D): lockElement(el,{scope}), wizard (password|TOTP per lock, own
// credential each), unlock durations, relock, locked items still searchable labelled
// locked, Support Tickets desk route, recovery copy names the userData folder verbatim

// ladder.js (Lane D): dim-sum rung (suppressed under School mode → starts at sums),
// ten sums → whack-a-mole → clock; server(main)-graded nonces; budget cap 3/hour;
// clears WAITING only, never credentials, never refunds attempts

// authenticator.js (Lane D): entries CRUD, QR pairing (qr.js encoder drawn on canvas,
// manual base32 beside it, confirm-before-arm), live codes + countdown + next-code peek,
// RFC 6238 vectors SHA1/256/512 ×6/8 digits, local-only, export omits secrets AND SAYS SO

// dimsum.js (Lane D): 10% startup draw, catalog metadata cached in userData from the
// public Ding-Ding-Projects photo catalog releases, bilingual dish name + alt text,
// non-blocking auto-dismiss card, suppressed entirely under School mode

// adhd.js (Lane D): five independent off-by-default modes — focus spotlight, low
// stimulation, time awareness chips, one-thing banner, momentum nudges with real snooze;
// plain non-judgemental copy through i18n.voice

// vocabulary upload (Lane D): visible control even with no file; schema v1 bounds
// (≤256 KiB, ≤5000 entries, depth ≤4, string-only); fail closed to shipped wording

// appearance.js (Lane E): theme light/dark/system, density, accent seed, fonts
// (installed enumeration where available + bundled fallback stack), Word-depth
// typography editor, named presets, export/import themes, per-element reset, global reset,
// binds router.editAppearance + context-menu 'Edit appearance…' everywhere

// colorpicker.js (Lane E): continuous spectrum + numeric entry, bidirectional translator
// (HEX8/RGB/HSL/HSV/HWB/LAB/LCH/OKLab/OKLCH/CMYK, alpha preserved, gamut + contrast readout),
// rainbow SENTINEL (not a swatch; stylesheet-driven via one global --mrb-rainbow-duration;
// reduced motion settles on ONE hue), recent colors, eyedropper where available

// converter.js (Lane E): adapter registry {category,id,bundled,reason}, byte-signature
// detection, bundled offline adapters (JSON/YAML/TOML/CSV/TSV/XML/MD/HTML/text encodings,
// PNG/JPEG/WebP via canvas, PDF inspect/split/merge/reorder/rotate/metadata via pdf-lib in
// utilityProcess), unavailable formats listed disabled WITH exact missing dependency,
// unlimited-length paged queue, pause/resume/cancel, per-file outcomes, atomic writes,
// lossy/metadata disclosure before run

// ollama.js (Lane E): health/version/tags/chat against documented local HTTP API only;
// installed models exhaustive; pull-by-name with size disclosure + progress; streamed chat
// sessions w/ system prompt + params + stop + retry + redacted export; harness profiles are
// ALLOWLISTED launches with preflight preview (never arbitrary shell); unavailable states get
// contextual in-app troubleshooting, never "see online docs"

// updater.js (Lane E): check-on-start + bounded interval against this repo's Releases;
// persistent non-blocking ready banner (version, notes link, UNSIGNED warning,
// Restart to install update / Later); failures visible, never faked success

// schedule.js (Lane E): rules with optional start/end date+time+weekday sets, local
// timezone stated, cross-midnight semantics documented, deterministic precedence,
// versioned schema + migration, values from local sources, edits recorded in history

// vscode.js (Lane E): detect VS Code (PATH + standard install paths + Insiders/portable),
// open exported file/folder as workspace root; graceful message when absent
```

## 7. CSS conventions

- `styles/tokens.css`: M3 role tokens as `--mrb-*` custom properties for light+dark
  (`--mrb-primary`, `--mrb-on-primary`, `--mrb-surface`, `--mrb-surface-container-*`,
  `--mrb-on-surface(-variant)`, `--mrb-outline(-variant)`, `--mrb-error*`, shape
  `--mrb-shape-sm/md/lg/xl/full`, elevation `--mrb-elev-0..5`, state opacities, motion
  durations/easings, type scale `--mrb-type-*`).
- Component classes `.mrb-btn(.filled|.tonal|.outlined|.text|.danger)`, `.mrb-card`,
  `.mrb-field`, `.mrb-switch`, `.mrb-slider`, `.mrb-select`, `.mrb-chip`, `.mrb-tab`,
  `.mrb-menu`, `.mrb-dialog`, `.mrb-toast`, `.mrb-table`, `.mrb-badge`, `.mrb-progress`,
  `.mrb-skeleton`, `.mrb-list-row`.
- Feature stylesheets: `src/styles/features/<lane>.css`, injected by the owning module
  via `ui.injectCss` — never added to `index.html` (avoids cross-lane edits).
- M3 conformance: real component anatomy, state layers, shape/elevation/motion tokens;
  functional data colours exempt as data. Focus visible everywhere, 48px touch targets,
  reduced-motion respected, no clipped/truncated content at narrow widths or 100–200% scale,
  bilingual-mode longest labels must fit.

## 8. i18n conventions

- Keys `'group.name'`; catalogs inline objects `CAT_EN`, `CAT_YUE` in i18n.js.
- Cantonese is playful Hong Kong style, respectful, never mocking the user, their data,
  their money, or disability.
- Funny levels style voice, never facts: numbers, paths, error text, and button outcomes
  pass through unchanged at every level, in every category including errors/destructive.
- Bilingual mode renders primary language prominent + compact secondary.
- School mode forces English presentation and hides/suppresses Cantonese, funny-level
  effects, personal vocabulary, and ALL dim-sum capabilities as if uninstalled — controls
  omitted, not merely disabled; prior choices return when the mode goes off.

## 9. Accessibility & quality minimums (every control, every surface)

Keyboard reachable · visible focus · correct roles/names/states (`aria`) · contrast ≥ WCAG AA
in both themes · adequate touch targets · screen-reader announcements for async results
(`aria-live`) · reduced-motion honored · narrow-width + 100–200% scale validated ·
empty states honest ("no results" ≠ blank) · errors actionable with recovery next step ·
decorative-looking things either work or are labelled static previews.

## 10. Roblox feature surfaces (Lane B)

Module layout under `src/js/features/roblox/`:

```
api.js       — rbxFetch(pathOrUrl, {method, body, auth}) + endpoint helpers grouped by
               users/thumbnails/friends/groups/games/badges/catalog/inventory/economy/
               presence/avatar/accountinfo; typed RbxError(status, message)
surfaces/*.js — one file per tab, each registering via router.registerTab:
  home.js        — landing: quick lookup, recent searches (local), service health chips
  users.js       — lookup by username/id, profile card (avatar headshot+full body via
                   thumbnails API), created/updated dates, description rendering
  friends.js     — friends/followers/following lists, counts, bulk select + export
  groups.js      — group info, roles, member counts, shout wall (public fields)
  games.js       — universe/place details, icons/thumbnails, stats (visits, favorites,
                   playing), badges tab per game
  marketplace.js — catalog search w/ filters (category, price, creator), item cards,
                   creator type resolution, limited/serial info where public
  inventory.js   — public inventories by asset type with pagination + bulk export
  economy.js     — authenticated: Robux balance, transactions summary (requires session)
  presence.js    — authenticated presence polling for saved users (respectful interval)
  session.js     — connect .ROBLOSECURITY via secure paste flow (vault storage, masked),
                   verify whoami, disconnect, clear disclosure about what is stored
  compare.js     — side-by-side two-user comparison (mutuals, badge/game overlaps)
searchbar.js — shared surface search component wired to regexbuilder.attachSearch
cards.js     — shared result cards, skeletons, lazy thumbnails (loading=lazy + fallback)
```

Rules: every list gets bulk actions + export; every search bar gets the regex builder;
thumbnails degrade gracefully offline; rate limits respected (client-side throttle
~150 ms between calls, backoff on 429); nothing requiring authentication renders a fake
empty state — it explains what connecting unlocks and links Session.

## 11. Lane working agreement

- Write files only inside your ownership map. No installs, no builds, no tests, no git
  commands, no network fetches.
- Keep every file syntactically valid ES modules; no top-level await outside `init()`.
- Prefer small pure helpers + explicit JSDoc types over cleverness.
- When you need a peer capability, import the module per §4 — never re-implement.
- Report at completion: files written + one-line purpose each + any deviation from this
  contract (with reason).

*Contract v1 — 2026-08-22.*
