/**
 * converter.js — universal local file converter (Lane E).
 *
 * Contract highlights (docs/dev/CONTRACT.md §6 + lane brief):
 *  - ADAPTER REGISTRY below is the single source of truth for categories,
 *    bundled state, and the EXACT reason a format is unavailable. Unavailable
 *    adapters are listed DISABLED, never hidden, never faked.
 *  - Type detection reads MAGIC BYTES (never trusts extensions); an unknown or
 *    mismatched file is refused with a detected-vs-claimed note.
 *  - The queue is unlimited-length (paged directory expansion happens
 *    main-side, bounded depth 8), persisted under `mrb:convertQueue`, resumable
 *    across restarts, concurrency-configurable, with per-file pause/cancel.
 *    Files above 32 MiB are processed through temp paths inside the sandbox
 *    worker rather than buffered wholesale in the page.
 *  - Preflight checks free disk space against estimated outputs and BLOCKS
 *    with an explicit warning until the user confirms. Overwriting an existing
 *    destination goes through ui.superConfirm (or auto-suffix by default).
 *  - Every lossy / metadata-changing conversion shows its disclosure BEFORE
 *    running and requires an explicit Convert click. Image re-encoding through
 *    canvas STRIPS EXIF/metadata — stated up front, not discovered after.
 *  - Writes are atomic (temp + rename with EPERM retry) and every claimed
 *    success is validated by reopening the artifact in the worker.
 *
 * PDF + archive work runs in the UtilityProcess worker (`app/workers/pdf-worker.cjs`).
 * Text/data/image transforms run renderer-side because they need browser
 * codecs; their bytes cross the boundary only through the bounded sandbox
 * read/write primitives.
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';
import { ensureToolsStyles } from './colorpicker.js';

/* ------------------------------------------------------------------ */
/* peers                                                               */
/* ------------------------------------------------------------------ */

const peerCache = new Map();
function peer(name) {
  if (!peerCache.has(name)) peerCache.set(name, import(name).then((m) => m).catch(() => null));
  return peerCache.get(name);
}

let P = { settings: null, router: null, palette: null, exporter: null, regexbuilder: null };

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* English always correct */ }
  return en;
}

function recordChange(label, snapshot) {
  peer('./history.js').then((m) => {
    if (m && m.history && typeof m.history.record === 'function') {
      m.history.record({ kind: 'created', label, snapshot });
    }
  }).catch(() => { /* history optional */ });
}

const invoke = async (channel, payload) => {
  if (!window.mrb || typeof window.mrb.invoke !== 'function') throw new Error('Shell bridge unavailable.');
  return window.mrb.invoke(channel, payload);
};

/* ------------------------------------------------------------------ */
/* Adapter registry                                                    */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} Adapter
 * @property {string} id
 * @property {'Documents'|'Images'|'Audio'|'Video'|'Archives'|'Data'|'CodeText'|'Binary'} category
 * @property {string} label            English name (UI adds Cantonese)
 * @property {boolean} bundled         true = ships inside this installer
 * @property {string} [reason]         exact reason when bundled=false
 * @property {string[]} from           accepted source signatures/extensions
 * @property {string} to               target extension ('' for inspect tools)
 * @property {string[]} losses         disclosed BEFORE the run
 * @property {'text'|'image'|'worker'} engine
 */

/** @type {Adapter[]} */
export const ADAPTERS = [
  /* ---------------- Documents (PDF, bundled pdf-lib in the worker) ------- */
  { id: 'pdf-inspect', category: 'Documents', label: 'PDF — inspect', bundled: true, from: ['pdf'], to: '', engine: 'worker',
    losses: [] },
  { id: 'pdf-split', category: 'Documents', label: 'PDF — split ranges', bundled: true, from: ['pdf'], to: 'zip', engine: 'worker',
    losses: ['Output is a ZIP of one PDF per range'] },
  { id: 'pdf-merge', category: 'Documents', label: 'PDF — merge documents', bundled: true, from: ['pdf'], to: 'pdf', engine: 'worker',
    losses: ['Page-level annotations may be simplified by the merge'] },
  { id: 'pdf-reorder', category: 'Documents', label: 'PDF — reorder pages', bundled: true, from: ['pdf'], to: 'pdf', engine: 'worker',
    losses: [] },
  { id: 'pdf-rotate', category: 'Documents', label: 'PDF — rotate pages', bundled: true, from: ['pdf'], to: 'pdf', engine: 'worker',
    losses: [] },
  { id: 'pdf-extract-pages', category: 'Documents', label: 'PDF — extract pages', bundled: true, from: ['pdf'], to: 'pdf', engine: 'worker',
    losses: [] },
  { id: 'pdf-metadata', category: 'Documents', label: 'PDF — edit metadata', bundled: true, from: ['pdf'], to: 'pdf', engine: 'worker',
    losses: ['Only Title and Author are edited; other fields pass through'] },

  /* ---------------- Data ------------------------------------------------- */
  { id: 'json-to-jsonl', category: 'Data', label: 'JSON → JSONL', bundled: true, from: ['json'], to: 'jsonl', engine: 'text',
    losses: ['Top-level object becomes a single record; arrays become one line each'] },
  { id: 'json-to-yaml', category: 'Data', label: 'JSON → YAML', bundled: true, from: ['json'], to: 'yaml', engine: 'text',
    losses: ['YAML anchors/aliases are emitted as plain values'] },
  { id: 'json-to-toml', category: 'Data', label: 'JSON → TOML', bundled: true, from: ['json'], to: 'toml', engine: 'text',
    losses: ['Subset writer: tables, strings, numbers, booleans, arrays of primitives; mixed-type arrays are stringified'] },
  { id: 'json-to-xml', category: 'Data', label: 'JSON → XML', bundled: true, from: ['json'], to: 'xml', engine: 'text',
    losses: ['Root element <root>; keys become elements, arrays repeat elements'] },
  { id: 'json-to-csv', category: 'Data', label: 'JSON → CSV', bundled: true, from: ['json'], to: 'csv', engine: 'text',
    losses: ['Array of flat objects only; nested values are JSON-stringified into cells; float precision follows JS formatting'] },
  { id: 'json-to-tsv', category: 'Data', label: 'JSON → TSV', bundled: true, from: ['json'], to: 'tsv', engine: 'text',
    losses: ['Same flat-record rule as CSV'] },
  { id: 'json-to-md', category: 'Data', label: 'JSON → Markdown table', bundled: true, from: ['json'], to: 'md', engine: 'text',
    losses: ['Array-of-records renders as a table; other shapes render as JSON code fence'] },
  { id: 'json-to-html', category: 'Data', label: 'Markdown/JSON → HTML', bundled: true, from: ['json', 'md'], to: 'html', engine: 'text',
    losses: ['Fonts/layout reflow in the browser; markdown subset rendered (headings, lists, fences, emphasis, links, quotes)'] },
  { id: 'jsonl-to-json', category: 'Data', label: 'JSONL → JSON array', bundled: true, from: ['jsonl'], to: 'json', engine: 'text',
    losses: [] },
  { id: 'yaml-to-json', category: 'Data', label: 'YAML → JSON', bundled: true, from: ['yaml', 'yml'], to: 'json', engine: 'text',
    losses: ['Anchors/aliases resolved at parse time by the YAML library'] },
  { id: 'toml-to-json', category: 'Data', label: 'TOML → JSON', bundled: true, from: ['toml'], to: 'json', engine: 'text',
    losses: ['Subset parser: tables, key/values, arrays of primitives; multi-line strings and dotted tables beyond depth are unsupported and refused loudly'] },
  { id: 'xml-to-json', category: 'Data', label: 'XML → JSON', bundled: true, from: ['xml'], to: 'json', engine: 'text',
    losses: ['Attributes prefixed "@"; repeated siblings become arrays; processing instructions dropped'] },
  { id: 'csv-to-json', category: 'Data', label: 'CSV → JSON', bundled: true, from: ['csv'], to: 'json', engine: 'text',
    losses: ['All values stay strings except numbers that round-trip exactly'] },
  { id: 'csv-to-tsv', category: 'Data', label: 'CSV → TSV', bundled: true, from: ['csv'], to: 'tsv', engine: 'text',
    losses: ['Tabs inside cells become spaces (TSV cannot quote)'] },
  { id: 'tsv-to-csv', category: 'Data', label: 'TSV → CSV', bundled: true, from: ['tsv'], to: 'csv', engine: 'text',
    losses: [] },
  { id: 'md-to-html', category: 'Data', label: 'Markdown → HTML', bundled: true, from: ['md', 'markdown'], to: 'html', engine: 'text',
    losses: ['Markdown subset rendered; fonts/layout reflow in the browser'] },
  { id: 'html-to-text', category: 'Data', label: 'HTML → plain text', bundled: true, from: ['html', 'htm'], to: 'txt', engine: 'text',
    losses: ['Scripts/styles removed; layout becomes linear text'] },

  /* ---------------- CodeText / encodings -------------------------------- */
  { id: 'txt-utf8-to-utf16le', category: 'CodeText', label: 'UTF-8 → UTF-16LE text', bundled: true, from: ['txt', 'md', 'json', 'csv'], to: 'txt', engine: 'bytes',
    losses: [] },
  { id: 'txt-utf16le-to-utf8', category: 'CodeText', label: 'UTF-16LE → UTF-8 text', bundled: true, from: ['txt'], to: 'txt', engine: 'bytes',
    losses: [] },
  { id: 'file-to-base64', category: 'Binary', label: 'Any file → Base64 text', bundled: true, from: ['*'], to: 'b64.txt', engine: 'bytes',
    losses: [] },
  { id: 'file-to-hex', category: 'Binary', label: 'Any file → hex dump text', bundled: true, from: ['*'], to: 'hex.txt', engine: 'bytes',
    losses: [] },
  { id: 'base64-to-file', category: 'Binary', label: 'Base64 text → binary file', bundled: true, from: ['b64'], to: 'bin', engine: 'bytes',
    losses: ['Target type unknown — output keeps a .bin extension'] },
  { id: 'hex-to-file', category: 'Binary', label: 'Hex text → binary file', bundled: true, from: ['hex'], to: 'bin', engine: 'bytes',
    losses: ['Target type unknown — output keeps a .bin extension'] },

  /* ---------------- Images (canvas re-encode) ---------------------------- */
  { id: 'png-to-jpeg', category: 'Images', label: 'PNG → JPEG', bundled: true, from: ['png'], to: 'jpg', engine: 'image',
    losses: ['Transparency flattened onto black', 'EXIF/metadata stripped (canvas re-encode)', 'Lossy compression introduced'] },
  { id: 'jpeg-to-png', category: 'Images', label: 'JPEG → PNG', bundled: true, from: ['jpg', 'jpeg'], to: 'png', engine: 'image',
    losses: ['EXIF/metadata stripped (canvas re-encode)', 'File usually grows (lossless format)'] },
  { id: 'png-to-webp', category: 'Images', label: 'PNG → WebP', bundled: true, from: ['png'], to: 'webp', engine: 'image',
    losses: ['Optional lossy mode', 'EXIF/metadata stripped (canvas re-encode)'] },
  { id: 'webp-to-png', category: 'Images', label: 'WebP → PNG', bundled: true, from: ['webp'], to: 'png', engine: 'image',
    losses: ['Animation dropped (first frame kept)', 'EXIF/metadata stripped (canvas re-encode)'] },
  { id: 'jpeg-to-webp', category: 'Images', label: 'JPEG → WebP', bundled: true, from: ['jpg', 'jpeg'], to: 'webp', engine: 'image',
    losses: ['EXIF/metadata stripped (canvas re-encode)', 'Second lossy generation'] },
  { id: 'webp-to-jpeg', category: 'Images', label: 'WebP → JPEG', bundled: true, from: ['webp'], to: 'jpg', engine: 'image',
    losses: ['Transparency flattened onto black', 'Animation dropped (first frame kept)', 'EXIF/metadata stripped (canvas re-encode)'] },
  { id: 'gif-to-png', category: 'Images', label: 'GIF → PNG (first frame)', bundled: true, from: ['gif'], to: 'png', engine: 'image',
    losses: ['Animation dropped (first frame kept)', 'Palette quantisation lost'] },
  { id: 'svg-to-png', category: 'Images', label: 'SVG → PNG (rasterise)', bundled: true, from: ['svg'], to: 'png', engine: 'image',
    losses: ['Vector data rasterised at chosen width', 'External references inside the SVG are not fetched'] },

  /* ---------------- Archives --------------------------------------------- */
  { id: 'zip-create', category: 'Archives', label: 'Create ZIP', bundled: true, from: ['*'], to: 'zip', engine: 'worker',
    losses: ['No AES encryption — the bundled archiver cannot encrypt (stated, not hidden)'] },
  { id: 'zip-extract', category: 'Archives', label: 'Extract ZIP', bundled: true, from: ['zip'], to: '', engine: 'worker',
    losses: ['AES-encrypted archives are NOT supported and fail with that exact reason'] },
  { id: '7z-create', category: 'Archives', label: 'Create 7z', bundled: false, reason: 'archiver not bundled — roadmap', from: ['*'], to: '7z', engine: 'none', losses: [] },
  { id: '7z-extract', category: 'Archives', label: 'Extract 7z', bundled: false, reason: 'archiver not bundled — roadmap', from: ['7z'], to: '', engine: 'none', losses: [] },

  /* ---------------- Audio (honest gaps) ---------------------------------- */
  { id: 'mp3-convert', category: 'Audio', label: 'MP3 convert', bundled: false, reason: 'audio decoder not bundled', from: ['mp3'], to: 'wav', engine: 'none', losses: [] },
  { id: 'wav-convert', category: 'Audio', label: 'WAV convert', bundled: false, reason: 'audio decoder not bundled', from: ['wav'], to: 'mp3', engine: 'none', losses: [] },
  { id: 'ogg-convert', category: 'Audio', label: 'OGG convert', bundled: false, reason: 'audio decoder not bundled', from: ['ogg'], to: 'wav', engine: 'none', losses: [] },

  /* ---------------- Video (honest gaps) ---------------------------------- */
  { id: 'mp4-convert', category: 'Video', label: 'MP4 convert', bundled: false, reason: 'video decoder not bundled', from: ['mp4'], to: 'webm', engine: 'none', losses: [] },
  { id: 'webm-convert', category: 'Video', label: 'WebM convert', bundled: false, reason: 'video decoder not bundled', from: ['webm'], to: 'mp4', engine: 'none', losses: [] },
];

export function adapterById(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* magic-byte detection                                                */
/* ------------------------------------------------------------------ */

/**
 * Detect a type from leading bytes. Returns {kind:'ext', ext} on a confident
 * signature, {kind:'text', ext:'txt'} for decodable prose, or {kind:'unknown'}.
 */
export function detectFromHead(headU8, size = 0) {
  const b = headU8;
  const ascii = (start, s) => s.split('').every((ch, i) => b[start + i] === ch.charCodeAt(0));
  if (b.length >= 5 && ascii(0, '%PDF-')) return { kind: 'ext', ext: 'pdf' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: 'ext', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'ext', ext: 'jpg' };
  if (b.length >= 6 && ascii(0, 'GIF87a')) return { kind: 'ext', ext: 'gif' };
  if (b.length >= 6 && ascii(0, 'GIF89a')) return { kind: 'ext', ext: 'gif' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { kind: 'ext', ext: 'webp' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && ascii(8, 'WAVE')) return { kind: 'ext', ext: 'wav' };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return { kind: 'ext', ext: 'zip' };
  if (b.length >= 4 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return { kind: 'ext', ext: '7z' };
  /* BOMs */
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { kind: 'text', ext: 'txt' };
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return { kind: 'text', ext: 'txt' };
  /* JSON heuristic on the first non-whitespace byte: '{' or '[' is a strong
     structural hint even though a 64-byte head can rarely parse in full. */
  let i = 0;
  while (i < b.length && (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13)) i++;
  if (i < b.length && (b[i] === 0x7b || b[i] === 0x5b)) {
    return { kind: 'ext', ext: 'json' };
  }
  /* printable-ratio text guess over what we can see */
  if (b.length >= 16) {
    let printable = 0;
    for (const byte of b) {
      if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) printable++;
    }
    if (printable / b.length > 0.9) return { kind: 'text', ext: 'txt' };
  }
  return { kind: 'unknown', ext: '' };
}

function extOf(name) {
  const lower = String(name || '').toLowerCase();
  const m = /\.([a-z0-9]{1,12})$/.exec(lower);
  if (!m) return '';
  const alias = { jpeg: 'jpg', markdown: 'md', htm: 'html', yml: 'yaml' };
  return alias[m[1]] || m[1];
}

/* ------------------------------------------------------------------ */
/* queue store                                                         */
/* ------------------------------------------------------------------ */

const QUEUE_KEY = 'convertQueue';

/** @returns {Array} persistent, resumable queue records */
export function loadQueue() {
  const q = store.get(QUEUE_KEY, []);
  /* recover items that were mid-flight when the app closed */
  for (const it of q) {
    if (it.status === 'running') it.status = 'queued';
  }
  return q;
}

let saveTimer = null;
function persistQueue() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(QUEUE_KEY, queue.map(stripVolatile)), 250);
}
function stripVolatile(it) {
  const { _fileObj, ...rest } = it;
  void _fileObj;
  return rest;
}

let queue = loadQueue();
let paused = false;
let activeCount = 0;

/* ------------------------------------------------------------------ */
/* sandbox byte plumbing                                               */
/* ------------------------------------------------------------------ */

async function runWorker(payload, onProgress, item) {
  const jobId = payload.jobId || `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  /* stamp the running job id onto the queue item so per-item cancel reaches
     the main-process job registry before the promise settles */
  if (item) item.jobId = jobId;
  const off = subscribeProgress((msg) => {
    if (msg.jobId === jobId && onProgress) onProgress(msg);
  });
  try {
    return await invoke('converter:run', { ...payload, jobId });
  } finally {
    if (item) delete item.jobId;
    off();
  }
}

const progressSubs = new Set();
function subscribeProgress(fn) {
  progressSubs.add(fn);
  return () => progressSubs.delete(fn);
}

async function readBytesBounded(item, maxBytes = 64 * 1024 * 1024) {
  if (item.srcKind === 'file' && item._fileObj) {
    // Check the declared size BEFORE reading so oversized files never enter
    // memory at all; re-check after read in case the handle raced.
    const declared = Number(item._fileObj.size);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`File is ${(declared / 1048576).toFixed(1)} MB and exceeds the ${maxBytes / 1048576} MB inline limit.`);
    }
    const buf = await item._fileObj.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`File exceeds the ${maxBytes / 1048576} MB inline limit.`);
    return new Uint8Array(buf);
  }
  const res = await runWorker({
    family: 'data', op: 'read', inputPath: item.src,
    args: { maxBytes }, writesOutput: false,
  }, (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
  if (!res.ok) throw new Error(res.message || 'read failed');
  return new Uint8Array(base64ToBytes(res.result.b64));
}

async function writeBytesAtomic(destPath, bytes, expectHeadB64) {
  const res = await runWorker({
    family: 'data', op: 'write', outputPath: destPath,
    inputDataB64: bytesToBase64(bytes),
    args: expectHeadB64 ? { expectHeadB64 } : {},
  }, () => {});
  if (!res.ok) throw new Error('atomic write failed');
  return res.output;
}

/* base64 helpers that avoid call-stack blowups on big buffers */
function bytesToBase64(u8) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ */
/* text/data transforms                                                */
/* ------------------------------------------------------------------ */

const dec = new TextDecoder('utf-8');
const enc = new TextEncoder();

async function yamlLib() {
  const m = await import('yaml');
  return m.default || m;
}

/* --- TOML: documented SUBSET parser/writer --------------------------- */
function tomlParse(text) {
  const root = {};
  let cur = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '$1').trim();
    if (!line) continue;
    const tbl = /^\[([^\]]+)\]$/.exec(line);
    if (tbl) {
      cur = root;
      for (const seg of tbl[1].split('.')) {
        const k = seg.trim().replace(/^"(.*)"$/, '$1');
        cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {};
        cur = cur[k];
      }
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv) throw new Error(`TOML subset parser: cannot understand line "${rawLine.slice(0, 60)}". Multi-line strings/arrays and dotted keys beyond tables are unsupported.`);
    const key = kv[1].trim();
    const valRaw = kv[2].trim();
    if (/,$/.test(valRaw) || valRaw.startsWith('[') && !valRaw.endsWith(']')) {
      throw new Error('TOML subset parser: multi-line arrays are unsupported.');
    }
    cur[key] = tomlValue(valRaw);
  }
  return root;
}
function tomlValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^".*"$/s.test(raw)) return raw.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(raw)) return parseFloat(raw);
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const parts = [];
    let depth = 0;
    let curStr = '';
    let inStr = false;
    for (const ch of inner) {
      if (ch === '"') inStr = !inStr;
      if (!inStr && ch === ',') {
        parts.push(curStr);
        curStr = '';
        continue;
      }
      curStr += ch;
    }
    void depth;
    if (curStr.trim()) parts.push(curStr);
    return parts.map((p) => tomlValue(p.trim()));
  }
  /* dates and anything else travel as strings, honestly */
  return raw;
}
function tomlStringify(obj) {
  const lines = [];
  emitTable(obj, []);
  return lines.join('\n') + '\n';

  function scalar(v) {
    if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return null;
  }
  function emitTable(t, pathSegs) {
    const simple = [];
    const nested = [];
    for (const [k, v] of Object.entries(t || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) nested.push([k, v]);
      else simple.push([k, v]);
    }
    if (pathSegs.length) lines.push(`[${pathSegs.join('.')}]`);
    for (const [k, v] of simple) {
      if (Array.isArray(v)) {
        const scalars = v.map(scalar);
        if (scalars.some((s) => s == null)) {
          lines.push(`${k} = "${JSON.stringify(v).slice(0, 200)}" # mixed/complex array stringified (subset writer)`);
        } else {
          lines.push(`${k} = [${scalars.join(', ')}]`);
        }
      } else {
        const s = scalar(v);
        lines.push(k === '' ? '' : `${k} = ${s ?? `"${String(v)}"`}`);
      }
    }
    if (pathSegs.length && (simple.length || nested.length)) lines.push('');
    for (const [k, v] of nested) emitTable(v, [...pathSegs, k]);
  }
}

/* --- XML: minimal well-formed subset ---------------------------------- */
function xmlParse(text) {
  let i = 0;
  const len = text.length;
  function skipProlog() {
    while (i < len) {
      if (text.startsWith('<?', i)) { i = text.indexOf('?>', i); if (i < 0) throw new Error('Unterminated processing instruction.'); i += 2; continue; }
      if (text.startsWith('<!--', i)) { i = text.indexOf('-->', i); if (i < 0) throw new Error('Unterminated comment.'); i += 3; continue; }
      if (text.startsWith('<!DOCTYPE', i)) { i = text.indexOf('>', i); if (i < 0) throw new Error('Unterminated DOCTYPE.'); i += 1; continue; }
      break;
    }
  }
  function parseNode() {
    skipWs();
    if (text[i] !== '<') throw new Error(`XML parser: expected element at offset ${i}.`);
    i++;
    const m = /^([A-Za-z_][\w.:-]*)/.exec(text.slice(i));
    if (!m) throw new Error(`XML parser: bad tag name at offset ${i}.`);
    const name = m[1];
    i += name.length;
    const node = { '@name': name, '@attrs': {}, children: [], '#text': '' };
    /* attributes */
    for (;;) {
      skipWs();
      if (text[i] === '>') { i++; break; }
      if (text.startsWith('/>', i)) { i += 2; node.selfClosed = true; return node; }
      const am = /^([\w.:-]+)\s*=\s*(["'])/.exec(text.slice(i));
      if (!am) throw new Error(`XML parser: expected attribute at offset ${i}.`);
      i += am.index + am[0].length;
      const quote = am[2];
      const endQ = text.indexOf(quote, i);
      if (endQ < 0) throw new Error('Unterminated attribute value.');
      node['@attrs'][am[1]] = xmlUnescape(text.slice(i, endQ));
      i = endQ + 1;
    }
    /* children */
    for (;;) {
      if (text.startsWith('</', i)) {
        const close = new RegExp(`^</${escapeRe(name)}>`).exec(text.slice(i));
        if (!close) throw new Error(`Mismatched closing tag near offset ${i}.`);
        i += close[0].length;
        return node;
      }
      if (text.startsWith('<!--', i)) { i = text.indexOf('-->', i) + 3; continue; }
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i);
        if (end < 0) throw new Error('Unterminated CDATA.');
        node['#text'] += text.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (text[i] === '<') node.children.push(parseNode());
      else {
        const next = text.indexOf('<', i);
        if (next < 0) throw new Error('Unexpected end of XML.');
        node['#text'] += xmlUnescape(text.slice(i, next));
        i = next;
      }
      skipWs();
    }
  }
  function skipWs() { while (i < len && /\s/.test(text[i])) i++; }
  skipProlog();
  const doc = parseNode();
  skipProlog();
  return doc;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function xmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function jsonToXml(data, rootName = 'root') {
  const build = (node, name, out) => {
    if (Array.isArray(node)) {
      for (const item of node) build(item, singularize(name), out);
      return;
    }
    if (node && typeof node === 'object') {
      out.push(`<${name}>`);
      for (const [k, v] of Object.entries(node)) {
        const safeKey = /^[A-Za-z_][\w.-]*$/.test(k) ? k : 'entry';
        build(v, safeKey, out);
      }
      out.push(`</${name}>`);
      return;
    }
    out.push(`<${name}>${xmlEscape(node ?? '')}</${name}>`);
  };
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  build(data, rootName, lines);
  return lines.join('\n');
}
function singularize(name) {
  return name.endsWith('s') && name.length > 1 ? name.slice(0, -1) : name;
}
function xmlToJsonNode(node) {
  const obj = { ...node['@attrs'] };
  for (const child of node.children) {
    const key = child['@name'];
    const val = xmlToJsonNode(child);
    if (key in obj) {
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      obj[key].push(val);
    } else obj[key] = val;
  }
  const txt = (node['#text'] || '').trim();
  if (!node.children.length && txt) return Object.keys(obj).length ? { '#text': txt, ...obj } : txt;
  return obj;
}

/* --- CSV/TSV ----------------------------------------------------------- */
function csvParse(text, delim = ',') {
  const rows = [[]];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { rows[rows.length - 1].push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { rows[rows.length - 1].push(cell); rows.push([]); cell = ''; continue; }
    cell += c;
  }
  rows[rows.length - 1].push(cell);
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
function csvSerialize(rows, delim = ',') {
  return rows.map((row) => row.map((cellVal) => {
    const s = cellVal == null ? '' : String(cellVal);
    const needs = s.includes('"') || s.includes(delim) || /[\n\r]/.test(s);
    return needs ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(delim)).join('\r\n') + '\r\n';
}

/* --- Markdown-lite -> HTML ---------------------------------------------- */
function mdToHtml(md) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  const out = [];
  let inFence = false;
  let listMode = null;
  const closeList = () => { if (listMode) { out.push(`</${listMode}>`); listMode = null; } };
  for (const rawLine of md.split(/\r?\n/)) {
    const fence = /^```/.exec(rawLine);
    if (fence) {
      closeList();
      out.push(inFence ? '</code></pre>' : '<pre><code>');
      inFence = !inFence;
      continue;
    }
    if (inFence) { out.push(esc(rawLine)); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(rawLine);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const hr = /^(-{3,}|\*{3,})\s*$/.exec(rawLine);
    if (hr) { closeList(); out.push('<hr>'); continue; }
    const ul = /^[-*]\s+(.*)$/.exec(rawLine);
    if (ul) {
      if (listMode !== 'ul') { closeList(); out.push('<ul>'); listMode = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(rawLine);
    if (ol) {
      if (listMode !== 'ol') { closeList(); out.push('<ol>'); listMode = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(rawLine);
    if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
    if (!rawLine.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(rawLine)}</p>`);
  }
  closeList();
  if (inFence) out.push('</code></pre>');
  return `<!doctype html>\n<meta charset="utf-8">\n<body style="font-family:sans-serif;max-width:60rem;margin:2rem auto;line-height:1.55">\n${out.join('\n')}\n</body>`;
}

/* --- structured helpers -------------------------------------------------- */
function deepFlatRecords(data) {
  if (!Array.isArray(data)) return null;
  const cols = [];
  for (const rec of data) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    for (const k of Object.keys(rec)) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
}
function cellify(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/* ------------------------------------------------------------------ */
/* image transforms                                                    */
/* ------------------------------------------------------------------ */

const MAX_PIXELS = 64e6; // 64 MP hard cap — exceeded inputs are REFUSED

async function convertImage(item, adapter, quality) {
  const bytes = await readBytesBounded(item);
  const blob = new Blob([bytes]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (_) {
    throw new Error('This browser build cannot decode that image.');
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      throw new Error(`Image is ${(bitmap.width * bitmap.height / 1e6).toFixed(1)} MP; the limit is 64 MP.`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (adapter.to === 'jpg') {
      ctx.fillStyle = '#000000'; // transparency flattening — disclosed pre-run
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    setProgress(item.id, 60, 100);
    const type = adapter.to === 'jpg' ? 'image/jpeg'
      : adapter.to === 'webp' ? 'image/webp' : 'image/png';
    const blobOut = await canvas.convertToBlob({ type, quality: type === 'image/png' ? undefined : Number(quality ?? 0.92) });
    const outBytes = new Uint8Array(await blobOut.arrayBuffer());
    /* validate before claiming success: re-decode the produced blob */
    const recheck = await createImageBitmap(new Blob([outBytes])).then((bm) => { bm.close?.(); return true; })
      .catch(() => false);
    if (!recheck) throw new Error('Post-write validation failed: encoded image does not re-decode.');
    return { bytes: outBytes, ext: adapter.to };
  } finally {
    bitmap.close?.();
  }
}

/* ------------------------------------------------------------------ */
/* engine dispatch                                                     */
/* ------------------------------------------------------------------ */

function setProgress(id, done, total) {
  const it = queue.find((q) => q.id === id);
  if (!it) return;
  it.bytesDone = done;
  it.bytesTotal = total;
  renderQueueTableThrottled();
}

async function runTextEngine(item, adapter) {
  const bytes = await readBytesBounded(item, 64 * 1024 * 1024);
  setProgress(item.id, 30, 100);
  const text = dec.decode(bytes);

  /** Produce {text|bytes, ext} for every text-family target. */
  const produce = async () => {
    switch (adapter.id) {
      case 'json-to-jsonl': case 'jsonl-to-json': case 'json-to-yaml': case 'yaml-to-json':
      case 'json-to-toml': case 'toml-to-json': case 'xml-to-json': case 'json-to-csv':
      case 'csv-to-json': case 'json-to-md': case 'json-to-html': {
        /* Parse by the file's DETECTED/claimed extension, never by the
           adapter's from-list order — an adapter accepting both json and md
           must not try JSON.parse on markdown. */
        const srcExt = extOf(item.srcName || item.src || '');
        let data;
        if (adapter.id === 'json-to-html' && (srcExt === 'md' || srcExt === 'markdown')) {
          return { text: mdToHtml(text), ext: 'html' };
        }
        if (srcExt === 'json') data = JSON.parse(text);
        else if (srcExt === 'jsonl') {
          data = text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
        } else if (srcExt === 'yaml' || srcExt === 'yml') data = (await yamlLib()).parse(text);
        else if (srcExt === 'toml') data = tomlParse(text);
        else if (srcExt === 'xml') data = xmlToJsonNode(xmlParse(text));
        else if (srcExt === 'csv') {
          const rows = csvParse(text);
          const [head, ...body] = rows;
          data = body.map((r) => Object.fromEntries(head.map((h, idx) => {
            const rawCell = r[idx] ?? '';
            const num = Number(rawCell);
            return [h, rawCell !== '' && String(num) === rawCell ? num : rawCell];
          })));
        } else {
          throw new Error(`Unsupported source type ".${srcExt}" for ${adapter.id}.`);
        }

        switch (adapter.to) {
          case 'jsonl': {
            const arr = Array.isArray(data) ? data : [data];
            return { text: arr.map((r) => JSON.stringify(r)).join('\n') + '\n', ext: 'jsonl' };
          }
          case 'json': {
            return { text: JSON.stringify(Array.isArray(data) && data.length === 1 && !Array.isArray(data[0]) ? data[0] : data, null, 2) + '\n', ext: 'json' };
          }
          case 'yaml': {
            const YAML = await yamlLib();
            return { text: YAML.stringify(data), ext: 'yaml' };
          }
          case 'toml': return { text: tomlStringify(data), ext: 'toml' };
          case 'xml': return { text: jsonToXml(data), ext: 'xml' };
          case 'csv': {
            const cols = deepFlatRecords(data);
            if (!cols) throw new Error('CSV target needs an array of flat objects.');
            const rows = [cols, ...data.map((r) => cols.map((c) => cellify(r[c])))];
            return { text: csvSerialize(rows), ext: 'csv' };
          }
          case 'tsv': {
            const cols = deepFlatRecords(data);
            if (!cols) throw new Error('TSV target needs an array of flat objects.');
            const rows = [cols, ...data.map((r) => cols.map((c) => String(cellify(r[c])).replace(/\t/g, ' ')))];
            return { text: csvSerialize(rows, '\t'), ext: 'tsv' };
          }
          case 'md': {
            const cols = deepFlatRecords(data);
            if (!cols) return { text: '```json\n' + JSON.stringify(data, null, 2) + '\n```\n', ext: 'md' };
            const head = `| ${cols.join(' | ')} |`;
            const sep = `| ${cols.map(() => '---').join(' | ')} |`;
            const body = data.map((r) => `| ${cols.map((c) => String(cellify(r[c])).replace(/\|/g, '\\|')).join(' | ')} |`).join('\n');
            return { text: `${head}\n${sep}\n${body}\n`, ext: 'md' };
          }
          default:
            throw new Error(`Unsupported text target "${adapter.to}".`);
        }
      }

      case 'md-to-html': return { text: mdToHtml(text), ext: 'html' };
      case 'json-to-md-html-fallback': return { text: mdToHtml(text), ext: 'html' };

      case 'html-to-text': {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        doc.querySelectorAll('script,style').forEach((n) => n.remove());
        return { text: (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim() + '\n', ext: 'txt' };
      }

      default:
        throw new Error(`Unknown text adapter ${adapter.id}.`);
    }
  };

  let produced;
  if (adapter.id === 'csv-to-tsv') {
    /* CSV→TSV must RE-SERIALIZE with tabs — swapping delimiters in the
       serialized text would corrupt quoted cells containing commas. */
    produced = { text: csvSerialize(csvParse(text), '\t'), ext: 'tsv' };
  } else if (adapter.id === 'tsv-to-csv') {
    produced = { text: csvSerialize(csvParse(text, '\t'), ','), ext: 'csv' };
  } else {
    produced = await produce();
  }
  setProgress(item.id, 70, 100);

  const finalExt = produced.ext === 'html' && adapter.id === 'json-to-html' && !looksLikeMd(text) ? 'html' : produced.ext;
  const outBytes = enc.encode(produced.text);
  await writeBytesAtomic(item.dest, outBytes);
  setProgress(item.id, 100, 100);
  return { ext: finalExt, bytes: outBytes.length };
}

function looksLikeMd(t) {
  return /^#{1,6}\s|\n[-*]\s|\n>|\n```/.test(t.slice(0, 4000));
}

async function runBytesEngine(item, adapter) {
  const bytes = await readBytesBounded(item);
  setProgress(item.id, 40, 100);
  switch (adapter.id) {
    case 'txt-utf8-to-utf16le': {
      const text = dec.decode(bytes);
      const out = utf16leEncode(text);
      await writeBytesAtomic(item.dest, out);
      return { bytes: out.length };
    }
    case 'txt-utf16le-to-utf8': {
      const text = utf16leDecode(bytes);
      const out = enc.encode(text);
      await writeBytesAtomic(item.dest, out);
      return { bytes: out.length };
    }
    case 'file-to-base64': {
      const text = bytesToBase64(bytes);
      const out = enc.encode(text.match(/.{1,96}/g)?.join('\n') + '\n');
      await writeBytesAtomic(item.dest, out);
      return { bytes: out.length };
    }
    case 'file-to-hex': {
      const lines = [];
      for (let i = 0; i < bytes.length; i += 16) {
        const slice = bytes.subarray(i, i + 16);
        const hexPart = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const asciiPart = [...slice].map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
        lines.push(`${i.toString(16).padStart(8, '0')}  ${hexPart.padEnd(47)}  ${asciiPart}`);
      }
      const out = enc.encode(lines.join('\n') + '\n');
      await writeBytesAtomic(item.dest, out);
      return { bytes: out.length };
    }
    case 'base64-to-file': {
      const cleaned = dec.decode(bytes).replace(/\s+/g, '');
      const out = base64ToBytes(cleaned);
      await writeBytesAtomic(item.dest, out);
      return { bytes: out.length };
    }
    case 'hex-to-file': {
      const hex = dec.decode(bytes).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length % 2 !== 0) throw new Error('Hex stream has an odd number of digits.');
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      await writeBytesAtomic(item.dest, out);
      return { bytes: out.length };
    }
    default:
      throw new Error(`Unknown bytes adapter ${adapter.id}.`);
  }
}

function utf16leEncode(text) {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe; // LE BOM so readers identify it honestly
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >> 8;
  }
  return out;
}
function utf16leDecode(bytes) {
  let start = 0;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) start = 2;
  let s = '';
  for (let i = start; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return s;
}

async function runWorkerEngine(item, adapter) {
  switch (adapter.id) {
    case 'pdf-inspect': {
      const res = await runWorker({ family: 'pdf', op: 'inspect', inputPath: item.src, writesOutput: false },
        (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      item.report = res.result;
      return { report: res.result };
    }
    case 'pdf-split': {
      const ranges = item.args.ranges;
      const res = await runWorker({ family: 'pdf', op: 'split', inputPath: item.src, outputPath: item.dest, args: { ranges } },
        (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'pdf-merge': {
      const res = await runWorker({ family: 'pdf', op: 'merge', inputPath: item.src, outputPath: item.dest, args: { inputs: item.args.inputs } },
        (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'pdf-reorder': {
      const res = await runWorker({ family: 'pdf', op: 'reorder', inputPath: item.src, outputPath: item.dest,
        args: item.args.order ? { order: item.args.order } : { move: item.args.move } },
      (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'pdf-rotate': {
      const res = await runWorker({ family: 'pdf', op: 'rotate', inputPath: item.src, outputPath: item.dest,
        args: { degrees: item.args.degrees, ranges: item.args.ranges } },
      (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'pdf-extract-pages': {
      const res = await runWorker({ family: 'pdf', op: 'extract-pages', inputPath: item.src, outputPath: item.dest, args: { ranges: item.args.ranges } },
        (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'pdf-metadata': {
      const res = await runWorker({ family: 'pdf', op: 'metadata-edit', inputPath: item.src, outputPath: item.dest,
        args: { title: item.args.title, author: item.args.author } },
      (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'zip-create': {
      const entries = [];
      for (const src of item.args.inputs) {
        entries.push(typeof src === 'object' ? src : { inputPath: src, name: pathBase(src) });
      }
      const level = Math.round(Number(item.args.level ?? 6));
      const res = await runWorker({ family: 'zip', op: 'zip-create', outputPath: item.dest, args: { entries, level } },
        (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    case 'zip-extract': {
      const res = await runWorker({ family: 'zip', op: 'zip-extract', inputPath: item.src, writesOutput: false,
        args: { destDir: item.args.destDir } },
      (m) => setProgress(item.id, m.bytesDone, m.bytesTotal), item);
      if (!res.ok) throw new Error(workerMsg(res));
      return res.result;
    }
    default:
      throw new Error(`Unknown worker adapter ${adapter.id}.`);
  }
}

function workerMsg(res) {
  return String(res && (res.message || res.error) || 'conversion failed');
}
function pathBase(p) {
  const norm = String(p).split(/[\\/]/);
  return norm[norm.length - 1] || 'file';
}

/* ------------------------------------------------------------------ */
/* queue runner                                                        */
/* ------------------------------------------------------------------ */

function concurrencySetting() {
  return Math.min(Math.max(Math.round(Number(getSettingLocal('converter.concurrency', 2))) || 2, 1), 6);
}
function getSettingLocal(path, fallback) {
  if (P.settings && typeof P.settings.get === 'function') return P.settings.get(path, fallback);
  const v = store.get(path, undefined);
  return v === undefined ? fallback : v;
}

let runnerRunning = false;

async function pump() {
  if (runnerRunning) return;
  runnerRunning = true;
  try {
    for (;;) {
      if (paused) break;
      const limit = concurrencySetting();
      if (activeCount >= limit) break;
      const next = queue.find((it) => it.status === 'queued');
      if (!next) break;
      processItem(next).finally(() => {
        activeCount--;
        renderQueueTableThrottled();
        pump();
      });
      activeCount++;
    }
  } finally {
    runnerRunning = false;
  }
  updateToolbarState();
}

async function processItem(item) {
  const adapter = adapterById(item.adapterId);
  item.status = 'running';
  item.startedAt = Date.now();
  persistQueue();
  renderQueueTableThrottled();
  try {
    if (!adapter) throw new Error('The selected adapter no longer exists.');
    if (adapter.bundled === false) throw new Error(adapter.reason || 'not bundled');

    /* detection + mismatch refusal */
    const detected = await detectItem(item);
    item.detectedExt = detected.ext || detected.kind;
    const claimed = item.claimedExt || extOf(item.srcName || item.src || '');
    const accepts = adapter.from.includes('*') ? true
      : adapter.from.some((f) => f === claimed || f === detected.ext);
    if (!accepts) {
      throw new Error(
        `Refused: file looks like "${detected.ext || detected.kind}" but was queued as ".${claimed}". Detection uses magic bytes, not the extension.`,
      );
    }

    /* overwrite resolution happens at enqueue; dest guaranteed free here unless policy confirm-overwrite */
    let outcome;
    if (adapter.engine === 'worker') outcome = await runWorkerEngine(item, adapter);
    else if (adapter.engine === 'image') {
      const r = await convertImage(item, adapter, getSettingLocal('converter.imageQuality', 0.92));
      await writeBytesAtomic(item.dest, r.bytes);
      outcome = { bytes: r.bytes };
    } else if (adapter.engine === 'text') outcome = await runTextEngine(item, adapter);
    else if (adapter.engine === 'bytes') outcome = await runBytesEngine(item, adapter);
    else throw new Error('Adapter has no executable engine.');

    item.status = 'done';
    item.outcome = outcome;
    item.finishedAt = Date.now();
    recordChange(`Converted ${item.srcName}`, { adapter: adapter.id, dest: item.dest });
  } catch (err) {
    if (item.cancelRequested) {
      item.status = 'cancelled';
      item.error = 'cancelled';
    } else {
      item.status = 'failed';
      item.error = String((err && err.message) || err);
      try {
        ui.toast?.({
          title: tt('Conversion failed', '轉換失敗'),
          body: `${item.srcName}: ${item.error}`,
          tone: 'error', timeoutMs: 9000,
        });
      } catch (_) { /* toast optional */ }
    }
  } finally {
    item.cancelRequested = false;
    persistQueue();
    renderQueueTableThrottled();
  }
}

async function detectItem(item) {
  if (item._detected) return item._detected;
  let head;
  if (item.srcKind === 'file' && item._fileObj) {
    head = new Uint8Array(await item._fileObj.slice(0, 64).arrayBuffer());
    item.sizeBytes = item._fileObj.size;
  } else {
    const res = await invoke('converter:detect', { path: item.src });
    if (!res.ok) throw new Error('Source disappeared before conversion.');
    head = base64ToBytes(res.headB64);
    item.sizeBytes = res.size;
  }
  item._detected = detectFromHead(head, item.sizeBytes || 0);
  return item._detected;
}

/* ------------------------------------------------------------------ */
/* preflight: free space, overwrite, disclosure                        */
/* ------------------------------------------------------------------ */

/** Conservative output-size estimates per target extension (× input bytes). */
const ESTIMATE_FACTOR = {
  jpg: 0.35, jpeg: 0.35, webp: 0.3, png: 1.2, zip: 1.0, pdf: 1.2,
  json: 1.2, jsonl: 1.2, yaml: 1.2, toml: 1.2, xml: 1.5, csv: 1.2, tsv: 1.2,
  md: 1.2, html: 1.5, txt: 1.2, bin: 0.75, 'b64.txt': 1.4, 'hex.txt': 3.0,
};

async function preflightFreeSpace(items) {
  let needed = 0;
  for (const it of items) {
    const ad = adapterById(it.adapterId);
    const factor = ESTIMATE_FACTOR[ad ? ad.to : 'bin'] ?? 1.5;
    needed += Math.ceil((it.sizeBytes || 0) * factor) || 1024;
  }
  const probeDir = items[0] ? dirOf(items[0].dest) : null;
  if (!probeDir) return { ok: true, needed, free: Infinity };
  const res = await invoke('converter:free', { path: probeDir }).catch(() => ({ ok: false }));
  if (!res.ok) return { ok: true, needed, free: null, note: 'free-space query unavailable' };
  return { ok: res.freeBytes > needed, needed, free: res.freeBytes };
}

function dirOf(p) {
  const norm = String(p).split(/[\\/]/);
  norm.pop();
  return norm.join('/') || '/';
}

async function resolveOverwrite(item) {
  const policy = getSettingLocal('converter.overwritePolicy', 'suffix');
  const exists = await pathExists(item.dest);
  if (!exists) return { dest: item.dest, conflict: false };
  if (policy === 'skip') return { conflict: true, skip: true };
  if (policy === 'suffix') {
    const m = /^(.*)(\.[^.]+)$/.exec(item.dest);
    const stem = m ? m[1] : item.dest;
    const ext = m ? m[2] : '';
    let n = 1;
    let candidate = `${stem}-${n}${ext}`;
    while (await pathExists(candidate)) { n++; candidate = `${stem}-${n}${ext}`; }
    return { dest: candidate, conflict: false, renamed: true };
  }
  return { dest: item.dest, conflict: true, askOverwrite: true };
}

async function pathExists(p) {
  /* detect works as an existence probe without reading content decisions */
  try {
    const res = await invoke('converter:detect', { path: p });
    return !!res.ok;
  } catch (_) {
    return false;
  }
}

/**
 * Full pre-batch gate: disclosure modal (losses per adapter) + free-space
 * warn-block + overwrite confirmations. Resolves the batch or throws.
 */
async function preflightBatch(batchItems) {
  const adaptersInvolved = [...new Set(batchItems.map((it) => it.adapterId))]
    .map(adapterById).filter(Boolean);

  /* disclosure FIRST — nothing runs until an explicit Convert click */
  if (ui.modal) {
    const proceed = await new Promise((resolve) => {
      const listEl = ui.el('div', { class: 'mrb-converter-disclosure' });
      listEl.append(ui.el('p', {
        class: 'mrb-explain',
        text: tt('Review what each conversion changes BEFORE anything runs. Nothing has been written yet.', '執行之前先睇清楚每個轉換會改乜。而家仲未寫入任何檔案。'),
      }));
      for (const ad of adaptersInvolved) {
        const box = ui.el('div', { class: 'mrb-card mrb-converter-disclosure-card' },
          ui.el('strong', { text: `${ad.label} (${ad.category})` }));
        const losses = ad.losses || [];
        if (ad.engine === 'image' || ad.id === 'jpeg-to-webp') {
          box.append(ui.el('li', { text: tt('EXIF/metadata stripped — canvas re-encode always drops it.', 'EXIF／metadata 會被移除 — 經 canvas 轉碼一定會掉。') }));
        }
        for (const l of losses) box.append(ui.el('li', { text: l }));
        if (!box.querySelector('li')) box.append(ui.el('li', { text: tt('No known data changes; bytes are validated after writing.', '冇已知資料改變；寫入後會驗證。') }));
        listEl.append(box);
      }
      const closeM = ui.modal({
        title: tt('Confirm conversions', '確認轉換'),
        build: (b) => b.append(listEl),
        actions: [
          { label: tt('Cancel', '取消'), onClick: () => { closeM(); resolve(false); } },
          { label: tt('Convert', '開始轉換'), onClick: () => { closeM(); resolve(true); } },
        ],
      });
    });
    if (!proceed) return false;
  }

  /* free-space warn-block */
  const space = await preflightFreeSpace(batchItems);
  if (space.free != null && !space.ok) {
    if (ui.modal) {
      const ok = await new Promise((resolve) => {
        const body = ui.el('div', {},
          ui.el('p', { text: tt('Not enough free space for the estimated outputs.', '可用空間唔夠容納預計輸出。') }),
          ui.el('p', { text: `${tt('Estimated need', '預計需要')}: ${ui.fmtBytes(space.needed)} · ${tt('Free', '可用')}: ${space.free === Infinity ? '?' : ui.fmtBytes(space.free)}` }),
          ui.el('label', { class: 'mrb-field-check' },
            ui.el('input', { type: 'checkbox', id: 'mrb-cvt-force' }),
            ui.el('span', { text: tt('I understand; run anyway', '我明白；照樣執行') })));
        const closeM = ui.modal({
          title: tt('Low disk space', '磁碟空間不足'),
          build: (b) => b.append(body),
          actions: [
            { label: tt('Cancel', '取消'), onClick: () => { closeM(); resolve(false); } },
            {
              label: tt('Proceed', '繼續'),
              onClick: () => {
                const cb = body.querySelector('#mrb-cvt-force');
                closeM();
                resolve(!!(cb && cb.checked)); // block stands unless explicitly confirmed
              },
            },
          ],
        });
      });
      if (!ok) return false;
    } else {
      return false; // no modal capability: fail closed rather than fill the disk
    }
  }

  /* overwrite confirmation (policy = confirm) */
  const conflicts = [];
  for (const it of batchItems) {
    const res = await resolveOverwrite(it);
    it.dest = res.dest;
    if (res.skip) { it.status = 'skipped'; it.error = 'destination exists (policy: skip)'; continue; }
    if (res.askOverwrite) conflicts.push(it);
  }
  if (conflicts.length && ui.superConfirm) {
    await new Promise((resolve) => {
      ui.superConfirm({
        title: tt('Overwrite existing files?', '覆寫現有檔案？'),
        detailHtml: conflicts.map((c) => `• ${escapeHtmlLocal(c.dest)}`).join('<br>'),
        confirmLabel: tt('Overwrite files', '覆寫檔案'),
        onConfirm: () => resolve(true),
      });
      // Safety timeout DENIES rather than confirms: the destructive action may
      // only run when the user completes both keys plus the full slider.
      setTimeout(() => resolve(false), 60000);
    });
  }
  persistQueue();
  return true;
}

function escapeHtmlLocal(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* public API used by other surfaces                                   */
/* ------------------------------------------------------------------ */

/** Queue picked absolute paths. */
export async function addPaths(paths, opts = {}) {
  const outDir = await ensureOutputDir(opts);
  if (!outDir) return [];
  const added = [];
  for (const p of paths) {
    const name = pathBase(p);
    const it = {
      id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      src: p, srcKind: 'path', srcName: name,
      dest: joinPath(outDir, name),
      adapterId: opts.adapterId || guessAdapterFor(extOf(name)),
      status: 'queued', priority: opts.priority || 0,
      createdAt: Date.now(), bytesDone: 0, bytesTotal: 0,
      args: opts.args || {},
    };
    queue.push(it);
    added.push(it);
  }
  persistQueue();
  renderQueueTableThrottled();
  return added;
}

/** Queue File objects (drop zone). */
export async function addFiles(fileList, opts = {}) {
  const outDir = await ensureOutputDir(opts);
  if (!outDir) return [];
  const added = [];
  for (const f of fileList) {
    const name = f.name || 'dropped.bin';
    const it = {
      id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      src: name, srcKind: 'file', srcName: name, _fileObj: f,
      dest: joinPath(outDir, name),
      adapterId: opts.adapterId || guessAdapterFor(extOf(name)),
      status: 'queued', priority: opts.priority || 0,
      createdAt: Date.now(), bytesDone: 0, bytesTotal: 0,
      sizeBytes: f.size,
      args: opts.args || {},
    };
    queue.push(it);
    added.push(it);
  }
  persistQueue();
  renderQueueTableThrottled();
  return added;
}

function guessAdapterFor(ext) {
  const map = {
    json: 'json-to-yaml', jsonl: 'jsonl-to-json', yaml: 'yaml-to-json', yml: 'yaml-to-json',
    toml: 'toml-to-json', xml: 'xml-to-json', csv: 'csv-to-json', tsv: 'tsv-to-csv',
    md: 'md-to-html', markdown: 'md-to-html', html: 'html-to-text', htm: 'html-to-text',
    png: 'png-to-webp', jpg: 'png-to-jpeg', jpeg: 'png-to-jpeg', webp: 'webp-to-png',
    gif: 'gif-to-png', svg: 'svg-to-png', pdf: 'pdf-split', zip: 'zip-extract',
  };
  return map[ext] || (ext ? 'file-to-base64' : 'zip-create');
}

async function ensureOutputDir(opts) {
  const remembered = getSettingLocal('converter.rememberOutputDir', true)
    ? store.get('convertLastOutputDir', '') : '';
  const chosen = opts.outputDir || remembered;
  if (chosen) return chosen;
  const res = await invoke('dialog:open', { dir: true });
  const dir = Array.isArray(res) ? res[0] : null;
  if (!dir) {
    ui.toast?.({
      title: tt('Choose an output folder first', '請先揀輸出資料夾'),
      body: tt('Dropped files need somewhere to land; nothing was queued.', '拖入嚟嘅檔案要有地方放；未有嘢加入隊列。'),
      tone: 'info', timeoutMs: 7000,
    });
    return null;
  }
  store.set('convertLastOutputDir', dir);
  return dir;
}

function joinPath(dir, name) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function startQueue() {
  const pending = queue.filter((it) => it.status === 'queued');
  if (!pending.length) return Promise.resolve(false);
  return preflightBatch(pending).then(async (ok) => {
    if (!ok) {
      for (const it of pending) if (it.status === 'queued') it.status = 'paused';
      persistQueue();
      return false;
    }
    paused = false;
    pump();
    return true;
  });
}

export function pauseQueue() { paused = true; updateToolbarState(); }
export function resumeQueue() { paused = false; pump(); }
export function cancelItem(id) {
  const it = queue.find((q) => q.id === id);
  if (!it) return;
  if (it.status === 'running') {
    it.cancelRequested = true;
    invoke('converter:cancel', { jobId: it.jobId || it.id }).catch(() => {});
    it.status = 'cancelled';
  } else if (it.status === 'queued' || it.status === 'paused') {
    it.status = 'cancelled';
  }
  persistQueue();
  renderQueueTableThrottled();
  pump();
}
export function clearFinished() {
  queue = queue.filter((it) => !['done', 'skipped', 'cancelled', 'failed'].includes(it.status));
  persistQueue();
  renderQueueTable();
}

/* ------------------------------------------------------------------ */
/* Tab surface                                                         */
/* ------------------------------------------------------------------ */

let els = {};

function registerTab() {
  if (!P.router || typeof P.router.registerTab !== 'function') return;
  P.router.registerTab({
    id: 'converter',
    title: tt('Converter', '轉檔'),
    icon: '🔄',
    closable: true,
    group: 'tools',
    render(el) {
      el.append(buildConverterTab());
    },
  });
}

function buildConverterTab() {
  const wrap = ui.el('div', { class: 'mrb-converter-tab' });

  /* toolbar card */
  const card = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Converter', '轉檔') }));
  const pickFiles = ui.el('button', { class: 'mrb-btn mrb-btn-tonal', type: 'button', text: tt('Add files…', '加入檔案…') });
  pickFiles.addEventListener('click', async () => {
    const res = await invoke('dialog:open', { multi: true });
    if (Array.isArray(res) && res.length) await addPaths(res);
  });
  const pickFolder = ui.el('button', { class: 'mrb-btn mrb-btn-tonal', type: 'button', text: tt('Add folder (paged)…', '加入資料夾（分頁）…') });
  pickFolder.addEventListener('click', async () => {
    const res = await invoke('dialog:open', { dir: true });
    const dir = Array.isArray(res) ? res[0] : null;
    if (!dir) return;
    const expanded = await invoke('converter:expand', { path: dir, maxDepth: 8 });
    if (!expanded.ok) return;
    await addPaths(expanded.files.map((f) => f.path));
    if (expanded.truncated) {
      ui.toast?.({
        title: tt('Folder listing truncated', '資料夾清單被截斷'),
        body: tt('Depth is capped at 8 levels / 5000 files per batch.', '每批上限 8 層／5000 個檔案。'),
        tone: 'warn', timeoutMs: 8000,
      });
    }
  });

  const drop = ui.el('div', {
    class: 'mrb-converter-drop', role: 'button', tabindex: '0',
    'aria-label': tt('Drop files here to queue them', '將檔案拖到呢度加入隊列'),
  }, ui.el('span', { text: tt('Drop files here — they queue locally, nothing leaves this machine.', '拖檔案過嚟 — 全部喺本機處理，唔會離開部機。') }));
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('mrb-converter-drop-active'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('mrb-converter-drop-active'));
  drop.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    drop.classList.remove('mrb-converter-drop-active');
    const files = [...(ev.dataTransfer?.files || [])];
    if (files.length) await addFiles(files);
  });
  drop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      pickFiles.click();
    }
  });

  const convertBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Convert all', '全部轉換') });
  convertBtn.addEventListener('click', () => startQueue());
  const pauseBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Pause', '暫停') });
  pauseBtn.addEventListener('click', () => pauseQueue());
  const resumeBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Resume', '繼續') });
  resumeBtn.addEventListener('click', () => resumeQueue());
  const clearBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: tt('Clear finished', '清除完成項目') });
  clearBtn.addEventListener('click', () => clearFinished());
  const exportBtn = ui.el('button', { class: 'mrb-btn mrb-btn-outlined mrb-btn-sm', type: 'button', text: tt('Export report…', '匯出報告…') });
  exportBtn.addEventListener('click', () => exportReport());

  els.toolbarState = ui.el('span', { class: 'mrb-chip', 'aria-live': 'polite', text: tt('idle', '閒置') });

  card.append(
    ui.el('div', { class: 'mrb-converter-toolbar' }, pickFiles, pickFolder, convertBtn, pauseBtn, resumeBtn, clearBtn, exportBtn, els.toolbarState),
    drop,
  );
  wrap.append(card);

  /* queue table */
  els.queueWrap = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Queue', '隊列') }));
  wrap.append(els.queueWrap);
  renderQueueTable();

  /* catalog */
  const catCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Adapters', '轉檔器') }));
  const searchHost = ui.el('div', { class: 'mrb-converter-searchhost' });
  catCard.append(searchHost);
  els.catalogWrap = ui.el('div', { class: 'mrb-converter-catalog' });
  catCard.append(els.catalogWrap);
  wrap.append(catCard);
  buildCatalog(searchHost);

  updateToolbarState();
  return wrap;
}

function updateToolbarState() {
  if (!els.toolbarState) return;
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, skipped: 0, paused: 0 };
  for (const it of queue) counts[it.status] = (counts[it.status] || 0) + 1;
  const bits = [];
  if (counts.running) bits.push(`🏃 ${counts.running} ${tt('running', '進行中')}`);
  if (counts.queued) bits.push(`⏳ ${counts.queued} ${tt('queued', '排隊中')}`);
  if (counts.paused) bits.push(`⏸ ${counts.paused} ${tt('paused', '已暫停')}`);
  if (counts.done) bits.push(`✅ ${counts.done} ${tt('done', '完成')}`);
  if (counts.failed) bits.push(`❌ ${counts.failed} ${tt('failed', '失敗')}`);
  if (counts.skipped) bits.push(`⏭ ${counts.skipped} ${tt('skipped', '略過')}`);
  if (counts.cancelled) bits.push(`🚫 ${counts.cancelled} ${tt('cancelled', '已取消')}`);
  els.toolbarState.textContent = bits.join(' · ') || tt('queue empty', '隊列空');
}

let tableRenderTimer = null;
function renderQueueTableThrottled() {
  clearTimeout(tableRenderTimer);
  tableRenderTimer = setTimeout(renderQueueTable, 200);
}

function renderQueueTable() {
  if (!els.queueWrap) return;
  const old = els.queueWrap.querySelector('table, .mrb-cpk-empty');
  if (old) old.remove();
  if (!queue.length) {
    els.queueWrap.append(ui.el('p', {
      class: 'mrb-cpk-empty',
      text: tt('Nothing queued yet. Add files or drop them above — the queue survives restarts.', '仲未有嘢排隊。加檔案或拖上便 — 隊列會跨重啟保留。'),
    }));
    updateToolbarState();
    return;
  }
  const tbl = ui.el('table', { class: 'mrb-table mrb-converter-queue' });
  const tbody = ui.el('tbody');
  for (const it of queue) {
    const ad = adapterById(it.adapterId);
    const statusChip = ui.el('span', { class: 'mrb-chip', text: it.status });
    const prog = ui.el('progress', {
      class: 'mrb-progress-bar', max: '100',
      value: String(it.bytesTotal ? Math.min(100, Math.round((it.bytesDone / it.bytesTotal) * 100)) : it.status === 'done' ? 100 : 0),
      'aria-label': tt('Conversion progress', '轉換進度'),
    });
    const sel = ui.el('select', { class: 'mrb-select mrb-converter-adaptersel', 'aria-label': tt('Target adapter', '目標轉檔器') });
    const options = ADAPTERS.filter((a) => a.bundled && a.engine !== 'none' && adapterApplies(a, it));
    if (!options.some((o) => o.id === it.adapterId)) {
      sel.append(ui.el('option', { value: it.adapterId, text: `${it.adapterId} (unavailable)` }));
    }
    for (const o of options) sel.append(ui.el('option', { value: o.id, text: o.label }));
    sel.value = it.adapterId;
    sel.addEventListener('change', () => {
      it.adapterId = sel.value;
      /* keep the destination extension honest with the chosen target */
      const ad2 = adapterById(sel.value);
      if (ad2 && ad2.to && ad2.to !== '' && !it.dest.toLowerCase().endsWith('.' + ad2.to)) {
        const m2 = /^(.*?)(\.[^.]+)?$/.exec(it.dest);
        it.dest = `${m2[1]}.${ad2.to}`;
      }
      if (it.status === 'failed' || it.status === 'done' || it.status === 'cancelled') { it.status = 'queued'; it.error = ''; }
      persistQueue();
      renderQueueTableThrottled();
    });
    const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: '✕', 'aria-label': tt('Cancel item', '取消呢項') });
    cancelBtn.addEventListener('click', () => cancelItem(it.id));

    tbody.append(ui.el('tr', {},
      ui.el('td', { text: it.srcName }),
      ui.el('td', {}, sel),
      ui.el('td', { text: shortDest(it.dest) }),
      ui.el('td', {}, statusChip),
      ui.el('td', {}, prog),
      ui.el('td', { class: 'mrb-converter-error', text: it.error || (ad && ad.bundled === false ? ad.reason : '') }),
      ui.el('td', {}, cancelBtn)));
  }
  tbl.append(ui.el('thead', {}, ui.el('tr', {},
    ...['', tt('Adapter', '轉檔器'), tt('Destination', '目的地'), tt('Status', '狀態'), tt('Progress', '進度'), '', '']
      .map((h) => ui.el('th', { text: h })))), tbody);
  els.queueWrap.append(tbl);
  updateToolbarState();
}
function shortDest(p) {
  const parts = String(p).split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
}
function adapterApplies(a, it) {
  if (a.from.includes('*')) return true;
  const claimed = extOf(it.srcName || it.src || '');
  return a.from.includes(claimed) || (it.detectedExt && a.from.includes(it.detectedExt));
}

function buildCatalog(searchHost) {
  const input = ui.el('input', {
    class: 'mrb-field-input', type: 'search',
    placeholder: tt('Filter adapters…', '篩選轉檔器…'),
    'aria-label': tt('Filter adapters', '篩選轉檔器'),
  });
  searchHost.append(input);
  const renderCatalog = (query = '') => {
    if (!els.catalogWrap) return;
    els.catalogWrap.textContent = '';
    const q = query.trim().toLowerCase();
    const cats = [...new Set(ADAPTERS.map((a) => a.category))];
    for (const cat of cats) {
      const list = ADAPTERS.filter((a) => a.category === cat
        && (!q || a.label.toLowerCase().includes(q) || a.id.includes(q) || cat.toLowerCase().includes(q)));
      if (!list.length) continue;
      const group = ui.el('details', { class: 'mrb-converter-cat', open: !!q },
        ui.el('summary', { text: `${cat} (${list.filter((a) => a.bundled).length}/${list.length} ${tt('bundled', '內置')})` }));
      for (const a of list) {
        const row = ui.el('div', { class: `mrb-converter-adapter ${a.bundled ? '' : 'mrb-converter-adapter-disabled'}` });
        const title = ui.el('span', { class: 'mrb-converter-adapter-name', text: a.label });
        const chips = ui.el('span', { class: 'mrb-converter-adapter-meta' });
        chips.append(ui.el('span', { class: 'mrb-chip', text: a.bundled ? tt('bundled ✓', '內置 ✓') : tt('disabled ✗', '停用 ✗') }));
        chips.append(ui.el('span', { class: 'mrb-chip', text: `.${a.from.join('/.') || '*'} → .${a.to || '(info)'}` }));
        row.append(title, chips);
        if (!a.bundled) {
          row.title = a.reason || 'unavailable';
          row.append(ui.el('span', { class: 'mrb-converter-reason', text: a.reason || '' }));
        } else if (a.losses.length) {
          row.title = a.losses.join('\n');
          row.append(ui.el('span', { class: 'mrb-converter-losses', text: `ℹ ${a.losses[0]}${a.losses.length > 1 ? '…' : ''}` }));
        }
        group.append(row);
      }
      els.catalogWrap.append(group);
    }
  };
  renderCatalog('');

  /* regex builder attaches beside this search bar when the peer exists */
  if (P.regexbuilder && typeof P.regexbuilder.attachSearch === 'function') {
    P.regexbuilder.attachSearch(input, {
      onQuery: (q) => renderCatalog(q.text != null ? q.text : String(q)),
    });
  } else {
    input.addEventListener('input', () => renderCatalog(input.value));
  }
}

async function exportReport() {
  const rows = queue.map((it) => ({
    file: it.srcName,
    source: it.srcKind === 'file' ? '(dropped file)' : it.src,
    destination: it.dest,
    adapter: it.adapterId,
    status: it.status,
    error: it.error || '',
    bytes_done: it.bytesDone || 0,
  }));
  if (!rows.length) {
    ui.toast?.({ title: tt('Nothing to report yet', '仲未有報告'), tone: 'info', timeoutMs: 4000 });
    return;
  }
  if (P.exporter && typeof P.exporter.exportData === 'function') {
    await P.exporter.exportData({ name: 'conversion-report', rows, formats: ['csv', 'md'] });
    return;
  }
  /* fallback download keeps the contract even without the exporter peer */
  const csv = ['file,source,destination,adapter,status,error,bytes_done',
    ...rows.map((r) => [r.file, r.source, r.destination, r.adapter, r.status, r.error, r.bytes_done]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = ui.el('a', { href: url, download: 'conversion-report.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ */
/* settings defs                                                       */
/* ------------------------------------------------------------------ */

function registerSettingDefs() {
  if (!P.settings || typeof P.settings.register !== 'function') return;
  P.settings.register([
    {
      key: 'converter.concurrency', type: 'slider', def: 2, group: 'Converter', min: 1, max: 6, step: 1,
      label: { en: 'Parallel conversions', yue: '並行轉換數' },
      explain: { en: 'How many files convert at once. Higher is faster and hungrier.', yue: '同時轉幾多個檔案；愈高愈快亦更食資源。' },
    },
    {
      key: 'converter.overwritePolicy', type: 'select', def: 'suffix', group: 'Converter',
      label: { en: 'When the destination exists', yue: '目的地已有同名檔案時' },
      explain: { en: 'Auto-suffix renames (-1, -2…). Confirm asks with the destructive-action gate. Skip leaves the original untouched.', yue: '自動加後綴（-1、-2…）；確認會用破壞性動作閘門再問；略過就唔郁原本嗰個。' },
      options: [
        { value: 'suffix', label: { en: 'Auto-suffix', yue: '自動加後綴' } },
        { value: 'confirm', label: { en: 'Always confirm', yue: '每次確認' } },
        { value: 'skip', label: { en: 'Skip', yue: '略過' } },
      ],
    },
    {
      key: 'converter.imageQuality', type: 'slider', def: 0.92, group: 'Converter', min: 0.4, max: 1, step: 0.02,
      label: { en: 'Image quality (lossy targets)', yue: '圖片質素（有損格式）' },
      explain: { en: 'Applies to JPEG/WebP output only. PNG ignores it.', yue: '只影響 JPEG／WebP；PNG 唔理呢個值。' },
    },
    {
      key: 'converter.rememberOutputDir', type: 'toggle', def: true, group: 'Converter',
      label: { en: 'Remember output folder', yue: '記住輸出資料夾' },
      explain: { en: 'Keeps the last chosen folder for future batches. Turn off to pick one every time.', yue: '記住最後揀嘅資料夾，方便之後批次用；關閉就每次都問。' },
    },
  ]);
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

let unsubscribeProgress = null;

/** @returns {Promise<void>} */
export async function init() {
  ensureToolsStyles();
  P.settings = ((await peer('./settings.js')) || {}).settings || null;
  P.router = ((await peer('./router.js')) || {}).router || null;
  P.exporter = ((await peer('./exporter.js')) || {}).exporter || null;
  P.regexbuilder = await peer('./regexbuilder.js');

  try { registerSettingDefs(); } catch (_) { /* Settings surface optional */ }
  try { registerTab(); } catch (_) { /* router optional */ }
  try {
    const paletteM = await peer('./palette.js');
    if (paletteM && paletteM.palette && typeof paletteM.palette.register === 'function' && P.router) {
      paletteM.palette.register({
        id: 'converter.open', title: tt('Open Converter', '開啟轉檔'), group: tt('Tools', '工具'),
        action: () => P.router.navigate('converter'),
      });
    }
  } catch (_) { /* palette optional */ }

  if (window.mrb && typeof window.mrb.on === 'function') {
    unsubscribeProgress = window.mrb.on('convert:progress', (msg) => {
      for (const fn of progressSubs) fn(msg);
    });
  }
}
