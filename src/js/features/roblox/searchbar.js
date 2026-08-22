/**
 * Surface search bar factory for the Roblox lane.
 *
 * Renders an accessible search field with clear + submit affordances, recent
 * search chips persisted per surface key (capped at 8, click-to-fill), a
 * 350 ms debounce on typing with immediate submit on Enter, and — when Lane
 * C's regex builder has landed — the anchored builder button wired through
 * regexbuilder.attachSearch. Without that peer the bar still works in plain
 * text mode; the builder button simply never renders.
 */

import { store } from '../../core/store.js';
import { ui } from '../../core/ui.js';
import { loadRegexBuilder, tr } from './peers.js';

const el = (...args) => ui.el(...args);

const RECENT_CAP = 8;
const DEBOUNCE_MS = 350;

function debounce(fn, ms) {
  if (typeof ui.debounce === 'function') return ui.debounce(fn, ms);
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function recentKey(historyKey) {
  return `roblox:recentSearches:${historyKey || 'default'}`;
}

/**
 * Create a surface search bar.
 *
 * @param {{
 *   placeholder?: string,
 *   ariaLabel?: string,
 *   historyKey?: string,
 *   submitLabel?: string,
 *   onQuery: (q: string, ctx: {mode:'plain'|'regex', flags:string, source:string}) => void,
 * }} spec
 * @returns {Promise<{
 *   root: HTMLElement,
 *   input: HTMLInputElement,
 *   setValue: (v: string, opts?: {run?: boolean}) => void,
 *   focus: () => void,
 *   destroy: () => void,
 * }>}
 */
export async function createSearchBar(spec) {
  const state = { mode: 'plain', flags: '', lastEmitted: null };

  const root = el('div', { class: 'rbx-search' });

  const input = el('input', {
    type: 'text',
    class: 'mrb-field rbx-search__input',
    placeholder: spec.placeholder || tr('roblox.search.placeholder', 'Search…', '搜尋……'),
    spellcheck: 'false',
    autocomplete: 'off',
    enterkeyhint: 'search',
  });
  const inputId = `rbx-sb-${Math.random().toString(36).slice(2, 9)}`;
  input.id = inputId;
  const label = el('label', {
    class: 'rbx-visually-hidden',
    for: inputId,
  }, spec.ariaLabel || spec.placeholder || tr('roblox.search.label', 'Search', '搜尋'));

  const clearBtn = el('button', {
    type: 'button',
    class: 'mrb-btn text rbx-search__clear',
    'aria-label': tr('roblox.search.clear', 'Clear search', '清除搜尋'),
    hidden: true,
    onclick: () => {
      input.value = '';
      syncClear();
      emit(input.value, 'clear');
      input.focus();
    },
  }, '✕');

  const submitBtn = el('button', {
    type: 'button',
    class: 'mrb-btn tonal rbx-search__submit',
    title: spec.submitLabel || tr('roblox.search.go', 'Search', '搜尋'),
    onclick: () => {
      commitRecent(input.value);
      emit(input.value, 'submit');
    },
  }, spec.submitLabel || tr('roblox.search.go', 'Search', '搜尋'));

  const chipsRow = el('div', { class: 'rbx-search__recents' });

  root.append(label, el('div', { class: 'rbx-search__row' }, input, clearBtn, submitBtn), chipsRow);

  /* ── query plumbing ─────────────────────────────────────────────────────── */

  function emit(q, source) {
    const value = String(q ?? '').trim();
    // Skip re-emitting an identical query from a different trigger.
    if (value === state.lastEmitted && source !== 'programmatic') return;
    state.lastEmitted = value;
    try {
      spec.onQuery(value, { mode: state.mode, flags: state.flags, source });
    } catch (err) {
      // A consumer bug must not break typing; surface it non-fatally.
      console.error('[roblox] search handler failed:', err);
    }
  }

  const debouncedEmit = debounce((q) => emit(q, 'type'), DEBOUNCE_MS);

  function syncClear() {
    clearBtn.hidden = !input.value;
  }

  input.addEventListener('input', () => {
    syncClear();
    debouncedEmit(input.value);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitRecent(input.value);
      emit(input.value, 'enter');
    }
  });

  /* ── recent chips ────────────────────────────────────────────────────────── */

  function getRecents() {
    const list = store.get(recentKey(spec.historyKey), []);
    return Array.isArray(list) ? list.slice(0, RECENT_CAP) : [];
  }

  function renderRecents() {
    chipsRow.textContent = '';
    const recents = getRecents();
    if (!recents.length) return;
    chipsRow.appendChild(el('span', { class: 'rbx-search__recents-label' },
      tr('roblox.search.recent', 'Recent:', '最近：')));
    for (const q of recents) {
      chipsRow.appendChild(el('button', {
        type: 'button',
        class: 'mrb-chip rbx-search__chip',
        title: q,
        onclick: () => {
          input.value = q;
          syncClear();
          emit(q, 'chip');
        },
      }, q));
    }
    chipsRow.appendChild(el('button', {
      type: 'button',
      class: 'mrb-btn text rbx-search__recents-clear',
      onclick: () => {
        store.remove(recentKey(spec.historyKey));
        renderRecents();
      },
    }, tr('roblox.search.recentClear', 'Clear recent', '清除紀錄')));
  }

  function commitRecent(raw) {
    const q = String(raw ?? '').trim();
    if (!q) return;
    const list = getRecents().filter((r) => r.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    store.set(recentKey(spec.historyKey), list.slice(0, RECENT_CAP));
    renderRecents();
  }

  renderRecents();

  /* ── optional regex-builder integration (Lane C, guarded) ─────────────────── */

  try {
    const rb = await loadRegexBuilder();
    if (rb && typeof rb.attachSearch === 'function') {
      // The builder owns mode/flags and calls back with them; our own typing
      // listener stays active for plain-text default and Enter submits.
      rb.attachSearch(inputEl(), {
        placeholder: '',
        onQuery: (q, ctx) => {
          if (ctx && ctx.mode) state.mode = ctx.mode;
          if (ctx && typeof ctx.flags === 'string') state.flags = ctx.flags;
          commitRecentSilently(q);
          emit(q, ctx && ctx.mode === 'regex' ? 'regex' : 'type');
        },
      });
      if (typeof rb.openBuilder === 'function') {
        const btn = el('button', {
          type: 'button',
          class: 'mrb-btn text rbx-search__builder',
          title: tr('roblox.search.builder', 'Open pattern builder', '開啟模式建構器'),
          'aria-label': tr('roblox.search.builder', 'Open pattern builder', '開啟模式建構器'),
          onclick: () => rb.openBuilder(input),
        }, '.*');
        root.querySelector('.rbx-search__row').insertBefore(btn, submitBtn);
      }
    }
  } catch { /* builder is optional; plain text remains */ }

  /** attachSearch needs the element; tiny indirection keeps ordering simple. */
  function inputEl() { return input; }

  function commitRecentSilently(raw) {
    const q = String(raw ?? '').trim();
    if (!q || q.length < 3) return;
    const list = getRecents().filter((r) => r.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    store.set(recentKey(spec.historyKey), list.slice(0, RECENT_CAP));
    renderRecents();
  }

  /* ── controller ──────────────────────────────────────────────────────────── */

  return {
    root,
    input,
    setValue(v, opts = {}) {
      input.value = String(v ?? '');
      syncClear();
      if (opts.run) emit(input.value, 'programmatic');
    },
    focus() { input.focus(); },
    destroy() {
      root.remove();
    },
  };
}
