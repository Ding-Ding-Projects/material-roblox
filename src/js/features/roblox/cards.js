/**
 * Shared rendering kit for Roblox surfaces: result cards, responsive grids,
 * skeletons, empty/error states, cursor pagination, stat chips, aria-live
 * announcements, graceful thumbnails, and small formatting helpers.
 *
 * Everything here builds DOM with ui.el (contract §4) — no innerHTML for any
 * data-derived string, so user-visible API text is never an injection path.
 * Descriptions are additionally passed through escapeHtml + linkifySafe().
 */

import { ui } from '../../core/ui.js';
import { tr, voice } from './peers.js';

const el = (...args) => ui.el(...args);

/* ── Text helpers ───────────────────────────────────────────────────────────── */

export { tr, voice };

/** Locale-aware medium date; returns '—' for missing/invalid input. */
export function formatDate(iso, opts = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return d.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', ...(opts.withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Thousands-separated integer; '—' for missing values. */
export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return v.toLocaleString(); } catch { return String(v); }
}

/**
 * Escape a free-text description and turn bare https URLs into safe external
 * links. The text is escaped FIRST so no markup survives from the source;
 * links are then built as elements whose href is restricted to https.
 * @param {string} text
 * @returns {HTMLElement[]} paragraph children
 */
export function richText(text) {
  if (!text || !String(text).trim()) {
    return [document.createTextNode('')];
  }
  const escaped = ui.escapeHtml(String(text));
  const parts = escaped.split(/(https:\/\/[^\s<]+)/g);
  const nodes = [];
  for (const part of parts) {
    if (/^https:\/\/[^\s]+$/.test(part)) {
      const a = el('a', {
        class: 'rbx-link',
        href: '#',
        rel: 'noopener noreferrer',
        title: part,
        onclick: (ev) => {
          ev.preventDefault();
          try { window.mrb.invoke('shell:openExternal', { url: part }); } catch { /* bridge absent */ }
        },
      }, part.length > 64 ? `${part.slice(0, 61)}…` : part);
      nodes.push(a);
    } else if (part.includes('\n')) {
      part.split('\n').forEach((line, idx) => {
        if (idx > 0) nodes.push(el('br'));
        if (line) nodes.push(document.createTextNode(line));
      });
    } else if (part) {
      nodes.push(document.createTextNode(part));
    }
  }
  return nodes;
}

/* ── aria-live announcements ─────────────────────────────────────────────────── */

let liveEl = null;

/** Mount (once) and return the polite live region appended to <body>. */
export function liveRegion() {
  if (liveEl && document.body.contains(liveEl)) return liveEl;
  liveEl = el('div', {
    class: 'rbx-visually-hidden',
    'aria-live': 'polite',
    role: 'status',
  });
  document.body.appendChild(liveEl);
  return liveEl;
}

/**
 * Announce a result summary to screen readers (async loads, counts, errors).
 * @param {string} text
 */
export function announce(text) {
  const node = liveRegion();
  node.textContent = '';
  // Clearing first forces assistive tech to re-read identical messages.
  requestAnimationFrame(() => { node.textContent = voice('neutral', String(text)); });
}

/* ── Thumbnails ─────────────────────────────────────────────────────────────── */

/**
 * Lazy thumbnail image that degrades to a letter tile when the URL fails or
 * is a non-image placeholder state ('Pending', 'Blocked', null).
 *
 * @param {string|null|undefined} url direct CDN URL or null
 * @param {{size?:number, alt?:string, letter?:string}} [opts]
 * @returns {HTMLElement} square wrapper containing the img or fallback tile
 */
export function thumbImg(url, opts = {}) {
  const size = Number(opts.size) || 150;
  const alt = String(opts.alt || '');
  const wrap = el('div', {
    class: 'rbx-thumb',
    style: `width:${size}px;height:${size}px`,
  });
  const showFallback = () => {
    wrap.classList.add('rbx-thumb--fallback');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', alt || 'Image unavailable');
    const letter = String(opts.letter || '?').trim().charAt(0).toUpperCase() || '?';
    wrap.appendChild(el('span', {
      class: 'rbx-thumb__letter',
      'aria-hidden': 'true',
      style: `font-size:${Math.round(size / 2.6)}px`,
    }, letter));
  };
  if (!url || !/^https?:\/\//i.test(url)) {
    showFallback();
    return wrap;
  }
  // Only platform image hosts may drive <img> requests; anything else falls
  // back so a crafted string cannot use the surface to probe other origins.
  {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) { /* treated as unsafe */ }
    const trusted =
      host === 'roblox.com' || host.endsWith('.roblox.com') ||
      host === 'rbxcdn.com' || host.endsWith('.rbxcdn.com');
    if (!trusted) {
      showFallback();
      return wrap;
    }
  }
  const img = document.createElement('img');
  img.loading = 'lazy';            // allowed exception to the no-direct-fetch rule
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.width = size;
  img.height = size;
  img.alt = alt;
  img.addEventListener('error', () => { img.remove(); showFallback(); });
  img.src = url;
  wrap.appendChild(img);
  return wrap;
}

/* ── Chips ───────────────────────────────────────────────────────────────────── */

/**
 * Small labelled chip.
 * @param {string} label
 * @param {string} value
 */
export function statChip(label, value) {
  return el('span', {
    class: 'rbx-statchip',
    title: `${label}: ${value}`,
  }, el('strong', {}, value), el('span', { class: 'rbx-statchip__label' }, label));
}

/** Tone chip used for badges such as Limited / rarity buckets. */
export function badgeChip(text, tone = 'neutral') {
  return el('span', { class: `rbx-chip rbx-chip--${tone}` }, text);
}

/**
 * Rarity bucket from a badge win-rate percentage.
 * @param {number|null} rate winRatePercentage (0–100) or null when unknown
 */
export function rarityChip(rate) {
  if (!Number.isFinite(Number(rate))) return badgeChip(tr('roblox.rarity.unknown', 'Rarity unknown', '稀有度不明'), 'muted');
  const r = Number(rate);
  if (r >= 50) return badgeChip(tr('roblox.rarity.common', 'Common', '常見'), 'common');
  if (r >= 10) return badgeChip(tr('roblox.rarity.uncommon', 'Uncommon', '少見'), 'uncommon');
  if (r >= 1) return badgeChip(tr('roblox.rarity.rare', 'Rare', '稀有'), 'rare');
  return badgeChip(tr('roblox.rarity.ultra', 'Ultra rare', '極稀有'), 'ultra');
}

/** Coloured presence dot as DATA colouring (exempt from chrome rules). */
export function presenceDot(typeCode) {
  const t = Number(typeCode);
  const tone = ['offline', 'website', 'ingame', 'studio', 'invisible'][t] || 'offline';
  const labels = {
    offline: ['Offline', '離線'], website: ['On website', '喺網站'],
    ingame: ['In game', '玩緊遊戲'], studio: ['In Studio', '用緊 Studio'],
    invisible: ['Invisible', '隱形'],
  };
  const [labelEn, labelYue] = labels[tone] || labels.offline;
  return el('span', { class: `rbx-dot rbx-dot--${tone}`, role: 'img', 'aria-label': tr(`roblox.presence.${tone}`, labelEn, labelYue) });
}

/** Health dot for service chips: ok / degraded / down. */
export function healthDot(status) {
  const cls = status === 'ok' ? 'ok' : (status === 'degraded' ? 'degraded' : 'down');
  const word = { ok: 'OK', degraded: 'Degraded', down: 'Down' }[cls];
  return el('span', { class: `rbx-dot rbx-dot--h-${cls}`, role: 'img', 'aria-label': word });
}

/**
 * Delta marker between two numeric stats.
 * @param {number|null} a old value
 * @param {number|null} b new value
 */
export function deltaArrow(a, b) {
  const x = Number(a); const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return el('span', { class: 'rbx-delta' }, '—');
  }
  const diff = y - x;
  if (diff === 0) return el('span', { class: 'rbx-delta rbx-delta--flat', 'aria-label': 'No change' }, el('span', { 'aria-hidden': 'true' }, '='), ` ${formatNumber(0)}`);
  const up = diff > 0;
  return el('span', {
    class: `rbx-delta ${up ? 'rbx-delta--up' : 'rbx-delta--down'}`,
    'aria-label': `${up ? 'Increased' : 'Decreased'} by ${formatNumber(Math.abs(diff))}`,
  },
  el('span', { 'aria-hidden': 'true' }, up ? '▲' : '▼'),
  ` ${formatNumber(Math.abs(diff))}`);
}

/* ── Cards & grids ───────────────────────────────────────────────────────────── */

/**
 * Result card.
 *
 * @param {{
 *   thumb?: HTMLElement|string|null,
 *   thumbAlt?: string,
 *   title?: string,
 *   subtitle?: string,
 *   badges?: {text:string,tone?:string}[],
 *   meta?: Record<string,string>,
 *   actions?: {label:string,title?:string,onClick?:(card:HTMLElement)=>void,
 *              kind?:'filled'|'tonal'|'outlined'|'text'|'danger'}[],
 *   selected?: boolean,
 *   leading?: HTMLElement,
 * }} spec
 * @returns {HTMLElement}
 */
export function resultCard(spec = {}) {
  const card = el('article', { class: 'rbx-card', tabindex: '-1' });

  const mediaRow = [];
  if (spec.leading) mediaRow.push(spec.leading);
  if (spec.thumb !== undefined) {
    const t = typeof spec.thumb === 'string' || spec.thumb == null
      ? thumbImg(spec.thumb, { size: 150, alt: spec.thumbAlt || '' })
      : spec.thumb;
    mediaRow.push(t);
  }
  if (mediaRow.length) card.appendChild(el('div', { class: 'rbx-card__media' }, ...mediaRow));

  if (spec.selected !== undefined) {
    const cb = el('input', { type: 'checkbox', class: 'rbx-select-box' });
    cb.checked = Boolean(spec.selected);
    cb.setAttribute('aria-label', `Select ${spec.title || 'item'}`);
    card.prepend(el('label', { class: 'rbx-card__select' }, cb));
  }

  if (spec.title) card.appendChild(el('h3', { class: 'rbx-card__title' }, spec.title));
  if (spec.subtitle) card.appendChild(el('p', { class: 'rbx-card__sub' }, spec.subtitle));

  if (Array.isArray(spec.badges) && spec.badges.length) {
    card.appendChild(el('div', { class: 'rbx-chip-row' },
      ...spec.badges.map((b) => badgeChip(b.text, b.tone))));
  }

  if (spec.meta && Object.keys(spec.meta).length) {
    const dl = el('dl', { class: 'rbx-meta' });
    for (const [k, v] of Object.entries(spec.meta)) {
      dl.append(el('div', { class: 'rbx-meta__row' },
        el('dt', {}, k), el('dd', {}, v ?? '—')));
    }
    card.appendChild(dl);
  }

  if (Array.isArray(spec.actions) && spec.actions.length) {
    const bar = el('div', { class: 'rbx-actions' });
    for (const a of spec.actions) {
      if (!a || typeof a.onClick !== 'function') continue; // never render dead buttons
      bar.appendChild(el('button', {
        type: 'button',
        class: `mrb-btn ${a.kind || 'tonal'}${a.danger ? ' danger' : ''}`.trim(),
        title: a.title || a.label,
        onclick: () => a.onClick(card),
      }, a.label));
    }
    if (bar.childNodes.length) card.appendChild(bar);
  }
  return card;
}

/**
 * Responsive auto-fill grid.
 * @param {{minCol?:number, label?:string}} [opts]
 * @returns {HTMLElement} container with role="list"
 */
export function gridContainer(opts = {}) {
  const minCol = Number(opts.minCol) || 240;
  const grid = el('div', {
    class: 'rbx-grid',
    role: 'list',
    style: `--rbx-grid-min:${minCol}px`,
    'aria-label': opts.label || tr('roblox.grid.results', 'Results', '結果'),
  });
  return grid;
}

/**
 * Skeleton placeholder cards shown while loading.
 * @param {number} n count of skeleton cards
 */
export function skeletonCards(n = 8) {
  const wrap = el('div', { class: 'rbx-grid', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i += 1) {
    wrap.appendChild(el('div', { class: 'rbx-card rbx-skel' },
      el('div', { class: 'mrb-skeleton rbx-skel__thumb' }),
      el('div', { class: 'mrb-skeleton rbx-skel__line' }),
      el('div', { class: 'mrb-skeleton rbx-skel__line rbx-skel__line--short' })));
  }
  return wrap;
}

/* ── Empty / error states ────────────────────────────────────────────────────── */

/**
 * Honest empty state — never a blank area.
 * @param {string} icon decorative glyph (aria-hidden)
 * @param {string} title
 * @param {string} body factual explanation of why it is empty
 * @param {{label:string,onClick:Function,title?:string}|null} [action]
 */
export function emptyState(icon, title, body, action = null) {
  const box = el('div', { class: 'rbx-empty' },
    el('div', { class: 'rbx-empty__icon', 'aria-hidden': 'true' }, icon),
    el('h3', {}, title),
    body ? el('p', {}, body) : null);
  if (action && typeof action.onClick === 'function') {
    box.appendChild(el('button', {
      type: 'button',
      class: 'mrb-btn filled',
      title: action.title || action.label,
      onclick: action.onClick,
    }, action.label));
  }
  return box;
}

/**
 * Actionable error state.
 * @param {Error|RbxErrorLike|string} err
 * @param {{retry?:Function, context?:string}} [opts]
 */
export function errorState(err, opts = {}) {
  const status = err && err.status != null ? err.status : null;
  const message = typeof err === 'string' ? err : String((err && err.message) || err || 'Something went wrong.');
  const hint = (err && err.hint) || '';
  const box = el('div', { class: 'rbx-error', role: 'alert' },
    el('div', { class: 'rbx-error__icon', 'aria-hidden': 'true' }, '⚠️'),
    el('h3', {}, status ? `Request failed (HTTP ${status})` : tr('roblox.error.title', 'Request failed', '請求失敗')),
    el('p', { class: 'rbx-error__msg' }, voice('error', message)),
    hint ? el('p', { class: 'rbx-error__hint' }, hint) : null,
    opts.context ? el('p', { class: 'rbx-error__ctx' }, opts.context) : null);
  if (typeof opts.retry === 'function') {
    box.appendChild(el('button', {
      type: 'button',
      class: 'mrb-btn outlined',
      onclick: () => opts.retry(),
    }, tr('roblox.error.retry', 'Retry', '重試')));
  }
  return box;
}

/* ── Cursor pagination ───────────────────────────────────────────────────────── */

/**
 * Cursor-based pagination controls.
 * Prev/Next callbacks are provided by the caller only when a page exists in
 * that direction; missing callbacks render disabled buttons rather than dead
 * ones.
 *
 * @param {{prev?:Function, next?:Function, prevLabel?:string, nextLabel?:string,
 *          hint?:string, onNavigate?:(dir:'prev'|'next')=>void}} spec
 * @returns {HTMLElement}
 */
export function paginationControls(spec = {}) {
  const nav = el('nav', { class: 'rbx-pager', 'aria-label': tr('roblox.pager.label', 'Pagination', '分頁') });
  const mkBtn = (label, fn, dir) => el('button', {
    type: 'button',
    class: 'mrb-btn outlined',
    disabled: typeof fn !== 'function',
    'aria-disabled': typeof fn !== 'function' ? 'true' : 'false',
    title: typeof fn === 'function' ? label : tr('roblox.pager.none', 'Nothing more in this direction', '呢個方向冇更多'),
    onclick: () => { if (typeof fn === 'function') fn(); if (spec.onNavigate) spec.onNavigate(dir); },
  }, label);

  nav.appendChild(mkBtn(spec.prevLabel || tr('roblox.pager.prev', '← Previous', '← 上一頁'), spec.prev, 'prev'));

  nav.appendChild(el('button', {
    type: 'button',
    class: 'mrb-btn text',
    disabled: true,
    'aria-hidden': 'false',
  }, spec.hint || ''));

  nav.appendChild(mkBtn(spec.nextLabel || tr('roblox.pager.next', 'Next →', '下一頁 →'), spec.next, 'next'));
  return nav;
}

/* ── Anchored drawer ─────────────────────────────────────────────────────────── */

/**
 * Open an anchored detail drawer beside a trigger element using ui.anchored
 * (own surface paint, viewport-bounded, Escape closes, focus returns).
 *
 * @param {HTMLElement} anchorEl
 * @param {{title:string, build:(panel:HTMLElement, close:()=>void)=>void}} spec
 * @returns {()=>void} close function
 */
export function drawer(anchorEl, spec) {
  const panel = el('div', { class: 'rbx-drawer', role: 'dialog', 'aria-label': spec.title });
  const header = el('div', { class: 'rbx-drawer__head' },
    el('h2', { class: 'rbx-drawer__title' }, spec.title),
    el('button', {
      type: 'button', class: 'mrb-btn text', 'aria-label': tr('roblox.drawer.close', 'Close', '關閉'),
      onclick: () => close(),
    }, '✕'));
  panel.appendChild(header);
  const body = el('div', { class: 'rbx-drawer__body' });
  panel.appendChild(body);
  const close = ui.anchored(anchorEl, panel, {});
  try {
    const built = spec.build(body, close);
    if (built && typeof built.catch === 'function') {
      built.catch((err) => body.appendChild(errorState(err, {})));
    }
  } catch (err) {
    body.appendChild(errorState(err, {}));
  }
  const firstFocusable = panel.querySelector('button, [href], input, select, textarea');
  if (firstFocusable) firstFocusable.focus();
  return close;
}
