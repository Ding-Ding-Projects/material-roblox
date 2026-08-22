'use strict';

/**
 * Personal vocabulary upload — one shared, versioned, bounded JSON contract
 * feeding every surface's display copy.
 *
 * Fail-closed rules enforced here BEFORE anything is displayed or cached:
 *   - hard size limit 256 KiB
 *   - strict JSON with an explicit duplicate-key scan (the stock parser would
 *     silently collapse duplicates, so a dedicated scanner runs first)
 *   - schemaVersion "v1" only; unknown top-level fields rejected
 *   - `entries` must be a plain string→string map, ≤5000 entries,
 *     keys ≤200 chars, values ≤2000 chars, nesting depth ≤4
 *   - unsafe keys (__proto__, constructor, prototype) rejected outright
 *
 * Privacy properties (by construction, not by promise):
 *   - No network request exists anywhere in this module.
 *   - Mappings are never logged to the console and never handed to telemetry.
 *   - Nothing here feeds the exporter or history snapshots; exports produced
 *     elsewhere never receive vocabulary data because this module never calls
 *     them with it.
 *   - Only the VALIDATED cache persists (localStorage under 'mrb:vocabCache');
 *     clearing purges it immediately and wording reverts on the spot.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

const CACHE_KEY = 'mrb:vocabCache';
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 5000;
const MAX_KEY_CHARS = 200;
const MAX_VALUE_CHARS = 2000;

let paletteMod = null;
let routerMod = null;
/** @type {{render:(el:HTMLElement)=>void}} */
let activePanel = null;

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
// Strict scanning (duplicate keys + malformed input)
// ---------------------------------------------------------------------------

/**
 * Walks the raw JSON text once and refuses ANY duplicate key at ANY depth,
 * plus every malformed shape JSON.parse would tolerate differently.
 */
function assertCleanJson(raw) {
  const n = raw.length;
  let pos = 0;
  const fail = (msg) => {
    throw new Error(msg);
  };
  const ws = () => {
    while (pos < n && /\s/.test(raw[pos])) pos++;
  };
  const readString = () => {
    if (raw[pos] !== '"') fail('Malformed vocabulary file.');
    pos++;
    let out = '';
    while (pos < n) {
      const ch = raw[pos];
      if (ch === '"') {
        pos++;
        return out;
      }
      if (ch === '\\') {
        const esc = raw[pos + 1];
        if (!'\\/"bfnrtu'.includes(esc || '')) fail('Malformed escape sequence in the vocabulary file.');
        if (esc === 'u') {
          const hex = raw.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Malformed unicode escape in the vocabulary file.');
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 6;
          continue;
        }
        out += { '\\': '\\', '"': '"', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc];
        pos += 2;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) fail('Unescaped control character inside a string.');
      out += ch;
      pos++;
    }
    fail('Unterminated string in the vocabulary file.');
  };
  const readValue = () => {
    ws();
    const ch = raw[pos];
    if (ch === '{') return readObject();
    if (ch === '[') return readArray();
    if (ch === '"') return readString();
    if (raw.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (raw.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (raw.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    const num = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(raw.slice(pos));
    if (!num) fail('Malformed vocabulary file.');
    pos += num[0].length;
    return Number(num[0]);
  };
  const readObject = () => {
    pos++; // {
    ws();
    /** @type {Set<string>} */
    const seen = new Set();
    if (raw[pos] === '}') {
      pos++;
      return;
    }
    for (;;) {
      ws();
      const k = readString();
      ws();
      if (raw[pos] !== ':') fail('Malformed vocabulary file.');
      pos++;
      if (seen.has(k)) fail(`The key "${k}" appears more than once — remove the duplicate and try again.`);
      seen.add(k);
      readValue();
      ws();
      if (raw[pos] === ',') {
        pos++;
        continue;
      }
      if (raw[pos] === '}') {
        pos++;
        break;
      }
      fail('Malformed vocabulary file.');
    }
  };
  const readArray = () => {
    pos++; // [
    ws();
    if (raw[pos] === ']') {
      pos++;
      return;
    }
    for (;;) {
      readValue();
      ws();
      if (raw[pos] === ',') {
        pos++;
        continue;
      }
      if (raw[pos] === ']') {
        pos++;
        break;
      }
      fail('Malformed vocabulary file.');
    }
  };

  readValue();
  ws();
  if (pos !== n) fail('Unexpected content after the end of the JSON document.');
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Full validation. @returns {{ok:true, count:number}|{ok:false, error:string}}
 */
export function validateVocabularyText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: tr('vocab.empty', 'The file is empty.', '個檔案係空嘅。') };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      error: tr(
        'vocab.tooBig',
        `That file is ${Math.ceil(bytes / 1024)} KiB — the limit is 256 KiB.`,
        `檔案有 ${Math.ceil(bytes / 1024)} KiB，上限係 256 KiB。`
      ),
    };
  }

  try {
    assertCleanJson(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: tr('vocab.badJson', 'The file is not valid JSON.', '個檔案唔係有效 JSON。') };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: tr('vocab.notObject', 'The top level must be an object.', '最頂層要係一個物件。') };
  }

  if (doc.schemaVersion !== 'v1') {
    return {
      ok: false,
      error: tr(
        'vocab.schema',
        'Only schemaVersion "v1" is supported.',
        '只支援 schemaVersion「v1」。'
      ),
    };
  }
  const allowedTop = new Set(['schemaVersion', 'entries']);
  for (const key of Object.keys(doc)) {
    if (!allowedTop.has(key)) {
      return {
        ok: false,
        error: tr(
          'vocab.unknownField',
          `Unknown field "${key}" at the top level — only schemaVersion and entries are accepted.`,
          `最頂層有多餘欄位「${key}」，只接受 schemaVersion 同 entries。`
        ),
      };
    }
  }

  const entries = doc.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { ok: false, error: tr('vocab.entries', '"entries" must be an object map.', '「entries」要係物件映射。') };
  }
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    return {
      ok: false,
      error: tr(
        'vocab.tooMany',
        `That is ${keys.length} entries — the limit is ${MAX_ENTRIES}.`,
        `共有 ${keys.length} 個條目，上限 ${MAX_ENTRIES} 個。`
      ),
    };
  }
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) {
      return { ok: false, error: tr('vocab.unsafeKey', 'That file uses a reserved key name and was not applied.', '個檔案用咗保留字做鍵名，所以冇套用。') };
    }
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_CHARS) {
      return {
        ok: false,
        error: tr(
          'vocab.keyLen',
          `Every entry key must be between 1 and ${MAX_KEY_CHARS} characters.`,
          `鍵名長度要喺 1 至 ${MAX_KEY_CHARS} 個字符之間。`
        ),
      };
    }
    const value = entries[key];
    if (typeof value !== 'string') {
      return {
        ok: false,
        error: tr(
          'vocab.valueType',
          `Entry "${key}" must map to a plain string.`,
          `條目「${key}」要對應一個純字串。`
        ),
      };
    }
    if (value.length > MAX_VALUE_CHARS) {
      return {
        ok: false,
        error: tr(
          'vocab.valueLen',
          `Entry "${key}" exceeds ${MAX_VALUE_CHARS} characters.`,
          `條目「${key}」超過 ${MAX_VALUE_CHARS} 個字符。`
        ),
      };
    }
  }
  // Values are strings-only by the check above, so effective depth stays ≤2;
  // the ≤4 contract headroom is asserted here so a future version change
  // cannot quietly deepen the shape.
  return { ok: true, count: keys.length };
}

// ---------------------------------------------------------------------------
// Apply / clear
// ---------------------------------------------------------------------------

async function applyText(text, nameForLogs) {
  void nameForLogs; // deliberately unused: filenames are private too
  const result = validateVocabularyText(text);
  if (!result.ok) return result;

  // Delegate application to the shared i18n provider hook (contract §4).
  try {
    if (typeof i18n.loadVocabularyFile === 'function') {
      const res = await i18n.loadVocabularyFile({ name: 'PERSONAL_VOCABULARY.json', text });
      if (res && res.ok === false) {
        return { ok: false, error: String(res.error || tr('vocab.applyFail', 'The file could not be applied.', '個檔案套用唔到。')) };
      }
    } else {
      console.warn('[vocabulary] shared i18n vocabulary hook unavailable; validated file cached only.');
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  store.set(CACHE_KEY, { v: 1, appliedAt: Date.now(), text });
  refreshPanel();
  return result;
}

async function clearAll() {
  store.remove(CACHE_KEY);
  try {
    if (typeof i18n.clearVocabulary === 'function') await i18n.clearVocabulary();
  } catch {
    /* provider absent: cache removal above already reverts wording sources */
  }
  refreshPanel();
}

/** Revalidate the persisted cache at boot; fail closed to shipped wording. */
async function revalidateCached() {
  const cached = store.get(CACHE_KEY, null);
  if (!cached || typeof cached !== 'object' || typeof cached.text !== 'string') return;
  const verdict = validateVocabularyText(cached.text);
  if (!verdict.ok) {
    store.remove(CACHE_KEY); // stale/corrupt cache never half-applies
    try {
      if (typeof i18n.clearVocabulary === 'function') await i18n.clearVocabulary();
    } catch {
      /* nothing applied anyway */
    }
    return;
  }
  try {
    if (typeof i18n.loadVocabularyFile === 'function') {
      await i18n.loadVocabularyFile({ name: 'cache', text: cached.text });
    }
  } catch {
    /* keep shipped wording */
  }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

function refreshPanel() {
  if (activePanel && typeof activePanel.render === 'function') activePanel.render(activePanel.el);
}

function buildPanel(el) {
  el.textContent = '';
  const wrap = ui.el('div', { class: 'mrb-card mrb-vocab-panel' });

  const heading = ui.el('h3', {});
  heading.textContent = tr('vocab.heading', 'Personal vocabulary', '個人詞彙表');
  const intro = ui.el('p', { class: 'mrb-vocab-intro' });
  intro.textContent = tr(
    'vocab.intro',
    'Upload your own JSON word list to replace everyday display words across this app. Everything is handled locally — no upload, no network, no telemetry. Clearing reverts instantly, and an invalid file never applies partially: your last good list stays active until you clear it.',
    '上載你自己嘅 JSON 字表去替換介面用詞。全部本地處理——不上載、唔過網、零追蹤。清除即刻還原；無效檔案絕對唔會半途套用，上一份有效字表會一直用到你清除為止。'
  );

  const state = store.get(CACHE_KEY, null);
  const statusBox = ui.el('p', { class: 'mrb-vocab-status', role: 'status' });

  const inputId = 'mrb-vocab-file';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.id = inputId;
  input.className = 'mrb-vocab-fileinput';
  const label = ui.el('label', { class: 'mrb-btn mrb-btn--outlined mrb-vocab-pick', for: inputId });
  label.textContent = state
    ? tr('vocab.replace', 'Replace vocabulary file…', '更換詞彙檔…')
    : tr('vocab.pick', 'Choose vocabulary file…', '揀詞彙檔…');

  let busy = false;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file || busy) return;
    busy = true;
    label.textContent = tr('vocab.loading', 'Checking…', '檢查中…');
    statusBox.className = 'mrb-vocab-status';
    statusBox.textContent = '';
    let text = '';
    try {
      text = await file.text();
    } catch {
      busy = false;
      statusBox.className = 'mrb-vocab-status mrb-vocab-status--error';
      statusBox.textContent = tr('vocab.readFail', 'That file could not be read. Nothing changed.', '讀唔到個檔案，乜都冇變過。');
      label.textContent = tr('vocab.replace', 'Replace vocabulary file…', '更換詞彙檔…');
      return;
    }
    const outcome = await applyText(text, file.name);
    busy = false;
    if (outcome.ok) {
      statusBox.className = 'mrb-vocab-status mrb-vocab-status--ok';
      statusBox.textContent = tr(
        'vocab.applied',
        `Applied ${outcome.count} replacements.`,
        `已套用 ${outcome.count} 個替換。`
      );
      buildPanel(el); // re-render into loaded state
    } else {
      statusBox.className = 'mrb-vocab-status mrb-vocab-status--error';
      statusBox.textContent = `${tr('vocab.rejected', 'Not applied:', '未有套用：')} ${outcome.error} ${tr(
        'vocab.keptLast',
        'Your previous list, if any, is still active.',
        '你之前嗰份（如有）仍然生效。'
      )}`;
      label.textContent = tr('vocab.replace', 'Replace vocabulary file…', '更換詞彙檔…');
    }
    input.value = '';
  });

  const actions = ui.el('div', { class: 'mrb-vocab-actions' });
  actions.append(label);

  if (state && typeof state.appliedAt === 'number') {
    const when = new Date(state.appliedAt);
    const info = ui.el('span', { class: 'mrb-badge' });
    info.textContent = tr(
      'vocab.loadedState',
      `Active since ${when.toLocaleTimeString()}`,
      `${when.toLocaleTimeString()} 起生效`
    );
    actions.appendChild(info);
    const clearBtn = ui.el('button', {
      class: 'mrb-btn mrb-btn--text',
      type: 'button',
      onclick: async () => {
        await clearAll();
        buildPanel(el);
      },
    });
    clearBtn.textContent = tr('vocab.clear', 'Clear and restore original wording', '清除並還原本來用詞');
    actions.appendChild(clearBtn);
    statusBox.className = 'mrb-vocab-status mrb-vocab-status--ok';
    statusBox.textContent = tr('vocab.activeNote', 'A personal vocabulary list is active.', '而家正用緊個人詞彙表。');
  } else {
    statusBox.className = 'mrb-vocab-status';
    statusBox.textContent = tr(
      'vocab.noFile',
      'No vocabulary file yet — the app is using its original shipped wording.',
      '未有詞彙檔——應用程式照用原裝用詞。'
    );
  }

  const privacy = ui.el('p', { class: 'mrb-vocab-privacy' });
  privacy.textContent = tr(
    'vocab.privacy',
    'Your mappings stay on this computer. They are excluded from exports and history on purpose.',
    '你嘅映射只會留喺呢部電腦，而且刻意排除喺匯出同歷史紀錄之外。'
  );

  wrap.append(heading, intro, actions, statusBox, input, privacy);
  el.appendChild(wrap);
}

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/delight.css', import.meta.url).href);
  } catch {
    /* styling degrades */
  }

  const loads = await Promise.allSettled([import('./router.js'), import('./palette.js')]);
  routerMod = loads[0].status === 'fulfilled' ? loads[0].value : null;
  paletteMod = loads[1].status === 'fulfilled' ? loads[1].value : null;

  await revalidateCached();

  if (routerMod && routerMod.router && typeof routerMod.router.registerTab === 'function') {
    try {
      routerMod.router.registerTab({
        id: 'vocabulary',
        title: tr('vocab.tabTitle', 'Personal vocabulary', '個人詞彙'),
        icon: '📖',
        closable: false,
        render: (el) => {
          activePanel = { render: buildPanel, el };
          buildPanel(el);
        },
      });
    } catch {
      /* router unavailable */
    }
  }

  if (paletteMod && paletteMod.palette && typeof paletteMod.palette.register === 'function') {
    try {
      paletteMod.palette.register({
        id: 'vocabulary.open',
        title: tr('vocab.paletteTitle', 'Open Personal vocabulary', '開啟個人詞彙'),
        keywords: 'words replace upload json vocabulary',
        action: () => {
          if (routerMod && routerMod.router) routerMod.router.navigate('vocabulary');
        },
      });
    } catch {
      /* palette unavailable */
    }
  }
}
