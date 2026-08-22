/**
 * Optional-peer loader + localized-copy helper for the Roblox lane.
 *
 * Core modules (store, i18n, ui, router, settings) are guaranteed by the
 * contract and imported statically. Lane-C UX modules (exporter, regex
 * builder, history) are integrated after this lane lands, so those are loaded
 * dynamically and degrade to `null` when absent. Callers MUST treat `null` as
 * "hide the control entirely" — a feature without its export button beats a
 * crashed feature, and a dead button is never shipped.
 */

import { i18n } from '../../core/i18n.js';

/** @typedef {{attachSearch?:Function, openBuilder?:Function}|null} RegexBuilder */
/** @typedef {{exportData:Function}|null} Exporter */
/** @typedef {{record:Function, query?:Function}|null} HistoryApi */

/**
 * Load the regex builder module (Lane C) or null.
 * @returns {Promise<RegexBuilder>}
 */
export async function loadRegexBuilder() {
  try {
    const mod = await import('../../core/regexbuilder.js');
    if (mod && (typeof mod.attachSearch === 'function' || typeof mod.openBuilder === 'function')) return mod;
    return null;
  } catch {
    return null;
  }
}

/**
 * Load the exporter module (Lane C) or null.
 * @returns {Promise<Exporter>}
 */
export async function loadExporter() {
  try {
    const mod = await import('../../core/exporter.js');
    if (mod && typeof mod.exportData === 'function') return mod;
    return null;
  } catch {
    return null;
  }
}

/**
 * Load the local-history facade (Lane C) or null.
 * @returns {Promise<HistoryApi>}
 */
export async function loadHistory() {
  try {
    const mod = await import('../../core/history.js');
    if (mod && typeof mod.record === 'function') return mod;
    return null;
  } catch {
    return null;
  }
}

/**
 * Localized-string helper shared by every Roblox surface and the API client.
 *
 * The i18n catalogs (CAT_EN/CAT_YUE) live in core/i18n.js and are owned by
 * another lane. This lane therefore ships local English + Cantonese fallback
 * copy: when `i18n.t(key)` returns the key verbatim (meaning the catalog does
 * not carry the key yet) we fall back locally. When a later catalog adds the
 * key, the catalog copy wins automatically — no code change needed here.
 * This is the documented pattern for this lane (see CONTRACT §8).
 *
 * Bilingual mode renders the primary language first with the secondary after a
 * compact separator, per the contract's bilingual convention. School mode
 * forces English presentation, which i18n.lang() reports and we honour.
 *
 * @param {string} key dotted i18n key, e.g. 'roblox.tabs.users'
 * @param {string} en local English fallback
 * @param {string} yue local Cantonese fallback
 * @returns {string}
 */
export function tr(key, en, yue) {
  let translated = null;
  let mode = 'en';
  try {
    const v = i18n.t(key);
    if (v && v !== key) translated = v;
    if (typeof i18n.lang === 'function') mode = i18n.lang();
  } catch { /* fall through to local copy */ }
  const primary = translated || en;
  if (mode === 'bi' && yue && yue !== primary) return `${primary} · ${yue}`;
  return primary;
}

/**
 * Funny-level-styled message text with facts intact (delegates to i18n.voice).
 * @param {'info'|'ok'|'warn'|'error'|'destructive'|'neutral'} category
 * @param {string} text factual text (numbers, paths, error text pass through)
 * @returns {string}
 */
export function voice(category, text) {
  try {
    if (i18n && typeof i18n.voice === 'function') {
      const v = i18n.voice(category, text);
      if (typeof v === 'string' && v) return v;
    }
  } catch { /* facts stay exact */ }
  return text;
}
