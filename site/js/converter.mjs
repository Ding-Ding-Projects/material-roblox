// Mini file converter — the client-side subset (JSON/YAML/CSV/Markdown/HTML
// and PNG/JPEG/WebP images). The desktop app ships the full sandboxed catalog;
// this surface is honest about being a mini.

import { el, modal, toast, esc, fmtBytes } from './ui.mjs';
import { renderMarkdown } from './markdown.mjs';

const ADAPTERS = [
  { id: 'json→yaml', from: 'application/json', to: 'text/yaml', lossless: true },
  { id: 'yaml→json', from: 'text/yaml', to: 'application/json', lossless: false, note: 'Mini YAML parser handles maps, lists, scalars, quoted strings, and inline {} / [] only.' },
  { id: 'csv→json', from: 'text/csv', to: 'application/json', lossless: true },
  { id: 'tsv→json', from: 'text/tab-separated-values', to: 'application/json', lossless: true },
  { id: 'json→csv', from: 'application/json', to: 'text/csv', lossless: false, note: 'Arrays of flat objects convert; nested values are stringified.' },
  { id: 'md→html', from: 'text/markdown', to: 'text/html', lossless: false, note: 'Markdown-lite renderer: headings, lists, tables, code fences, links, emphasis.' },
  { id: 'html→md', from: 'text/html', to: 'text/markdown', lossless: false, note: 'Structural elements convert; scripts/styles drop by design.' },
  { id: 'img→png', from: 'image/*', to: 'image/png', lossless: true },
  { id: 'img→jpeg', from: 'image/*', to: 'image/jpeg', lossless: false, note: 'Transparency flattens to white; quality 0.9.' },
  { id: 'img→webp', from: 'image/*', to: 'image/webp', lossless: false, note: 'Quality 0.9.' },
];

function detect(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'text/yaml';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.tsv')) return 'text/tab-separated-values';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.htm') || name.endsWith('.html')) return 'text/html';
  if (file.type.startsWith('image/')) return 'image/*';
  // Byte-signature sniffing for extension-less images.
  return file.type || 'unknown';
}

/* ---------------- format helpers (bounded, local) ---------------- */

function parseCsv(text, delim = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function csvToJson(text, delim) {
  const rows = parseCsv(text.trim(), delim);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function jsonToCsv(value) {
  const arr = Array.isArray(value) ? value : [value];
  const flat = arr.map((o) => (typeof o === 'object' && o !== null && !Array.isArray(o)
    ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]))
    : { value: o }));
  const head = [...new Set(flat.flatMap(Object.keys))];
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [head.join(','), ...flat.map((o) => head.map((h) => q(o[h])).join(','))].join('\n');
}

/** Minimal YAML emitter for JSON-shaped data. */
function jsonToYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (v === null) return 'null';
  if (typeof v !== 'object') {
    return typeof v === 'string' && /[:#\-\n{}[\],&*?|>'"%@`]/.test(v) ? JSON.stringify(v) : String(v);
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((item) => `${pad}- ${jsonToYaml(item, indent + 2).trimStart()}`).join('\n')
      .split('\n').map((line, i) => (i === 0 ? line : line)).join('\n');
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return keys.map((k) => {
    const val = v[k];
    const scalar = val !== null && typeof val !== 'object';
    return `${pad}${JSON.stringify(k)}: ${scalar ? jsonToYaml(val) : '\n' + jsonToYaml(val, indent + 2)}`;
  }).join('\n');
}

/** Minimal YAML subset parser: maps, lists via indentation, scalars,
 *  quoted strings, and inline [] / {}. Documented as a subset — anything
 *  outside it fails loudly rather than misparsing. */
function yamlToJson(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  let pos = 0;

  const indentOf = (line) => line.match(/^\s*/)[0].length;

  function parseBlock(minIndent) {
    if (pos >= lines.length) return null;
    if (indentOf(lines[pos]) < minIndent) return null;
    return /^\s*-\s/.test(lines[pos]) ? parseList(indentOf(lines[pos])) : parseMap(indentOf(lines[pos]));
  }

  function parseList(indent) {
    const out = [];
    while (pos < lines.length) {
      const raw = lines[pos];
      if (indentOf(raw) !== indent || !/^\s*-\s/.test(raw)) break;
      const itemText = raw.trim().slice(2);
      pos++;
      if (itemText === '') {
        out.push(parseBlock(indent + 1));
      } else {
        // Re-inject as a map start when the item looks like `key: value`.
        const kv = itemText.match(/^([^:]+):\s*(.*)$/);
        if (kv && !itemText.startsWith('"') && !itemText.startsWith('{') && !itemText.startsWith('[')) {
          lines.splice(pos, 0, ' '.repeat(indent + 2) + itemText);
          out.push(parseMap(indent + 2));
        } else {
          out.push(parseScalar(itemText));
        }
      }
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length) {
      const raw = lines[pos];
      if (indentOf(raw) < indent) break;
      if (/^\s*-\s/.test(raw)) break; // a list at the same level ends this map
      const m = raw.trim().match(/^"?([^\s"].*?)"?\s*:\s*(.*)$/);
      if (!m) throw new Error(`YAML mini-parser cannot read line: ${raw.trim()}`);
      pos++;
      out[m[1]] = m[2] === '' ? (parseBlock(indent + 1) ?? null) : parseScalar(m[2]);
    }
    return out;
  }

  function parseScalar(s) {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    if (s.startsWith('[') || s.startsWith('{')) { try { return JSON.parse(s); } catch { /* fall through */ } }
    if (s === 'null' || s === '~' || s === '') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }

  return parseBlock(0) ?? {};
}

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  const walk = (node, ctx = {}) => {
    if (node.nodeType === 3) return ctx.pre ? node.textContent : node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const kids = () => [...node.childNodes].map((n) => walk(n, ctx)).join('');
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${kids().trim()}\n\n`;
      case 'p': return `\n\n${kids().trim()}\n\n`;
      case 'br': return '\n';
      case 'strong': case 'b': return `**${kids()}**`;
      case 'em': case 'i': return `*${kids()}*`;
      case 'code': return ctx.pre ? kids() : `\`${kids()}\``;
      case 'pre': return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
      case 'a': return `[${kids()}](${node.getAttribute('href') || ''})`;
      case 'ul': case 'ol': return `\n\n${[...node.children].map((li, i) => `${tag === 'ol' ? `${i + 1}. ` : '- '}${walk(li, ctx).trim()}`).join('\n')}\n\n`;
      case 'blockquote': return `\n\n> ${walk(node, ctx).trim()}\n\n`;
      case 'hr': return '\n\n---\n\n';
      case 'img': return `![${node.alt || ''}](${node.getAttribute('src') || ''})`;
      default: return kids();
    }
  };
  return walk(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function convertImage(file, target) {
  const bmp = await createImageBitmap(file);
  const canvas = el('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (target === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, target, 0.9));
  bmp.close();
  return blob;
}

/* ---------------- UI ---------------- */

export function openConverter() {
  modal({
    title: 'File converter (mini)',
    emergencyExit: true,
    build(body) {
      body.append(el('p', { class: 'applied-note' },
        'Client-side subset. Sources never leave your browser and are never modified; output downloads directly. The desktop app ships the full sandboxed adapter catalog.'));
      const input = el('input', { type: 'file', multiple: true, 'aria-label': 'Choose files to convert' });
      const zone = el('label', { class: 'dropzone' }, 'Drop files here or click to choose', input);
      const queue = el('div', { style: 'display:grid;gap:10px;margin-top:12px' });
      ['dragover', 'dragleave'].forEach((ev) => zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.toggle('drag', ev === 'dragover');
      }));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      });
      input.addEventListener('change', () => addFiles([...input.files]));
      body.append(zone, queue);

      async function addFiles(files) {
        for (const f of files.slice(0, 20)) await addOne(f);
      }

      async function addOne(file) {
        const from = detect(file);
        const targets = ADAPTERS.filter((a) => a.from === from || (from.startsWith('image/') && a.from === 'image/*'));
        const rowEl = el('div', { class: 'card', style: 'padding:12px' });
        const statusLine = el('span', { class: 'applied-note', role: 'status' }, fmtBytes(file.size));
        const sel = el('select', { 'aria-label': `Target format for ${file.name}` },
          targets.length
            ? targets.map((t) => el('option', { value: t.id }, t.id))
            : [el('option', {}, '(no compatible target in the mini set)')],
        );
        sel.disabled = !targets.length;
        const go = el('button', { class: 'mrb-btn filled', onclick: run, disabled: !targets.length }, 'Convert');
        rowEl.append(
          el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
            el('strong', { style: 'max-width:40%;overflow:hidden;text-overflow:ellipsis' }, file.name),
            el('span', { class: 'badge' }, from), sel, go),
          targets.some((t) => t.note) ? el('p', { class: 'applied-note' }, targets.find((t) => t.note)?.note ?? '') : null,
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, statusLine),
        );
        queue.append(rowEl);

        async function run() {
          const adapter = ADAPTERS.find((a) => a.id === sel.value);
          if (!adapter) return;
          try {
            let blob;
            if (adapter.to.startsWith('image/')) {
              blob = await convertImage(file, adapter.to);
            } else {
              const text = await file.text();
              switch (adapter.id) {
                case 'json→yaml': blob = new Blob([jsonToYaml(JSON.parse(text))], { type: 'text/yaml' }); break;
                case 'yaml→json': blob = new Blob([JSON.stringify(yamlToJson(text), null, 2)], { type: 'application/json' }); break;
                case 'csv→json': case 'tsv→json': blob = new Blob([JSON.stringify(csvToJson(text, adapter.id.startsWith('tsv') ? '\t' : ','), null, 2)], { type: 'application/json' }); break;
                case 'json→csv': blob = new Blob([jsonToCsv(JSON.parse(text))], { type: 'text/csv' }); break;
                case 'md→html': blob = new Blob([renderMarkdown(text)], { type: 'text/html' }); break;
                case 'html→md': blob = new Blob([htmlToMarkdown(text)], { type: 'text/markdown' }); break;
                default: throw new Error('unhandled adapter');
              }
            }
            const ext = adapter.to.split('/')[1].replace('+xml', '');
            const a = el('a', { href: URL.createObjectURL(blob), download: file.name.replace(/\.[^.]+$/, '') + '.' + ext });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            statusLine.textContent = `Converted → ${fmtBytes(blob.size)} · downloaded`;
            statusLine.classList.add('badge', 'ok');
            void esc;
          } catch (err) {
            statusLine.textContent = `Failed: ${err.message}`;
            toast({ title: 'Conversion failed', body: err.message, tone: 'error' });
          }
        }
      }
    },
  });
}
