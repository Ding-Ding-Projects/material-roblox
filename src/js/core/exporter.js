/**
 * Material Roblox — universal export (Lane C).
 *
 * One dialog, every coding-friendly format: JSON, JSONL/NDJSON, YAML, TOML,
 * XML, CSV, TSV, Markdown, HTML, SQL and ZIP. Each format states up front
 * whether it round-trips and exactly what a lossy conversion drops — the
 * disclosure happens BEFORE the user commits, never silently afterwards.
 *
 * Files are written through the sanctioned main-process route
 * (`dialog:save` → `export:write`, bounded at 64 MiB per CONTRACT §3) with
 * UTF-8 (no BOM) encoding and an explicit line-endings choice (LF/CRLF,
 * persisted). After a successful write the dialog offers "Open in Visual
 * Studio Code" (graceful honest fallback when VS Code is absent) and
 * "Reveal in folder".
 *
 * The TOML writer implements a documented subset: strings, numbers,
 * booleans, ISO-string dates, nested tables, arrays of scalars and arrays of
 * tables. `null` values are omitted (TOML has no null) and that rule is
 * stated in the emitted header comment and in the dialog disclosure.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

/* ── Bounds & prefs ─────────────────────────────────────────────────────── */

const MAX_EXPORT_BYTES = 64 * 1024 * 1024; // matches the export:write IPC bound

function getEolPref() {
  return store.get('exportEol', 'lf') === 'crlf' ? 'crlf' : 'lf';
}
function setEolPref(v) {
  store.set('exportEol', v === 'crlf' ? 'crlf' : 'lf');
}
function getZipLevelPref() {
  const n = Number(store.get('exportZipLevel', 6));
  return Number.isFinite(n) ? Math.min(9, Math.max(0, Math.round(n))) : 6;
}

/* ── Localized copy helpers (CONTRACT §8 fallback pattern) ──────────────── */

function tr(key, en, yue) {
  let translated = null;
  let mode = 'en';
  try {
    const v = i18n.t(key);
    if (v && v !== key) translated = v;
    if (typeof i18n.lang === 'function') mode = i18n.lang();
  } catch { /* catalogs unavailable — local copy stands */ }
  const primary = translated || en;
  if (mode === 'bi' && yue && yue !== primary) return `${primary} · ${yue}`;
  return primary;
}

function bridge() {
  return typeof window !== 'undefined' && window.mrb ? window.mrb : null;
}

async function invoke(channel, payload) {
  const b = bridge();
  if (!b || typeof b.invoke !== 'function') throw new Error(tr('exp.noBridge', 'The desktop bridge is unavailable, so files cannot be saved right now.', '目前攞唔到桌面橋接，暫時儲存唔到檔案。'));
  return b.invoke(channel, payload);
}

/* ── Value helpers ──────────────────────────────────────────────────────── */

/** Flatten nested objects to dot-path keys for tabular formats. */
export function flattenObject(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenObject(v, key, out);
    else out[key] = v;
  }
  return out;
}

/** Normalise {data|rows} into {data, rows|null}. */
function normalizePayload(opts) {
  let rows = null;
  let data = undefined;
  if (opts && Array.isArray(opts.rows)) rows = opts.rows;
  else if (opts && opts.data !== undefined) data = opts.data;
  else if (Array.isArray(opts)) rows = opts;

  if (!rows && data !== undefined) {
    if (Array.isArray(data)) rows = data;
    else if (data && typeof data === 'object') rows = [data];
  }
  return { data: data !== undefined ? data : (opts && opts.data), rows };
}

/** Column union across rows, first-seen order preserved. */
export function columnsOf(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) {
    const flat = r && typeof r === 'object' && !Array.isArray(r) ? flattenObject(r) : { value: r };
    for (const k of Object.keys(flat)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

function cellValue(row, col) {
  const flat = row && typeof row === 'object' && !Array.isArray(row) ? flattenObject(row) : { value: row };
  return flat[col];
}

/* ── Format builders ────────────────────────────────────────────────────── */

const EOL = { lf: '\n', crlf: '\r\n' };

function csvField(v, sep) {
  const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (s.includes('"') || s.includes(sep) || /[\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildDelimited(rows, sep, eol) {
  const cols = columnsOf(rows);
  const head = cols.map((c) => csvField(c, sep)).join(sep);
  const body = rows.map((r) => cols.map((c) => csvField(cellValue(r, c), sep)).join(sep));
  return [head, ...body].join(eol) + eol;
}

/* TOML subset writer — see the module header for the supported grammar. */
function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${String(k).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\b/g, '\\b').replace(/\t/g, '\\t').replace(/\n/g, '\\n')
    .replace(/\f/g, '\\f').replace(/\r/g, '\\r')}"`;
}
function tomlScalar(v) {
  if (v == null) return '';
  switch (typeof v) {
    case 'string': return v instanceof Date ? tomlString(v.toISOString()) : tomlString(v);
    case 'number': return Number.isFinite(v) ? String(v) : tomlString(String(v));
    case 'boolean': return v ? 'true' : 'false';
    default: return tomlString(JSON.stringify(v));
  }
}
function tomlInline(arr) {
  return `[${arr.map((v) => (v !== null && typeof v === 'object' ? tomlString(JSON.stringify(v)) : tomlScalar(v))).join(', ')}]`;
}
function tomlEmit(lines, obj, path) {
  const tables = [];
  const arrTables = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue; // TOML has no null — omitted, disclosed
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x !== null && typeof x === 'object')) arrTables.push([k, v]);
      else lines.push(`${tomlKey(k)} = ${tomlInline(v)}`);
    } else if (typeof v === 'object') {
      tables.push([k, v]);
    } else {
      lines.push(`${tomlKey(k)} = ${tomlScalar(v)}`);
    }
  }
  for (const [k, v] of tables) {
    lines.push('');
    lines.push(`[${[...path, k].map(tomlKey).join('.')}]`);
    tomlEmit(lines, v, [...path, k]);
  }
  for (const [k, arr] of arrTables) {
    for (const item of arr) {
      lines.push('');
      lines.push(`[[${[...path, k].map(tomlKey).join('.')}]]`);
      tomlEmit(lines, item, [...path, k]);
    }
  }
}
function buildToml(data) {
  const header = '# Material Roblox TOML export — subset: strings, numbers, booleans, ISO date strings,';
  const header2 = '# nested tables, arrays of scalars, arrays of tables. null values are omitted.';
  const lines = [header, header2];
  if (Array.isArray(data)) {
    // An array at the root becomes an array of tables named "item".
    for (const item of data) {
      lines.push('');
      lines.push('[[item]]');
      tomlEmit(lines, item && typeof item === 'object' ? item : { value: item }, ['item']);
    }
  } else if (data && typeof data === 'object') {
    tomlEmit(lines, data, []);
  } else {
    lines.push(`value = ${tomlScalar(data)}`);
  }
  return lines.join('\n') + '\n';
}

/* XML builder — attributes via the {_attributes:{…}} convention, text via {_text}. */
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlAttrEsc(s) {
  return xmlEsc(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlTagSafe(name) {
  const t = String(name).replace(/[^\w.-]/g, '_');
  return /^[A-Za-z_]/.test(t) ? t : `_${t}`;
}
function xmlNode(lines, tag, value, depth) {
  const pad = '  '.repeat(depth);
  if (value === null || value === undefined) { lines.push(`${pad}<${tag}/>`); return; }
  if (Array.isArray(value)) {
    lines.push(`${pad}<${tag}>`);
    for (const item of value) xmlNode(lines, 'item', item, depth + 1);
    lines.push(`${pad}</${tag}>`);
    return;
  }
  if (typeof value === 'object') {
    const attrs = value._attributes && typeof value._attributes === 'object'
      ? Object.entries(value._attributes).map(([k, v]) => ` ${xmlTagSafe(k)}="${xmlAttrEsc(v ?? '')}"`).join('')
      : '';
    if (Object.prototype.hasOwnProperty.call(value, '_text')) {
      lines.push(`${pad}<${tag}${attrs}>${xmlEsc(value._text)}</${tag}>`);
      return;
    }
    const kids = Object.entries(value).filter(([k]) => k !== '_attributes');
    if (!kids.length) { lines.push(`${pad}<${tag}${attrs}/>`); return; }
    lines.push(`${pad}<${tag}${attrs}>`);
    for (const [k, v] of kids) xmlNode(lines, xmlTagSafe(k), v, depth + 1);
    lines.push(`${pad}</${tag}>`);
    return;
  }
  lines.push(`${pad}<${tag}>${xmlEsc(value)}</${tag}>`);
}
function buildXml(name, data) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  xmlNode(lines, xmlTagSafe(name || 'root'), data, 0);
  return lines.join('\n') + '\n';
}

/* SQL (SQLite dialect) — inferred CREATE TABLE + INSERTs. */
function sqlIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0'; // SQLite stores booleans as integers
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlType(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) return 'TEXT';
  if (present.every((v) => typeof v === 'number' && Number.isInteger(v))) return 'INTEGER';
  if (present.every((v) => typeof v === 'number')) return 'REAL';
  return 'TEXT';
}
function buildSql(name, rows, eol) {
  const tableName = sqlIdent(name || 'export');
  const cols = columnsOf(rows);
  const colTypes = cols.map((c) => sqlType(rows.map((r) => cellValue(r, c))));
  const lines = [
    '-- Dialect: SQLite. Generated by Material Roblox.',
    '-- Nested structures are flattened to dot-path columns; booleans become 1/0;',
    '-- complex values are stored as JSON text. This is an export, not an import path.',
    '',
    `CREATE TABLE IF NOT EXISTS ${tableName} (` +
      cols.map((c, i) => `${sqlIdent(c)} ${colTypes[i]}`).join(', ') + ');',
    '',
  ];
  for (const r of rows) {
    const vals = cols.map((c) => sqlLiteral(cellValue(r, c)));
    lines.push(`INSERT INTO ${tableName} (${cols.map(sqlIdent).join(', ')}) VALUES (${vals.join(', ')});`);
  }
  return lines.join(eol) + eol;
}

function buildMarkdown(name, rows, data, eol) {
  if (rows) {
    const cols = columnsOf(rows);
    const escCell = (v) => {
      const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return s.replace(/\|/g, '\\|').replace(/(\r?\n)+/g, ' ');
    };
    const lines = [
      `# ${name}`,
      '',
      `<!-- Markdown export: data types are lost; complex values appear as JSON text. -->`,
      '',
      `| ${cols.map(escCell).join(' | ')} |`,
      `| ${cols.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${cols.map((c) => escCell(cellValue(r, c))).join(' | ')} |`),
    ];
    return lines.join(eol) + eol;
  }
  return [
    `# ${name}`,
    '',
    '<!-- Markdown export: non-tabular payloads are embedded as a fenced JSON block. -->',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
  ].join(eol);
}

function buildHtml(name, rows, data) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = rows
    ? (() => {
        const cols = columnsOf(rows);
        const cell = (v) => `<td>${esc(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)))}</td>`;
        return `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${cols.map((c) => cell(cellValue(r, c))).join('')}</tr>`).join('') +
          '</tbody></table>';
      })()
    : `<pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${esc(name)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}',
    'table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:.35rem .6rem;text-align:left}',
    'th{background:#f2f2f2}</style></head><body>',
    `<h1>${esc(name)}</h1>`,
    '<!-- HTML export: presentation snapshot, not machine-round-trippable. -->',
    body,
    '</body></html>',
    '',
  ].join('\n');
}

/* ZIP container via fflate (dynamic peer dependency). */
async function buildZip(files, level) {
  const fflate = await import('fflate').catch(() => null);
  if (!fflate || typeof fflate.zipSync !== 'function' || typeof fflate.strToU8 !== 'function') {
    throw new Error(tr('exp.zipDep', 'ZIP support needs the bundled fflate library, which failed to load.', 'ZIP 功能需要內置嘅 fflate 程式庫，但載入失敗。'));
  }
  const enc = {};
  for (const f of files) {
    enc[f.name] = typeof f.bytes === 'string' ? fflate.strToU8(f.bytes) : f.bytes;
  }
  return fflate.zipSync(enc, { level });
}

/* ── Format registry ────────────────────────────────────────────────────── */

/**
 * Round-trip statements are shown verbatim in the dialog:
 *  - rt:true            → "Round-trippable back to equivalent data."
 *  - otherwise          → the format's own export-only caveat.
 */
export const FORMATS = {
  json: {
    ext: 'json', mime: 'application/json', tabular: false, roundTrip: true,
    build: ({ data }, o) => JSON.stringify(data, null, 2) + EOL[o.eol],
  },
  jsonl: {
    ext: 'jsonl', mime: 'application/x-ndjson', tabular: true, roundTrip: false,
    noteEn: 'One record per line; a top-level object exports as that single line.',
    noteYue: '一行一筆紀錄；頂層物件會變成單獨一行。',
    build: ({ rows, data }, o) => {
      const src = rows || [data];
      return src.map((r) => JSON.stringify(r)).join(o.eol) + o.eol;
    },
  },
  yaml: {
    ext: 'yaml', mime: 'text/yaml', tabular: false, roundTrip: true,
    build: async ({ data }) => {
      const mod = await import('yaml').catch(() => null);
      if (!mod || typeof mod.stringify !== 'function') {
        throw new Error(tr('exp.yamlDep', 'YAML support needs the bundled yaml library, which failed to load.', 'YAML 功能需要內置嘅 yaml 程式庫，但載入失敗。'));
      }
      return mod.stringify(data);
    },
  },
  toml: {
    ext: 'toml', mime: 'text/plain', tabular: false, roundTrip: true,
    noteEn: 'Documented subset; null values are omitted because TOML has none.',
    noteYue: '只支援已記錄嘅子集；TOML 冇 null，所以會略過。',
    build: ({ data }) => buildToml(data),
  },
  xml: {
    ext: 'xml', mime: 'application/xml', tabular: false, roundTrip: false,
    noteEn: 'Everything becomes text; attribute/text conventions are documented in the file.',
    noteYue: '所有值都會變文字；屬性同文字約定已寫喺檔案入面。',
    build: ({ data }, o) => buildXml(o.name, data),
  },
  csv: {
    ext: 'csv', mime: 'text/csv', tabular: true, roundTrip: false,
    noteEn: 'Flattens nesting with dot paths; nested values become JSON text; types are lost.',
    noteYue: '用點路徑攤平巢狀結構；複雜值變 JSON 文字；類型資料會失去。',
    build: ({ rows }, o) => buildDelimited(rows, ',', o.eol),
  },
  tsv: {
    ext: 'tsv', mime: 'text/tab-separated-values', tabular: true, roundTrip: false,
    noteEn: 'Same flattening as CSV, tab-separated.',
    noteYue: '同 CSV 一樣攤平，但以 Tab 分隔。',
    build: ({ rows }, o) => buildDelimited(rows, '\t', o.eol),
  },
  md: {
    ext: 'md', mime: 'text/markdown', tabular: true, roundTrip: false,
    noteEn: 'Markdown loses data types; complex values appear as JSON text.',
    noteYue: 'Markdown 會失去資料類型；複雜值會顯示成 JSON 文字。',
    build: ({ rows, data }, o) => buildMarkdown(o.name, rows, data, o.eol),
  },
  html: {
    ext: 'html', mime: 'text/html', tabular: true, roundTrip: false,
    noteEn: 'A presentation snapshot — readable, but not meant for machine import.',
    noteYue: '係畀人睇嘅快照——易讀，但唔係畀機械輸入用。',
    build: ({ rows, data }, o) => buildHtml(o.name, rows, data),
  },
  sql: {
    ext: 'sql', mime: 'application/sql', tabular: true, roundTrip: false,
    noteEn: 'SQLite dialect; flattening + boolean-as-integer rules stated in the file.',
    noteYue: 'SQLite 方言；攤平同布爾轉整數規則已寫喺檔案入面。',
    build: ({ rows }, o) => buildSql(o.name, rows, o.eol),
  },
  zip: {
    ext: 'zip', mime: 'application/zip', tabular: false, roundTrip: true, binary: true,
    noteEn: 'A container around the exported files plus a manifest.txt; contents preserved exactly.',
    noteYue: '包住導出檔案再加 manifest.txt；內容原封不動。',
  },
};

/**
 * Build one format's content.
 * @returns {Promise<{content:(string|Uint8Array), binary:boolean, ext:string, mime:string}>}
 */
export async function buildFormat(formatId, payload, opt) {
  const def = FORMATS[formatId];
  if (!def) throw new Error(tr('exp.unknownFmt', `Unknown export format: ${formatId}`, `唔明嘅導出格式：${formatId}`));
  const o = { name: opt.name, eol: opt.eol || 'lf' };
  const content = await def.build(payload, o);
  return { content, binary: !!def.binary, ext: def.ext, mime: def.mime };
}

/* ── Encoding & persistence ─────────────────────────────────────────────── */

/** Chunked base64 (btoa chokes on large single calls; chunks stay small). */
export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function strToBytes(s) {
  return new TextEncoder().encode(s);
}

async function writeViaDialog(defaultName, filters, bytes) {
  if (bytes.length > MAX_EXPORT_BYTES) {
    throw new Error(tr('exp.tooBig',
      `Export is ${(bytes.length / 1048576).toFixed(1)} MiB; the limit is ${MAX_EXPORT_BYTES / 1048576} MiB. Split the data or choose ZIP.`,
      `導出有 ${(bytes.length / 1048576).toFixed(1)} MiB；上限係 ${MAX_EXPORT_BYTES / 1048576} MiB。請拆細啲或者改用 ZIP。`));
  }
  const path = await invoke('dialog:save', { defaultName, filters });
  if (!path) return null; // user cancelled — not an error
  const res = await invoke('export:write', { path, dataB64: bytesToBase64(bytes) });
  if (!res || res.ok === false) {
    throw new Error((res && res.error) || tr('exp.writeFail', 'The file could not be written.', '寫入檔案失敗。'));
  }
  return { path, bytes: res.bytes != null ? res.bytes : bytes.length };
}

async function openInVsCode(path) {
  try {
    const res = await invoke('vscode:open', { path });
    if (res && res.ok === false) throw new Error(res.error || 'not installed');
  } catch {
    ui.toast({
      title: tr('exp.vscodeMissing', 'Visual Studio Code not detected', '偵測唔到 Visual Studio Code'),
      body: tr('exp.vscodeHint',
        'The exported file is saved and ready. Install VS Code to open exports straight from here.',
        '檔案已經儲存好。裝咗 VS Code 就可以直接喺呢度打開導出檔。'),
      tone: 'info',
      timeoutMs: 8000,
      actions: [{
        label: tr('exp.vscodeDownload', 'Download VS Code', '下載 VS Code'),
        run: () => { invoke('shell:openExternal', { url: 'https://code.visualstudio.com/download' }).catch(() => { }); },
      }],
    });
  }
}

function successToast(path, byteCount, filename) {
  ui.toast({
    title: tr('exp.saved', 'Export saved', '已匯出'),
    body: voiceOk(`${filename} · ${ui.fmtBytes ? ui.fmtBytes(byteCount) : `${byteCount} bytes`} · UTF-8 (no BOM)`),
    tone: 'ok',
    timeoutMs: 9000,
    actions: [
      { label: tr('exp.openVsCode', 'Open in VS Code', '喺 VS Code 開啟'), run: () => openInVsCode(path) },
      { label: tr('exp.reveal', 'Reveal in folder', '喺資料夾顯示'), run: () => invoke('shell:showItemInFolder', { path }).catch(() => { }) },
    ],
  });
}

function voiceOk(text) {
  try {
    const v = i18n.voice('ok', text);
    if (typeof v === 'string' && v) return v;
  } catch { /* facts stay exact */ }
  return text;
}

/* ── Dialog ─────────────────────────────────────────────────────────────── */

/**
 * Export dialog over every requested format.
 *
 * @param {{name:string, data?:any, rows?:any[], formats?:string[],
 *           chosenDefault?:string, extraNote?:string}} opts
 * @returns {Promise<{ok:boolean, path?:string|null, error?:string}>}
 */
export async function exportData(opts) {
  const name = (opts && opts.name) || 'export';
  const { data, rows } = normalizePayload(opts || {});
  const wanted = (opts && Array.isArray(opts.formats) && opts.formats.length
    ? opts.formats : Object.keys(FORMATS)).filter((id) => FORMATS[id]);

  let eol = getEolPref();
  let zipLevel = getZipLevelPref();
  let chosen = (opts && opts.chosenDefault && FORMATS[opts.chosenDefault]) ? opts.chosenDefault : wanted[0];

  return new Promise((resolve) => {
    let closeModal = () => {};
    let sizeLine;
    let fileLine;
    let zipRow;

    const radios = [];
    const cardWrap = ui.el('div', { class: 'mrb-cx-fmtcards', role: 'radiogroup', 'aria-label': tr('exp.format', 'Export format', '導出格式') });

    function describe(def) {
      const rt = def.roundTrip
        ? tr('exp.roundtrip', 'Round-trippable back to equivalent data.', '可以完整往返還原資料。')
        : tr('exp.exportOnly', 'Export-only — not intended for importing back.', '僅供導出——預期唔會倒灌返嚟。');
      const lossy = def.noteEn ? tr(`exp.note.${def.ext}`, def.noteEn, def.noteYue) : null;
      return { rt, lossy };
    }

    for (const id of wanted) {
      const def = FORMATS[id];
      const { rt, lossy } = describe(def);
      const input = ui.el('input', { type: 'radio', name: 'mrb-cx-fmt', value: id });
      input.checked = id === chosen;
      input.addEventListener('change', () => {
        chosen = id;
        refreshDerived();
      });
      const title = ui.el('span', { class: 'mrb-cx-fmt-title' }, `${id.toUpperCase()} `);
      const extBadge = ui.el('code', { class: 'mrb-badge mrb-cx-fmt-ext' }, `.${def.ext}`);
      const bodyKids = [
        ui.el('span', { class: 'mrb-cx-fmt-head' }, title, extBadge),
        ui.el('span', { class: 'mrb-cx-fmt-line' }, rt),
      ];
      if (lossy) bodyKids.push(ui.el('span', { class: 'mrb-cx-fmt-lossy' }, lossy));
      const card = ui.el('label', { class: 'mrb-cx-fmtcard' }, input,
        ui.el('span', { class: 'mrb-cx-fmt-body' }, ...bodyKids));
      radios.push(input);
      cardWrap.appendChild(card);
    }

    const eolSelect = ui.el('select', { class: 'mrb-select', 'aria-label': tr('exp.eol', 'Line endings', '換行格式') },
      ui.el('option', { value: 'lf' }, tr('exp.eolLf', 'LF (\\n)', 'LF (\\n)')),
      ui.el('option', { value: 'crlf' }, tr('exp.eolCrlf', 'CRLF (\\r\\n)', 'CRLF (\\r\\n)')));
    eolSelect.value = eol;
    eolSelect.addEventListener('change', () => { eol = eolSelect.value; });

    const zipSlider = ui.el('input', { type: 'range', min: '0', max: '9', step: '1', 'aria-label': tr('exp.ziplvl', 'ZIP compression level', 'ZIP 壓縮等級') });
    zipSlider.value = String(zipLevel);
    const zipVal = ui.el('span', { class: 'mrb-cx-zipval' }, String(zipLevel));
    zipSlider.addEventListener('input', () => { zipLevel = Number(zipSlider.value); zipVal.textContent = String(zipLevel); });

    zipRow = ui.el('div', { class: 'mrb-cx-optrow', hidden: chosen !== 'zip' },
      ui.el('label', {}, tr('exp.ziplvl', 'ZIP compression level', 'ZIP 壓縮等級'), zipSlider, zipVal));
    const eolRow = ui.el('div', { class: 'mrb-cx-optrow' },
      ui.el('label', {}, tr('exp.eol', 'Line endings', '換行格式'), eolSelect));

    fileLine = ui.el('p', { class: 'mrb-cx-fileline' });
    sizeLine = ui.el('p', { class: 'mrb-cx-sizeline', 'aria-live': 'polite' });

    function refreshDerived() {
      const def = FORMATS[chosen];
      fileLine.textContent = tr('exp.fileWillBe', 'File:', '檔案：') + ` ${name}.${def.ext}`;
      zipRow.hidden = chosen !== 'zip';
      sizeLine.textContent = tr('exp.sizeAtSave', 'Exact size is checked against the 64 MiB limit when you save.', '儲存時會對照 64 MiB 上限核實實際大小。');
    }

    const errLine = ui.el('p', { class: 'mrb-cx-experr', role: 'alert', hidden: 'true' });

    const saveBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled mrb-cx-expsave', type: 'button' }, tr('exp.save', 'Save…', '儲存…'));
    const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('common.cancel', 'Cancel', '取消'));

    const body = ui.el('div', { class: 'mrb-cx-expbody' });
    const bodyKids = [
      (opts && opts.extraNote) ? ui.el('p', { class: 'mrb-cx-note' }, opts.extraNote) : null,
      ui.el('p', { class: 'mrb-cx-note' },
        tr('exp.encoding', 'Encoding: UTF-8 (no BOM). Line endings are your choice below.', '編碼：UTF-8（冇 BOM）。換行格式喺下面揀。')),
      cardWrap, eolRow, zipRow, fileLine, sizeLine, errLine,
      ui.el('div', { class: 'mrb-cx-expactions' }, saveBtn, cancelBtn),
    ].filter(Boolean);
    body.append(...bodyKids);

    cancelBtn.addEventListener('click', () => { closeModal(); resolve({ ok: false }); });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      errLine.hidden = true;
      try {
        const def = FORMATS[chosen];
        const payload = { data, rows: def.tabular ? (rows || []) : rows };
        const built = await buildFormat(chosen, payload, { name, eol });
        const bytes = built.binary ? built.content : strToBytes(built.content);
        const filters = [{ name: `${chosen.toUpperCase()} (${def.ext})`, extensions: [def.ext] }];
        const result = await writeViaDialog(`${name}.${def.ext}`, filters, bytes);
        if (!result) { resolve({ ok: false }); closeModal(); return; }
        setEolPref(eol);
        if (chosen === 'zip') store.set('exportZipLevel', zipLevel);
        successToast(result.path, result.bytes, `${name}.${def.ext}`);
        resolve({ ok: true, path: result.path });
        closeModal();
      } catch (err) {
        errLine.hidden = false;
        errLine.textContent = (err && err.message) ? String(err.message) : String(err);
        saveBtn.disabled = false;
      }
    });

    refreshDerived();
    closeModal = ui.modal({
      title: tr('exp.title', `Export “${name}”`, `匯出「${name}」`),
      build: (el) => el.appendChild(body),
      actions: [],
    }) || closeModal;
  });
}

/**
 * Batch export: several datasets zipped together with a manifest.txt.
 * @param {{name:string, data?:any, rows?:any[]}[]} items
 */
export async function exportMany(items, zipName = 'material-roblox-export') {
  const used = new Set();
  const files = [];
  const manifestLines = [`Material Roblox batch export — ${items.length} dataset(s).`, 'UTF-8 (no BOM).', ''];
  for (const item of items || []) {
    const base = String(item.name || 'dataset').replace(/[^\w.-]+/g, '_');
    let fname = `${base}.json`;
    let n = 2;
    while (used.has(fname)) fname = `${base}-${n++}.json`;
    used.add(fname);
    const payload = normalizePayload(item);
    const content = JSON.stringify({ name: base, data: payload.data !== undefined ? payload.data : payload.rows }, null, 2);
    files.push({ name: fname, bytes: content });
    manifestLines.push(`${fname} — ${content.length.toLocaleString()} characters`);
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  manifestLines.push('', `Total files: ${files.length}`);
  files.unshift({ name: 'manifest.txt', bytes: manifestLines.join('\n') });
  const level = getZipLevelPref();
  const bytes = await buildZip(files, level);
  const result = await writeViaDialog(
    `${zipName}.zip`,
    [{ name: 'ZIP archive (zip)', extensions: ['zip'] }],
    bytes,
  );
  if (!result) return { ok: false };
  successToast(result.path, result.bytes, `${zipName}.zip`);
  return { ok: true, path: result.path };
}

/**
 * Plain-text save used by peers (history panel redacted exports, etc.) —
 * same dialog/write route, no format chooser.
 */
export async function saveText(filename, content, extLabel = 'Text') {
  const ext = (filename.split('.').pop() || 'txt').toLowerCase();
  const bytes = strToBytes(content);
  const result = await writeViaDialog(filename, [{ name: extLabel, extensions: [ext] }], bytes);
  if (!result) return { ok: false, cancelled: true };
  successToast(result.path, result.bytes, filename);
  return { ok: true, path: result.path };
}

/** Namespaced facade per CONTRACT §6 (`exporter.exportData(...)`). */
export const exporter = { exportData, exportMany, saveText, buildFormat, FORMATS };

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/coreux.css', import.meta.url).href);
  } catch (err) {
    console.warn('[mrb/exporter] stylesheet injection failed:', err && err.message);
  }
}
