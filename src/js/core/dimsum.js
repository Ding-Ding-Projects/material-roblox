'use strict';

/**
 * Dim sum surprise — a 10% chance at startup of showing one random dish.
 *
 * Policy implemented here:
 *  - Suppressed ENTIRELY under School mode BEFORE any network activity: the
 *    catalog is never fetched, never refreshed, and never drawn while School
 *    mode is active, and a mode switch mid-window cancels the pending draw.
 *  - There is deliberately NO off-switch for the surprise itself. It stays
 *    polite by construction instead: non-blocking, bottom-right, auto-dismiss,
 *    never gating startup and never interrupting a task. Any legacy
 *    "disabled" preference keys are ignored and deleted on first read so old
 *    profiles simply rejoin the draw.
 *  - Photos come ONLY from the public Ding-Ding-Projects photo catalog
 *    releases; nothing is generated or vendored here. Offline with no cache
 *    means a silent skip — the surprise never becomes an error.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

const CACHE_KEY = 'mrb:dimsumCache';
const CATALOG_URL =
  'https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json';
const STALE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DRAW_DELAY_MS = 8000;
const DRAW_CHANCE = 0.10;
const CARD_TIMEOUT_MS = 12000;

/** @type {{fetchedAt:number, revision:string, dishes:Array<{id,nameEn,nameZhHant,photoUrl}>}|null} */
let cache = null;
let drawTimer = null;
let drawnThisLaunch = false;

function ipc(channel, payload) {
  try {
    if (window.mrb && typeof window.mrb.invoke === 'function') {
      return window.mrb.invoke(channel, payload);
    }
  } catch {
    /* bridge missing */
  }
  return Promise.reject(new Error('The app bridge is unavailable.'));
}

/**
 * Localized label helper: uses the shared catalogs when they carry the key,
 * otherwise falls back to the inline English (and Cantonese where provided)
 * copy shipped with this feature. Facts stay identical in every language.
 */
function tr(key, en, yue) {
  try {
    const out = i18n.t(key);
    if (out && out !== key) return out;
  } catch {
    /* catalogs unavailable */
  }
  let lang = 'en';
  try {
    lang = i18n.lang();
  } catch {
    /* default English */
  }
  if (lang === 'yue' && typeof yue === 'string') return yue;
  if (lang === 'bi' && typeof yue === 'string') return `${en} · ${yue}`;
  return en;
}

// ---------------------------------------------------------------------------
// Catalog handling
// ---------------------------------------------------------------------------

function normalizeCatalog(parsed) {
  const root = parsed && typeof parsed === 'object' ? parsed : {};
  const rawList =
    (Array.isArray(root.dishes) && root.dishes) ||
    (Array.isArray(root.items) && root.items) ||
    (Array.isArray(root.catalog) && root.catalog) ||
    [];
  const releaseTag =
    typeof root.releaseTag === 'string' && root.releaseTag
      ? root.releaseTag
      : typeof root.tag === 'string' && root.tag
        ? root.tag
        : 'catalog-v1';
  /** @type {Array<{id,nameEn,nameZhHant,photoUrl}>} */
  const dishes = [];
  for (const item of rawList.slice(0, 5000)) {
    if (!item || typeof item !== 'object') continue;
    const names = item.name && typeof item.name === 'object' ? item.name : {};
    const nameEn = String(names.en || item.nameEn || '').trim();
    const nameZhHant = String(names.zhHant || names.zh_Hant || item.nameZhHant || '').trim();
    if (!nameEn || !nameZhHant) continue;
    const rawAsset =
      (typeof item.photoUrl === 'string' && item.photoUrl) ||
      (typeof item.file === 'string' && item.file) ||
      (typeof item.asset === 'string' && item.asset) ||
      '';
    if (!rawAsset) continue;
    const photoUrl = /^https:\/\//i.test(rawAsset)
      ? rawAsset
      : `https://github.com/Ding-Ding-Projects/dim-sum-photos/releases/download/${encodeURIComponent(releaseTag)}/${rawAsset.split('/').map(encodeURIComponent).join('/')}`;
    dishes.push({
      id: String(item.id || `${nameEn}`),
      nameEn,
      nameZhHant,
      photoUrl,
    });
  }
  return {
    fetchedAt: Date.now(),
    revision: String(root.revision || root.commit || ''),
    dishes,
  };
}

async function refreshCatalog(force) {
  const fresh = cache && Date.now() - cache.fetchedAt < STALE_MS;
  if (!force && fresh) return cache;
  try {
    const res = await ipc('net:get', {
      url: CATALOG_URL,
      timeoutMs: 15000,
      maxBytes: 1048576,
    });
    if (res && res.json) {
      const normalized = normalizeCatalog(res.json);
      if (normalized.dishes.length > 0) {
        cache = normalized;
        store.set(CACHE_KEY, cache);
      }
    }
  } catch {
    // Silent by design: offline or blocked network keeps the previous cache
    // and the surprise simply skips when there is nothing to draw from.
  }
  return cache;
}

/** Dish-name pool for the unlock ladder's first rung (empty when unavailable). */
export function getDishPool() {
  return (cache ? cache.dishes : []).map((d) => d.nameEn);
}

// ---------------------------------------------------------------------------
// Legacy preference migration
// ---------------------------------------------------------------------------

function purgeLegacyDisablePrefs() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /dimsum/i.test(k) && /disabl|off|hidden/i.test(k)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Card presentation
// ---------------------------------------------------------------------------

function showCard(dish) {
  const holder = document.createElement('div');
  holder.className = 'mrb-dimsum-card';
  holder.setAttribute('role', 'status');

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = `${dish.nameEn} · ${dish.nameZhHant}`;
  img.addEventListener('error', () => {
    // A missing public asset is skipped honestly — never replaced locally.
    close();
  });
  img.src = dish.photoUrl;

  const text = document.createElement('div');
  text.className = 'mrb-dimsum-text';
  const title = document.createElement('strong');
  const lang = (() => {
    try {
      return i18n.lang();
    } catch {
      return 'en';
    }
  })();
  title.textContent = lang === 'yue' ? dish.nameZhHant : dish.nameEn;
  const sub = document.createElement('span');
  sub.className = 'mrb-dimsum-sub';
  sub.textContent = lang === 'en' ? dish.nameZhHant : dish.nameEn;
  text.append(title, sub);

  const closeBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--text mrb-dimsum-close',
    type: 'button',
    'aria-label': tr('dimsum.close', 'Close'),
    onclick: () => close(),
  });
  closeBtn.textContent = '✕';

  holder.append(img, text, closeBtn);
  document.body.appendChild(holder);

  let timer = setTimeout(close, CARD_TIMEOUT_MS);
  const pause = () => {
    clearTimeout(timer);
  };
  const resume = () => {
    clearTimeout(timer);
    timer = setTimeout(close, CARD_TIMEOUT_MS);
  };
  holder.addEventListener('mouseenter', pause);
  holder.addEventListener('mouseleave', resume);
  holder.addEventListener('focusin', pause);
  holder.addEventListener('focusout', resume);

  function close() {
    clearTimeout(timer);
    holder.remove();
  }
}

// ---------------------------------------------------------------------------

export async function init() {
  purgeLegacyDisablePrefs();
  try {
    ui.injectCss(new URL('../../styles/features/delight.css', import.meta.url).href);
  } catch {
    /* styling degrades to defaults */
  }

  const cached = store.get(CACHE_KEY, null);
  if (
    cached &&
    typeof cached === 'object' &&
    Array.isArray(cached.dishes) &&
    typeof cached.fetchedAt === 'number'
  ) {
    cache = cached;
  }

  // School mode check happens BEFORE anything schedules or fetches.
  const schoolBlocked = (() => {
    try {
      return !!i18n.schoolActive();
    } catch {
      return false;
    }
  })();

  // Background catalog refresh is silent and keeps the old cache on failure.
  if (!schoolBlocked) void refreshCatalog(false);

  if (drawTimer || drawnThisLaunch) return;
  drawTimer = setTimeout(() => {
    drawTimer = null;
    if (drawnThisLaunch) return;
    drawnThisLaunch = true;
    let blocked = false;
    try {
      blocked = !!i18n.schoolActive();
    } catch {
      blocked = false;
    }
    if (blocked) return; // suppressed entirely, including any fetch above
    if (Math.random() >= DRAW_CHANCE) return;
    const dishes = cache ? cache.dishes : [];
    if (dishes.length === 0) return; // offline with no cache: silent skip
    showCard(dishes[Math.floor(Math.random() * dishes.length)]);
  }, DRAW_DELAY_MS);

  // A School-mode activation during the draw window cancels the pending draw.
  // Live propagation arrives via the shared 'mrb-school-change' event other
  // lanes forward; the draw-time re-check above is the backstop either way.
  try {
    window.addEventListener('mrb-school-change', () => {
      if (drawTimer && i18n.schoolActive()) {
        clearTimeout(drawTimer);
        drawTimer = null;
      }
    });
  } catch {
    /* event plumbing unavailable; re-check still guards */
  }
}

// Test seam kept internal; exported for the lane's own verification tooling.
export function __testHooks() {
  return {
    normalizeCatalog,
    forceDrawForVerification: () => {
      const dishes = cache ? cache.dishes : [];
      if (dishes.length === 0) return false;
      showCard(dishes[Math.floor(Math.random() * dishes.length)]);
      return true;
    },
    setCacheForVerification: (value) => {
      cache = value;
    },
  };
}
