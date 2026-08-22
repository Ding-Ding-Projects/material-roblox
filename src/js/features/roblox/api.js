/**
 * Material Roblox — renderer-side Roblox REST client.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Rate limits and politeness (why this module exists the way it does)
 * ─────────────────────────────────────────────────────────────────────────────
 * All Roblox REST traffic is proxied through the main process via
 * `window.mrb.invoke('roblox:fetch', …)`; the renderer never fetches
 * cross-origin itself (thumbnail <img> loads are the sanctioned exception).
 *
 * Endpoint families this lane touches, and their practical caps:
 *   • users      /v1/users/{id}, /v1/usernames/users (≤50 names/POST),
 *                /v1/users/search (keyword ≥3 chars, limit ≤100),
 *                /v1/users/{id}/username-history
 *   • friends    /v1/users/{id}/friends, /followers, /followings (limit ≤50/page)
 *                and /count endpoints
 *   • groups     /v2/groups/{id}, /v2/groups/{id}/roles,
 *                /v1/groups/search, /v2/users/{id}/groups/roles
 *   • games      /v1/games?universeIds=… , multiget-place-details (≤100 places),
 *                /v2/games/{id}/media, badges/v1/universes/{id}/badges (≤100/page)
 *   • catalog    /v1/search/items + POST /v1/catalog/items/details (≤100 items)
 *   • inventory  /v2/users/{id}/inventory/{assetTypeId} (limit ≤100/page;
 *                403 when the owner made their inventory private)
 *   • economy    /v1/users/{id}/currency and /transactions/summary — both
 *                require a session; summary parts are Premium-gated (403)
 *   • presence   POST /v1/presence/users — session required, ≤50 ids per call
 *   • avatar     /v1/users/{id}/avatar (public)
 *   • thumbnails POST /v1/batch — documented hard cap of 50 entries/request
 *
 * Roblox does not publish most per-endpoint quotas, and they vary per service.
 * What IS known: bursts of unauthenticated traffic get HTTP 429 quickly, and
 * repeated 429 storms can escalate to temporary IP-level blocks that would
 * degrade the whole app for everyone on the machine. The client therefore:
 *   1. spaces every call at least `roblox.throttleMs` apart (default 150 ms),
 *   2. backs off exponentially on 429 honouring Retry-After when present
 *      (cap 30 s per wait, max 4 retries), and also retries transient 5xx twice,
 *   3. deduplicates identical in-flight GETs (single-flight) and serves repeat
 *      GETs from a small LRU cache for `roblox.cacheTtlSec` (default 60 s).
 * Polling surfaces (presence board, service health) additionally enforce their
 * own generous intervals independent of this throttle.
 */

import { store } from '../../core/store.js';
import { settings } from '../../core/settings.js';
import { i18n } from '../../core/i18n.js';
import { ui } from '../../core/ui.js';

/* ── Service host map ──────────────────────────────────────────────────────── */

/**
 * Bare-path prefixes accepted by rbxFetch → canonical base URL.
 * `accountinfo` is an alias of `accountinformation`.
 */
export const HOSTS = Object.freeze({
  users: 'https://users.roblox.com/',
  friends: 'https://friends.roblox.com/',
  groups: 'https://groups.roblox.com/',
  games: 'https://games.roblox.com/',
  badges: 'https://badges.roblox.com/',
  catalog: 'https://catalog.roblox.com/',
  thumbnails: 'https://thumbnails.roblox.com/',
  economy: 'https://economy.roblox.com/',
  presence: 'https://presence.roblox.com/',
  avatar: 'https://avatar.roblox.com/',
  accountinformation: 'https://accountinformation.roblox.com/',
  accountinfo: 'https://accountinformation.roblox.com/',
  apis: 'https://apis.roblox.com/',
});

const HOST_PREFIX_RE = /^(users|friends|groups|games|badges|catalog|thumbnails|economy|presence|avatar|accountinformation|accountinfo|apis)(?:\.roblox\.com)?\/?(.*)$/i;

/**
 * Normalize a bare 'service/rest-of-path' input to an absolute URL.
 * Full http(s) URLs pass through unchanged (the main-process allowlist still
 * constrains hosts). Unknown prefixes throw RbxError(0).
 * @param {string} pathOrUrl
 * @returns {string}
 */
export function normalizeUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const m = HOST_PREFIX_RE.exec(raw);
  if (!m) {
    throw new RbxError(0, `Unrecognized Roblox API path: ${raw}`,
      'Use "service/path" form such as users/v1/users/1, or a full https URL.');
  }
  const base = HOSTS[m[1].toLowerCase()];
  const rest = m[2].replace(/^\/+/, '');
  return base + rest;
}

/* ── Error type ─────────────────────────────────────────────────────────────── */

/**
 * Typed error carrying the HTTP status plus a user-actionable hint.
 * `status` is 0 for transport/bridge failures (no HTTP response at all).
 */
export class RbxError extends Error {
  /**
   * @param {number} status HTTP status code (0 = no response)
   * @param {string} message factual failure description
   * @param {string} [hint] what the user can do about it
   */
  constructor(status, message, hint) {
    super(message);
    this.name = 'RbxError';
    this.status = status;
    this.hint = hint || '';
  }
}

/** Map a status (+optional context) to an actionable next step. */
function hintFor(status, message, context) {
  if (context === 'inventory') {
    if (status === 403) {
      return 'This user set their inventory to private. Only they can make it public ' +
        '(Roblox account Settings → Privacy → Inventory). Nothing to fix on our side.';
    }
  }
  switch (status) {
    case 401:
      return 'Sign-in required. Connect a session on the Session tab to use this.';
    case 403:
      return message && /premium/i.test(message)
        ? 'This data is Roblox Premium-gated; it unlocks only for Premium accounts with a connected session.'
        : 'Access denied — this data needs a connected session or is restricted by its owner.';
    case 404:
      return 'Not found — double-check the ID or username spelling.';
    case 429:
      return 'Roblox is rate limiting us. Requests retry automatically with backoff; give it a moment.';
    default:
      if (status >= 500) return 'A Roblox service is having trouble right now — try again shortly.';
      if (status === 0) return 'No response reached the app. Check your network connection and try again.';
      return '';
  }
}

/** Best-effort status extraction from an unknown thrown value. */
function statusOf(err) {
  if (err instanceof RbxError) return err.status;
  if (err && typeof err === 'object') {
    if (Number.isFinite(err.status)) return err.status;
    const msg = String(err.message || '');
    const m = /\b([1-5]\d\d)\b/.exec(msg);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Pull the server's own message out of any plausible envelope. */
function extractMessage(json, text, fallback) {
  if (json && typeof json === 'object') {
    const e0 = Array.isArray(json.errors) && json.errors[0];
    if (e0 && e0.message) return String(e0.message);
    if (json.message) return String(json.message);
    if (json.error) return String(json.error);
  }
  if (typeof text === 'string' && text.trim()) return text.slice(0, 240);
  return fallback;
}

/* ── Throttle queue · cache · single-flight ─────────────────────────────────── */

const state = {
  chain: Promise.resolve(), // serializes spacing so calls never overlap
  lastAt: 0,
  /** @type {Map<string,{t:number,value:any}>} LRU: newest re-inserted, evict oldest */
  cache: new Map(),
  /** @type {Map<string,Promise<any>>} identical-GET single-flight */
  inflight: new Map(),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function throttleMs() {
  try { return clamp(Number(settings.get('roblox.throttleMs', 150)) || 150, 50, 1000); }
  catch { return 150; }
}
function cacheTtlMs() {
  try { return clamp(Number(settings.get('roblox.cacheTtlSec', 60)) || 60, 5, 3600) * 1000; }
  catch { return 60000; }
}

async function waitForSlot() {
  const run = state.chain.then(async () => {
    const gap = state.lastAt + throttleMs() - Date.now();
    if (gap > 0) await sleep(gap);
    state.lastAt = Date.now();
  });
  // Keep the chain alive even if one waiter rejects.
  state.chain = run.catch(() => {});
  await run;
}

function cacheGet(key) {
  const hit = state.cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t > cacheTtlMs()) { state.cache.delete(key); return undefined; }
  // LRU refresh
  state.cache.delete(key);
  state.cache.set(key, hit);
  return hit.value;
}
function cachePut(key, value) {
  state.cache.delete(key);
  state.cache.set(key, { t: Date.now(), value });
  while (state.cache.size > 200) {
    const oldest = state.cache.keys().next().value;
    state.cache.delete(oldest);
  }
}

/** Retry-After seconds from whatever shape the failure carries. */
function retryAfterSeconds(err) {
  const h = err && err.headers;
  if (h) {
    const v = h.get ? h.get('retry-after') : h['retry-after'];
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const m = /retry[- ]after[: ]+(\d+)/i.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : 0;
}

/** Unwrap either `{status,json}` envelopes or already-parsed payloads. */
function unwrap(res, contextLabel) {
  if (res && typeof res === 'object' && Number.isFinite(res.status)) {
    const body = ('json' in res && res.json !== undefined) ? res.json
      : (('body' in res && res.body !== undefined) ? res.body : res.text);
    if (res.status >= 400) {
      throw new RbxError(res.status,
        extractMessage(body, res.text, `HTTP ${res.status} from ${contextLabel}`),
        hintFor(res.status, extractMessage(body, '', ''), contextLabel));
    }
    return body;
  }
  return res;
}

/**
 * Core request primitive. Every Roblox call in this lane funnels through here.
 *
 * @param {string} pathOrUrl bare 'service/path' or absolute URL
 * @param {{method?:string, body?:any, auth?:boolean, force?:boolean,
 *          retriable?:boolean, context?:string}} [opts]
 *   auth   — main process injects .ROBLOSECURITY from the vault; the cookie
 *            value never returns to the renderer.
 *   force  — bypass the GET cache and single-flight dedupe.
 * @returns {Promise<any>} parsed JSON payload
 */
export async function rbxFetch(pathOrUrl, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const url = normalizeUrl(pathOrUrl);
  const context = opts.context || '';
  const isGet = method === 'GET';

  if (typeof window === 'undefined' || !window.mrb || typeof window.mrb.invoke !== 'function') {
    throw new RbxError(0, 'The app bridge is not available.',
      'Roblox features need the desktop shell bridge. Reload the app.');
  }

  if (isGet && !opts.force) {
    const cached = cacheGet(url);
    if (cached !== undefined) return cached;
    const running = state.inflight.get(url);
    if (running) return running;
  }

  const exec = (async () => {
    let attempt = 0;
    for (;;) {
      await waitForSlot();
      let raw;
      try {
        raw = await window.mrb.invoke('roblox:fetch', {
          url,
          method,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          ...(opts.auth ? { auth: true } : {}),
        });
      } catch (bridgeErr) {
        // Handler threw: recover a status if the message carries one.
        const st = statusOf(bridgeErr);
        if ((st === 429 && attempt < 4) || (st >= 500 && st < 600 && attempt < 2 && opts.retriable !== false)) {
          attempt += 1;
          const ra = st === 429 ? Math.max(retryAfterSeconds(bridgeErr), 0.8 * 2 ** attempt) : 0.8 * attempt;
          await sleep(Math.min(ra, 30) * 1000);
          continue;
        }
        throw new RbxError(st, extractMessage(null, bridgeErr && bridgeErr.message, `Request failed (${url})`),
          hintFor(st, String((bridgeErr && bridgeErr.message) || ''), context));
      }
      try {
        const payload = unwrap(raw, context || url);
        if (isGet) cachePut(url, payload);
        return payload;
      } catch (err) {
        const st = statusOf(err);
        if ((st === 429 && attempt < 4) ||
            (st >= 500 && st < 600 && attempt < 2 && opts.retriable !== false)) {
          attempt += 1;
          const ra = st === 429 ? Math.max(retryAfterSeconds(err), 0.8 * 2 ** attempt) : 0.8 * attempt;
          await sleep(Math.min(ra, 30) * 1000);
          continue;
        }
        throw err;
      }
    }
  })();

  if (isGet && !opts.force) {
    state.inflight.set(url, exec);
    try { return await exec; } finally { state.inflight.delete(url); }
  }
  return exec;
}

/* ── Thumbnails batch ───────────────────────────────────────────────────────── */

/** Documented cap: 50 entries per POST /v1/batch. */
const THUMB_CHUNK = 50;

/**
 * Batch thumbnail resolution. Chunks requests into ≤50-entry POSTs.
 *
 * @param {{type:string,targetId:number|string,size?:string,format?:string,
 *          isCircular?:boolean}[]} requests
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<Map<string,string>>} targetId(string) → image URL on
 *   success, otherwise the terminal/pending state string ('Pending',
 *   'Blocked', …). Callers must render non-URL values as placeholders.
 */
export async function batchThumbnails(requests, opts = {}) {
  const out = new Map();
  const list = Array.isArray(requests) ? requests.filter(Boolean) : [];
  for (let i = 0; i < list.length; i += THUMB_CHUNK) {
    const chunk = list.slice(i, i + THUMB_CHUNK).map((r) => ({
      type: String(r.type),
      targetId: Number(r.targetId),
      size: String(r.size || '150x150'),
      format: String(r.format || 'Png'),
      isCircular: Boolean(r.isCircular),
    }));
    if (!chunk.length) continue;
    let resp;
    try {
      resp = await rbxFetch('thumbnails/v1/batch', {
        method: 'POST',
        body: chunk,
        force: opts.force,
        context: 'thumbnails',
      });
    } catch {
      // A failed batch leaves those targets unresolved; callers show tiles.
      continue;
    }
    const rows = Array.isArray(resp) ? resp : [];
    for (const row of rows) {
      if (!row || row.targetId == null) continue;
      const ok = row.state === 'Completed' && typeof row.imageUrl === 'string' && row.imageUrl;
      out.set(String(row.targetId), ok ? row.imageUrl : String(row.state || 'Pending'));
    }
  }
  return out;
}

/**
 * Convenience: fetch thumbnails then apply them onto elements produced by
 * {@link import('./cards.js').thumbImg}-style wrappers. Each item maps a
 * thumbnail request to a setter receiving the resolved URL (or null).
 * @param {{req:Object,set:(url:string|null)=>void}[]} jobs
 */
export async function applyThumbnails(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return;
  const map = await batchThumbnails(jobs.map((j) => j.req));
  jobs.forEach((j, idx) => {
    const key = String(j.req.targetId);
    const v = map.get(key);
    // Same target may appear under multiple sizes; resolve per-job by index
    // using the chunk order preserved above via a per-request lookup.
    const url = v && /^https?:/i.test(v) ? v : null;
    j.set(url);
    void idx;
  });
}

/* ── Enumerations ───────────────────────────────────────────────────────────── */

/**
 * Curated inventory asset types for the Inventory surface, following Roblox's
 * public AssetType identifiers used by /v2/users/{id}/inventory/{assetTypeId}.
 * Values are the classic enum ids widely replicated across community tooling:
 * TShirt=2, Hat=8, Shirt=11, Pants=12, Gear=19, and accessory types 41–47.
 * Unsupported ids simply return empty/error states, which we render honestly.
 * @type {{id:number,label:string,yue:string}[]}
 */
export const ASSET_TYPES = Object.freeze([
  { id: 8, label: 'Hat', yue: '帽' },
  { id: 41, label: 'Hair Accessory', yue: '髮飾' },
  { id: 42, label: 'Face Accessory', yue: '面飾' },
  { id: 43, label: 'Neck Accessory', yue: '頸飾' },
  { id: 44, label: 'Shoulder Accessory', yue: '肩飾' },
  { id: 45, label: 'Front Accessory', yue: '前飾' },
  { id: 46, label: 'Back Accessory', yue: '背飾' },
  { id: 47, label: 'Waist Accessory', yue: '腰飾' },
  { id: 2, label: 'T-Shirt', yue: 'T恤' },
  { id: 11, label: 'Shirt', yue: '襯衫' },
  { id: 12, label: 'Pants', yue: '褲' },
  { id: 19, label: 'Gear', yue: '道具' },
]);

/**
 * Presence userPresenceType codes returned by POST /v1/presence/users.
 * @type {Record<number,{label:string,yue:string}>}
 */
export const PRESENCE_TYPES = Object.freeze({
  0: { label: 'Offline', yue: '離線' },
  1: { label: 'On website', yue: '喺網站' },
  2: { label: 'In game', yue: '玩緊遊戲' },
  3: { label: 'In Studio', yue: '用緊 Studio' },
  4: { label: 'Invisible', yue: '隱形' },
});

/** Presence API accepts at most 50 ids per call. */
const PRESENCE_CHUNK = 50;

/* ── users.roblox.com ───────────────────────────────────────────────────────── */

export const users = {
  /** GET /v1/users/{id} → {description, created, isBanned, …} */
  async getById(id, opts = {}) {
    return rbxFetch(`users/v1/users/${encodeURIComponent(id)}`, { ...opts, context: 'users' });
  },

  /** POST /v1/users {userIds} → {data:[{id,name,displayName,…}]} (≤100/call) */
  async getByIds(ids, opts = {}) {
    const clean = (ids || []).map(Number).filter(Number.isFinite).slice(0, 100);
    if (!clean.length) return { data: [] };
    return rbxFetch('users/v1/users', { ...opts, method: 'POST', body: { userIds: clean, excludeBannedUsers: false }, context: 'users' });
  },

  /**
   * POST /v1/usernames/users {usernames:[…]} → {data:[{id,name,…}]}
   * Requested names absent from the response are simply not found.
   */
  async byUsernames(names, opts = {}) {
    const clean = (names || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 50);
    if (!clean.length) return { data: [] };
    return rbxFetch('users/v1/usernames/users', {
      ...opts, method: 'POST',
      body: { usernames: clean, excludeBannedUsers: false },
      context: 'users',
    });
  },

  /**
   * GET /v1/users/search?keyword=&limit=&cursor= — keyword must be ≥3 chars.
   * Some regions answer 403; callers should render that as an honest error.
   */
  async search(keyword, { cursor = '', limit = 25 } = {}, opts = {}) {
    const kw = String(keyword || '').trim();
    if (kw.length < 3) {
      throw new RbxError(400, 'User search needs at least 3 characters.',
        'Type a longer part of the username.');
    }
    const qs = new URLSearchParams({ keyword: kw, limit: String(clamp(limit, 10, 100)) });
    if (cursor) qs.set('cursor', cursor);
    return rbxFetch(`users/v1/users/search?${qs}`, { ...opts, context: 'users.search' });
  },

  /** GET /v1/users/{id}/username-history?limit=50&sortOrder=Asc */
  async usernameHistory(id, opts = {}) {
    return rbxFetch(`users/v1/users/${encodeURIComponent(id)}/username-history?limit=50&sortOrder=Asc`,
      { ...opts, context: 'users' });
  },

  /** GET /v1/users/authenticated (session) → {id,name,displayName?} */
  async authenticated(opts = {}) {
    return rbxFetch('users/v1/users/authenticated', { ...opts, auth: true, force: true, context: 'session' });
  },
};

/* ── friends.roblox.com ─────────────────────────────────────────────────────── */

export const friends = {
  /** GET /v1/users/{id}/friends → {data:[{id,name,displayName,…}]} */
  async list(userId, opts = {}) {
    return rbxFetch(`friends/v1/users/${encodeURIComponent(userId)}/friends`, { ...opts, context: 'friends' });
  },
  /** GET /v1/users/{id}/friends/count → {count} */
  async count(userId, opts = {}) {
    return rbxFetch(`friends/v1/users/${encodeURIComponent(userId)}/friends/count`, { ...opts, context: 'friends' });
  },
  /** GET /v1/users/{id}/followers?limit≤50&cursor → paged */
  async followers(userId, { cursor = '', limit = 50 } = {}, opts = {}) {
    const qs = new URLSearchParams({ limit: String(clamp(limit, 1, 50)) });
    if (cursor) qs.set('cursor', cursor);
    return rbxFetch(`friends/v1/users/${encodeURIComponent(userId)}/followers?${qs}`, { ...opts, context: 'friends' });
  },
  /** GET /v1/users/{id}/followings?limit≤50&cursor → paged */
  async followings(userId, { cursor = '', limit = 50 } = {}, opts = {}) {
    const qs = new URLSearchParams({ limit: String(clamp(limit, 1, 50)) });
    if (cursor) qs.set('cursor', cursor);
    return rbxFetch(`friends/v1/users/${encodeURIComponent(userId)}/followings?${qs}`, { ...opts, context: 'friends' });
  },
  /** GET /v1/users/{id}/followers/count → {count} */
  async followerCount(userId, opts = {}) {
    return rbxFetch(`friends/v1/users/${encodeURIComponent(userId)}/followers/count`, { ...opts, context: 'friends' });
  },
  /** GET /v1/users/{id}/followings/count → {count} */
  async followingCount(userId, opts = {}) {
    return rbxFetch(`friends/v1/users/${encodeURIComponent(userId)}/followings/count`, { ...opts, context: 'friends' });
  },
};

/* ── groups.roblox.com ──────────────────────────────────────────────────────── */

export const groups = {
  /** GET /v2/groups/{id} → {name, description, owner, memberCount, created, …} */
  async get(id, opts = {}) {
    return rbxFetch(`groups/v2/groups/${encodeURIComponent(id)}`, { ...opts, context: 'groups' });
  },
  /** GET /v1/groups/{id} → includes public `shout` when present */
  async getV1(id, opts = {}) {
    return rbxFetch(`groups/v1/groups/${encodeURIComponent(id)}`, { ...opts, context: 'groups' });
  },
  /** GET /v2/groups/{id}/roles → {roles:[{id,name,rank,memberCount?}]} */
  async roles(id, opts = {}) {
    return rbxFetch(`groups/v2/groups/${encodeURIComponent(id)}/roles`, { ...opts, context: 'groups' });
  },
  /** GET /v1/groups/search?keyword=&prioritizeExactMatch=&limit=&cursor= */
  async search(keyword, { prioritizeExactMatch = true, limit = 10, cursor = '' } = {}, opts = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) throw new RbxError(400, 'Enter a group name to search.', 'Type any part of a group name.');
    const qs = new URLSearchParams({
      keyword: kw,
      prioritizeExactMatch: String(Boolean(prioritizeExactMatch)),
      limit: String(clamp(limit, 10, 25)),
    });
    if (cursor) qs.set('cursor', cursor);
    return rbxFetch(`groups/v1/groups/search?${qs}`, { ...opts, context: 'groups.search' });
  },
  /** GET /v2/users/{userId}/groups/roles → {data:[{group:{…},role:{…}}]} */
  async userGroups(userId, opts = {}) {
    return rbxFetch(`groups/v2/users/${encodeURIComponent(userId)}/groups/roles`, { ...opts, context: 'groups' });
  },
};

/* ── games.roblox.com + badges.roblox.com ───────────────────────────────────── */

export const games = {
  /** GET /v1/games?universeIds=a,b → {data:[{rootPlaceId,playing,visits,…}]} */
  async getByUniverseIds(ids, opts = {}) {
    const clean = (ids || []).map(Number).filter(Number.isFinite).slice(0, 100);
    if (!clean.length) return { data: [] };
    return rbxFetch(`games/v1/games?universeIds=${clean.join(',')}`, { ...opts, context: 'games' });
  },
  /** POST /v1/games/multiget-place-details {placeIds:[…]} (≤100) */
  async getPlaceDetails(placeIds, opts = {}) {
    const clean = (placeIds || []).map(Number).filter(Number.isFinite).slice(0, 100);
    if (!clean.length) return [];
    return rbxFetch('games/v1/games/multiget-place-details', {
      ...opts, method: 'POST', body: { placeIds: clean }, context: 'games',
    });
  },
  /** Resolve the universeId owning a placeId (first detail row). */
  async universeForPlace(placeId, opts = {}) {
    const rows = await games.getPlaceDetails([placeId], opts);
    const first = Array.isArray(rows) ? rows[0] : null;
    const uid = first && first.universeId;
    if (!Number.isFinite(uid)) {
      throw new RbxError(404, `Could not resolve place ${placeId} to a universe.`,
        'Check that the place ID belongs to an existing experience.');
    }
    return uid;
  },
  /** GET /v2/games/{universeId}/media → {data:[{targetId,type,imageUrl,…}]} */
  async getMedia(universeId, opts = {}) {
    return rbxFetch(`games/v2/games/${encodeURIComponent(universeId)}/media`, { ...opts, context: 'games' });
  },
  /** GET badges/v1/universes/{id}/badges?limit≤100&sortOrder&cursor */
  async badges(universeId, { cursor = '', limit = 50, sortOrder = 'Desc' } = {}, opts = {}) {
    const qs = new URLSearchParams({
      limit: String(clamp(limit, 10, 100)), sortOrder: sortOrder === 'Asc' ? 'Asc' : 'Desc',
    });
    if (cursor) qs.set('cursor', cursor);
    return rbxFetch(`badges/v1/universes/${encodeURIComponent(universeId)}/badges?${qs}`,
      { ...opts, context: 'badges' });
  },
  /** Badges for a placeId: resolves the universe first, then pages badges. */
  async badgesForPlace(placeId, page = {}, opts = {}) {
    const universeId = await games.universeForPlace(placeId, opts);
    return games.badges(universeId, page, opts);
  },
};

/* ── catalog.roblox.com ─────────────────────────────────────────────────────── */

/**
 * Category strings accepted by GET /v1/search/items (`Category` param).
 * Values mirror the catalog search API's documented Category vocabulary;
 * unknown or renamed values fail visibly as error states rather than silently
 * returning wrong results. Empty string = omit the param entirely (default).
 * @type {{value:string,label:string,yue:string}[]}
 */
export const CATEGORY_MAP = Object.freeze([
  { value: '', label: 'All categories', yue: '全部分類' },
  { value: 'Featured', label: 'Featured', yue: '精選' },
  { value: 'CommunityCreations', label: 'Community creations', yue: '社群創作' },
  { value: 'Accessories', label: 'Accessories', yue: '配飾' },
  { value: 'Clothing', label: 'Clothing', yue: '服飾' },
  { value: 'Gear', label: 'Gear', yue: '道具' },
]);

/** Documented cap: ≤100 items per details POST. */
const DETAILS_CHUNK = 100;

export const catalog = {
  /**
   * GET /v1/search/items with optional filters → {data,nextPageCursor}.
   * SortType values are the documented set (Relevance/PriceAsc/PriceDesc/
   * MostFavorited/Bases); MinPrice/MaxPrice need CurrencyType=Robux.
   */
  async searchItems(params = {}, opts = {}) {
    const qs = new URLSearchParams();
    const put = (k, v) => { if (v !== '' && v != null) qs.set(k, String(v)); };
    put('Keyword', params.keyword);
    put('Category', params.category);
    put('Subcategory', params.subcategory);
    put('CreatorTargetId', params.creatorTargetId);
    put('SortType', params.sortType);
    put('Limit', params.limit);
    put('Cursor', params.cursor);
    if (params.currencyType) put('CurrencyType', params.currencyType);
    else if (params.minPrice != null || params.maxPrice != null) put('CurrencyType', 'Robux');
    if (params.minPrice != null) put('MinPrice', params.minPrice);
    if (params.maxPrice != null) put('MaxPrice', params.maxPrice);
    return rbxFetch(`catalog/v1/search/items?${qs.toString()}`, { ...opts, context: 'catalog.search' });
  },

  /** POST /v1/catalog/items/details {items:[{itemType,id}]} chunks ≤100 */
  async itemDetails(entries, opts = {}) {
    const out = [];
    const list = (entries || []).filter((e) => e && e.id != null);
    for (let i = 0; i < list.length; i += DETAILS_CHUNK) {
      const chunk = list.slice(i, i + DETAILS_CHUNK)
        .map((e) => ({ itemType: String(e.itemType || 'Item'), id: Number(e.id) }));
      if (!chunk.length) continue;
      const resp = await rbxFetch('catalog/v1/catalog/items/details', {
        ...opts, method: 'POST', body: { items: chunk }, context: 'catalog.details',
      });
      if (Array.isArray(resp?.data)) out.push(...resp.data);
    }
    return out;
  },

  /** Single item details by id (itemType defaults to legacy 'Item'). */
  async getItem(id, opts = {}) {
    const rows = await catalog.itemDetails([{ itemType: 'Item', id }], opts);
    return rows[0] || null;
  },
};

/* ── inventory.roblox.com ───────────────────────────────────────────────────── */

export const inventory = {
  /**
   * GET /v2/users/{id}/inventory/{assetTypeId}?limit≤100&cursor → paged.
   * 403 means the owner keeps their inventory private (see RbxError.hint).
   */
  async getUserAssets(userId, assetTypeId, { cursor = '', limit = 100 } = {}, opts = {}) {
    const qs = new URLSearchParams({ limit: String(clamp(limit, 10, 100)) });
    if (cursor) qs.set('cursor', cursor);
    return rbxFetch(
      `inventory/v2/users/${encodeURIComponent(userId)}/inventory/${encodeURIComponent(assetTypeId)}?${qs}`,
      { ...opts, context: 'inventory' },
    );
  },
};

/* ── economy.roblox.com (session required) ──────────────────────────────────── */

export const economy = {
  /** GET /v1/users/{id}/currency → {robux} */
  async currency(userId, opts = {}) {
    return rbxFetch(`economy/v1/users/${encodeURIComponent(userId)}/currency`,
      { ...opts, auth: true, context: 'economy' });
  },
  /**
   * GET /v1/users/{id}/transactions/summary?timeFrame=…&transactionType=summary
   * Parts of this are Premium-gated; expect honest 403s for non-Premium.
   */
  async summary(userId, { timeFrame = 'Month' } = {}, opts = {}) {
    const tf = ['Day', 'Week', 'Month'].includes(timeFrame) ? timeFrame : 'Month';
    return rbxFetch(
      `economy/v1/users/${encodeURIComponent(userId)}/transactions/summary?timeFrame=${tf}&transactionType=summary`,
      { ...opts, auth: true, context: 'economy.summary' },
    );
  },
};

/* ── presence.roblox.com (session required) ─────────────────────────────────── */

export const presence = {
  /** POST /v1/presence/users {userIds:[…]} chunks ≤50 → {userPresences:[…]} */
  async users(ids, opts = {}) {
    const clean = (ids || []).map(Number).filter(Number.isFinite).slice(0, PRESENCE_CHUNK);
    if (!clean.length) return { userPresences: [] };
    return rbxFetch('presence/v1/presence/users', {
      ...opts, method: 'POST', body: { userIds: clean }, auth: true, context: 'presence',
    });
  },
};

/* ── avatar.roblox.com / accountinformation.roblox.com ─────────────────────── */

export const avatar = {
  /** GET /v1/users/{id}/avatar → {assets:[{id,name,assetType,…}], bodyColors,…} */
  async getWearing(userId, opts = {}) {
    return rbxFetch(`avatar/v1/users/${encodeURIComponent(userId)}/avatar`, { ...opts, context: 'avatar' });
  },
};

export const accountinfo = {
  /** GET accountinformation/v1/users/{id} (own account only; session required) */
  async get(userId, opts = {}) {
    return rbxFetch(`accountinformation/v1/users/${encodeURIComponent(id)}`,
      { ...opts, auth: true, context: 'accountinfo' });
  },
};

/* ── Service health probes (Home surface chips) ─────────────────────────────── */

/** Tiny public GETs; any answered status proves the service is up. */
const HEALTH_PROBES = [
  { key: 'users', en: 'Users', yue: '用戶', path: 'users/v1/users/1' },
  { key: 'friends', en: 'Friends', yue: '朋友', path: 'friends/v1/users/1/friends/count' },
  { key: 'groups', en: 'Groups', yue: '群組', path: 'groups/v2/groups/4199748' },
  { key: 'games', en: 'Games', yue: '遊戲', path: 'games/v1/games?universeIds=0' },
  { key: 'catalog', en: 'Catalog', yue: '市集', path: 'catalog/v1/search/items?Keyword=hat&Limit=10' },
  { key: 'thumbnails', en: 'Thumbnails', yue: '縮圖', path: 'thumbnails/v1/assets?ids=1&size=150x150&format=Png' },
  { key: 'avatar', en: 'Avatar', yue: '外觀', path: 'avatar/v1/users/1/avatar' },
];

/**
 * Probe each public service once. Throttled serially by rbxFetch (~150 ms
 * spacing), so a full sweep costs roughly a second.
 * @returns {Promise<{key:string,en:string,yue:string,status:'ok'|'degraded'|'down',
 *                    latencyMs:number|null,checkedAt:string}[]>}
 */
export async function checkServices() {
  const results = await Promise.all(HEALTH_PROBES.map(async (p) => {
    const started = Date.now();
    let status = 'down';
    let latencyMs = null;
    try {
      const res = await window.mrb.invoke('roblox:fetch', { url: normalizeUrl(p.path), method: 'GET' });
      latencyMs = Date.now() - started;
      const st = (res && typeof res === 'object' && Number.isFinite(res.status)) ? res.status : 200;
      status = (st >= 500 || st === 429) ? 'degraded' : 'ok';
    } catch {
      status = 'down';
    }
    return { key: p.key, en: p.en, yue: p.yue, status, latencyMs, checkedAt: new Date().toISOString() };
  }));
  return results;
}

/* ── Lookup helpers ─────────────────────────────────────────────────────────── */

/**
 * Resolve one lookup input: numeric → user id, otherwise username.
 * @param {string} input
 * @returns {Promise<{id:number,name:string,displayName?:string}>}
 */
export async function resolveUserInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new RbxError(400, 'Enter a username or user ID.', 'Example: Roblox or 1.');
  if (/^\d+$/.test(raw)) {
    const profile = await users.getById(raw);
    if (!profile || profile.id == null) {
      throw new RbxError(404, `No user with ID ${raw}.`, 'Check the ID and try again.');
    }
    return { id: profile.id, name: profile.name, displayName: profile.displayName || profile.name };
  }
  const res = await users.byUsernames([raw]);
  const hit = res?.data?.[0];
  if (!hit) {
    throw new RbxError(404, `No user named "${raw}".`, 'Check the spelling — usernames are exact.');
  }
  return { id: hit.id, name: hit.name, displayName: hit.displayName || hit.name };
}

/**
 * Resolve a comma-separated mix of usernames and IDs.
 * @param {string} rawInput
 * @returns {Promise<{found:{id:number,name:string,displayName:string}[],
 *                    missing:string[]}>}
 */
export async function resolveManyInputs(rawInput) {
  const tokens = String(rawInput || '')
    .split(/[,\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  const found = [];
  const missing = [];
  const nameBatch = [];
  const nameTokens = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      try {
        const p = await users.getById(tok);
        if (p && p.id != null) {
          found.push({ id: p.id, name: p.name, displayName: p.displayName || p.name });
        } else missing.push(tok);
      } catch (err) {
        if (err instanceof RbxError && err.status === 404) missing.push(tok);
        else throw err;
      }
    } else {
      nameBatch.push(tok);
      nameTokens.push(tok);
    }
  }
  for (let i = 0; i < nameBatch.length; i += 50) {
    const slice = nameBatch.slice(i, i + 50);
    try {
      const res = await users.byUsernames(slice);
      const byLower = new Map((res?.data || []).map((u) => [String(u.name).toLowerCase(), u]));
      for (const tok of slice) {
        const u = byLower.get(tok.toLowerCase());
        if (u) found.push({ id: u.id, name: u.name, displayName: u.displayName || u.name });
        else missing.push(tok);
      }
    } catch (err) {
      if (err instanceof RbxError && err.status === 404) missing.push(...slice);
      else throw err;
    }
  }
  return { found, missing };
}

/* ── Saved users (store-backed, shared by several surfaces) ─────────────────── */

const SAVED_KEY = 'roblox:savedUsers';
const FAV_GAMES_KEY = 'roblox:favoriteGames';
const SELF_KEY = 'roblox:selfUser';
const RECENT_LOOKUP_KEY = 'roblox:recentLookups';

/** @returns {{id:number,name:string,displayName:string,savedAt?:string}[]} */
export function getSavedUsers() {
  return store.get(SAVED_KEY, []);
}

export function isSavedUser(id) {
  return getSavedUsers().some((u) => u.id === Number(id));
}

/** @returns {boolean} true when now saved, false when removed. */
export function toggleSavedUser(user) {
  const list = getSavedUsers();
  const existing = list.findIndex((u) => u.id === Number(user.id));
  let nowSaved;
  if (existing >= 0) {
    list.splice(existing, 1);
    nowSaved = false;
  } else {
    list.unshift({ id: Number(user.id), name: user.name, displayName: user.displayName || user.name, savedAt: new Date().toISOString() });
    if (list.length > 100) list.length = 100;
    nowSaved = true;
  }
  store.set(SAVED_KEY, list);
  recordHistory(nowSaved ? 'updated' : 'deleted',
    `${nowSaved ? 'Saved' : 'Removed'} Roblox user ${user.name}`);
  return nowSaved;
}

/** @returns {{universeId:number,name:string,rootPlaceId?:number,savedAt?:string}[]} */
export function getFavoriteGames() {
  return store.get(FAV_GAMES_KEY, []);
}

export function isFavoriteGame(universeId) {
  return getFavoriteGames().some((g) => g.universeId === Number(universeId));
}

/** @returns {boolean} true when now favorited. */
export function toggleFavoriteGame(game) {
  const list = getFavoriteGames();
  const idx = list.findIndex((g) => g.universeId === Number(game.universeId));
  let nowFav;
  if (idx >= 0) { list.splice(idx, 1); nowFav = false; } else {
    list.unshift({
      universeId: Number(game.universeId), name: game.name || '',
      rootPlaceId: game.rootPlaceId, savedAt: new Date().toISOString(),
    });
    if (list.length > 100) list.length = 100;
    nowFav = true;
  }
  store.set(FAV_GAMES_KEY, list);
  recordHistory(nowFav ? 'updated' : 'deleted',
    `${nowFav ? 'Favorited' : 'Unfavorited'} Roblox game ${game.name || game.universeId}`);
  return nowFav;
}

/* ── Session identity (never the cookie itself) ─────────────────────────────── */

/** @returns {{id:number,name:string,displayName?:string}|null} */
export function getSelf() {
  return store.get(SELF_KEY, null);
}

export function hasSession() {
  return Boolean(getSelf());
}

/** Cache the verified identity after a successful authenticated() probe. */
export function setSelf(self) {
  if (!self || !Number.isFinite(Number(self.id))) return;
  store.set(SELF_KEY, { id: Number(self.id), name: self.name, displayName: self.displayName || self.name });
}

export function clearSelf() {
  store.remove(SELF_KEY);
}

/**
 * Verify the vault-stored session against users.authenticated().
 * @returns {Promise<{ok:true,self:object}|{ok:false,error:RbxError}>}
 */
export async function refreshSession() {
  try {
    const me = await users.authenticated();
    if (me && me.id != null) {
      const self = { id: me.id, name: me.name, displayName: me.displayName || me.name };
      setSelf(self);
      return { ok: true, self };
    }
    clearSelf();
    return { ok: false, error: new RbxError(401, 'Session cookie was not accepted.', 'Reconnect on the Session tab.') };
  } catch (err) {
    clearSelf();
    return { ok: false, error: err instanceof RbxError ? err : new RbxError(statusOf(err), String(err?.message || err), '') };
  }
}

/* ── Recent lookups (Home quick grid) ───────────────────────────────────────── */

export function getRecentLookups() {
  return store.get(RECENT_LOOKUP_KEY, []);
}

export function pushRecentLookup(entry) {
  const list = getRecentLookups().filter((r) => r.key !== entry.key);
  list.unshift(entry);
  if (list.length > 12) list.length = 12;
  store.set(RECENT_LOOKUP_KEY, list);
}

/* ── Local history recording (optional peer) ────────────────────────────────── */

/**
 * Fire-and-forget history recording; silently no-op when Lane C's history
 * module has not landed yet.
 * @param {'created'|'updated'|'deleted'|'restored'|'undone'|'imported'|'settings'} kind
 * @param {string} label
 */
async function recordHistory(kind, label) {
  try {
    const mod = await import('../../core/history.js');
    if (mod && typeof mod.record === 'function') mod.record({ kind, label });
  } catch { /* optional peer */ }
}

/* ── Settings registrations (contract F) ────────────────────────────────────── */

// Localized copy note: the i18n catalogs live in core/i18n.js owned by another
// lane. We register settings with local bilingual copy today and prefer catalog
// keys whenever a later catalog adds them (same tr() pattern as peers.js).
const LOCAL_SETTING_LABELS = {
  throttleMs: {
    en: 'Request spacing (ms)',
    yue: '請求間隔（毫秒）',
    explainEn: 'Minimum milliseconds between Roblox API calls. Higher is gentler on rate limits but slower to load pages.',
    explainYue: '兩次 Roblox API 呼叫之間的最少毫秒數。調高對速率限制更客氣，但載入會慢一點。',
  },
  cacheTtlSec: {
    en: 'Response cache lifetime (seconds)',
    yue: '回應快取時間（秒）',
    explainEn: 'How long identical GET responses are reused before refetching. Shorter means fresher data, more requests.',
    explainYue: '相同的 GET 回應會重用幾多秒先重新抓取。短啲資料更新鮮，但請求會多啲。',
  },
  presenceIntervalSec: {
    en: 'Presence refresh interval (seconds)',
    yue: '在線狀態刷新間隔（秒）',
    explainEn: 'How often the Presence board polls while open. Never faster than 30 seconds, to stay polite to the API.',
    explainYue: 'Presence 板幾耐查一次。最快都係 30 秒一次，保持對 API 有禮貌。',
  },
  safeMode: {
    en: 'Safe mode (hide descriptions)',
    yue: '安全模式（隱藏描述）',
    explainEn: 'Hides user-written descriptions everywhere in Roblox tabs, in case you prefer not to read free-form text.',
    explainYue: '喺所有 Roblox 分頁隱藏用户自己寫嘅描述，唔想見到自由文字就開住。',
  },
};

/**
 * Prefer an i18n catalog key when it exists (t() returns the key verbatim when
 * unknown), otherwise use this lane's local copy.
 * @returns {{en:string,yue:string}}
 */
function settingCopy(keyBase, local) {
  const pick = (suffix, fb) => {
    try {
      const v = i18n.t(`${keyBase}.${suffix}`);
      if (typeof v === 'string' && v && !v.startsWith(`${keyBase}.`)) return v;
    } catch { /* ignore */ }
    return fb;
  };
  return {
    label: { en: pick('label.en', local.en), yue: pick('label.yue', local.yue) },
    explain: { en: pick('explain.en', local.explainEn), yue: pick('explain.yue', local.explainYue) },
  };
}

function buildSettingDefs() {
  const defs = [];
  // Catalog keys follow `settings.roblox.<leaf>.{label,explain}.{en,yue}`;
  // until a catalog adds them, LOCAL_SETTING_LABELS supplies both languages.
  const copyFor = (leaf) => settingCopy(`settings.roblox.${leaf}`, LOCAL_SETTING_LABELS[leaf]);
  const addSlider = (key, min, max, step, dflt, unit) => {
    const c = copyFor(key.split('.').pop());
    defs.push({
      key, type: 'slider', def: dflt, group: 'Roblox',
      min, max, step, unit, label: c.label, explain: c.explain,
    });
  };
  addSlider('roblox.throttleMs', 50, 500, 10, 150, 'ms');
  addSlider('roblox.cacheTtlSec', 15, 600, 15, 60, 's');
  addSlider('roblox.presenceIntervalSec', 30, 600, 10, 120, 's');
  {
    const c = copyFor('safeMode');
    defs.push({
      key: 'roblox.safeMode', type: 'toggle', def: false, group: 'Roblox',
      label: c.label, explain: c.explain,
    });
  }
  return defs;
}

/* ── init ───────────────────────────────────────────────────────────────────── */

let initialized = false;

/**
 * Lane bootstrap: inject this feature's stylesheet once and register the
 * Roblox settings group. Runs before any surface init (see index.js order).
 */
export async function init() {
  if (initialized) return;
  initialized = true;
  try {
    await ui.injectCss(new URL('../../styles/features/roblox.css', import.meta.url).href);
  } catch { /* stylesheet injection must never block the lane */ }
  try {
    settings.register(buildSettingDefs());
  } catch { /* duplicate registration is harmless */ }
}
