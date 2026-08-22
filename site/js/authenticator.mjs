// Built-in authenticator: RFC 6238 TOTP over WebCrypto HMAC (SHA1/256/512,
// 6/8 digits, arbitrary period), otpauth:// URI import, QR pairing drawn by
// the embedded encoder, live codes with countdown and next-code peek.
//
// Honest storage note: a website cannot reach the OS credential vault. Entries
// default to session-only storage; persistent storage is an explicit opt-in
// and the UI says plainly that browser storage is not vault-grade.

import { el, modal, toast } from './ui.mjs';
import { store } from './store.mjs';
import { drawQr } from './qr.mjs';

/* ---------------- base32 ---------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function groupSecret(b32) {
  return b32.replace(/(.{4})/g, '$1 ').trim();
}

/* ---------------- TOTP ---------------- */

const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

async function hotp(secretBytes, algo, digits, counter) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: ALGOS[algo] }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(4, counter >>> 0);          // low word
  view.setUint32(0, Math.floor(counter / 2 ** 32)); // high word
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const code = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

async function totp(entry, at = Date.now()) {
  const counter = Math.floor(at / 1000 / entry.period);
  const code = await hotp(entry.secretBytes, entry.algo, entry.digits, counter);
  const nextCode = await hotp(entry.secretBytes, entry.algo, entry.digits, counter + 1);
  const secondsLeft = entry.period - Math.floor(at / 1000) % entry.period;
  return { code, nextCode, secondsLeft };
}

function parseOtpauth(uri) {
  let u;
  try { u = new URL(uri); } catch { throw new Error('Not a URL.'); }
  if (u.protocol !== 'otpauth:') throw new Error('Expected an otpauth:// URI.');
  const label = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const [issuerFromLabel, account] = label.includes(':') ? label.split(/:(.+)/) : ['', label];
  const q = u.searchParams;
  const secretB32 = q.get('secret');
  if (!secretB32) throw new Error('URI carries no secret.');
  return {
    issuer: q.get('issuer') || issuerFromLabel || 'Material Roblox',
    account: account || 'account',
    secretBytes: base32Decode(secretB32),
    secretB32: base32Encode(base32Decode(secretB32)),
    algo: (q.get('algorithm') || 'SHA1').toUpperCase(),
    digits: Number(q.get('digits') || 6),
    period: Number(q.get('period') || 30),
  };
}

/* ---------------- entries store ---------------- */
// Persistent opt-in only; default is sessionStorage so closing the tab clears
// everything — the honest default given browser storage is not vault-grade.

const PERSIST_KEY = 'auth.entries';
let memEntries = null;

function load() {
  if (memEntries) return memEntries;
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY) ?? localStorage.getItem(PERSIST_KEY);
    memEntries = raw ? JSON.parse(raw) : [];
  } catch { memEntries = []; }
  return memEntries;
}
function save(entries) {
  memEntries = entries;
  const json = JSON.stringify(entries);
  try {
    if (store.get('auth.persist', false)) localStorage.setItem(PERSIST_KEY, json);
    else sessionStorage.setItem(PERSIST_KEY, json);
  } catch { /* blocked storage: entries stay in memory for this page */ }
}

/* ---------------- panel ---------------- */

export function openAuthenticator() {
  modal({
    title: 'Authenticator',
    emergencyExit: true,
    build(body) {
      const searchIn = el('input', { type: 'search', placeholder: 'Search entries…', 'aria-label': 'Search entries' });
      const listWrap = el('div', { style: 'display:grid;gap:12px;margin-top:12px' });
      const uriIn = el('input', { type: 'text', placeholder: 'otpauth://totp/…', 'aria-label': 'otpauth URI' });

      body.append(
        el('p', { class: 'plain-line', style: 'font-weight:500' },
          'Local-only. Nothing syncs, nothing leaves this browser. Site storage is not vault-grade — keep production secrets in the desktop app.'),
        el('div', { class: 'field' }, el('label', {}, 'Import via otpauth URI'), uriIn),
        el('div', { class: 'dialog-actions', style: 'justify-content:flex-start' },
          el('button', { class: 'mrb-btn tonal', onclick: () => importUri() }, 'Import URI'),
          el('button', { class: 'mrb-btn text', onclick: () => manualEntry() }, 'Manual entry…'),
        ),
        searchIn,
        listWrap,
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'mrb-btn text', onclick: exportEntries }, 'Export (omits secrets)'),
          persistToggle(),
        ),
      );

      function persistToggle() {
        const c = el('input', { type: 'checkbox' });
        c.checked = store.get('auth.persist', false);
        c.addEventListener('change', () => {
          store.set('auth.persist', c.checked);
          toast({
            title: c.checked ? 'Persistent storage on' : 'Session-only storage',
            body: c.checked
              ? 'Entries survive reload in this browser profile. Clearing site storage removes them.'
              : 'Entries vanish when this tab closes.',
            tone: c.checked ? 'warn' : 'info',
          });
          save(load());
        });
        return el('label', { style: 'display:inline-flex;gap:8px;align-items:center;font-size:.85em' }, c, 'Keep entries after this tab closes');
      }

      async function importUri() {
        try {
          const e = parseOtpauth(uriIn.value.trim());
          await pairConfirm(e);
        } catch (err) {
          toast({ title: 'Could not import', body: err.message, tone: 'error' });
        }
      }

      function manualEntry() {
        const name = el('input', { type: 'text', placeholder: 'Issuer: account' });
        const secret = el('input', { type: 'text', placeholder: 'Base32 secret' });
        const algoSel = el('select', {}, Object.keys(ALGOS).map((a) => el('option', { value: a }, a)));
        const digSel = el('select', {}, [6, 8].map((d) => el('option', { value: d }, `${d} digits`)));
        const perIn = el('input', { type: 'number', value: 30, min: 15, max: 120 });
        const box = el('div', {},
          el('div', { class: 'field' }, el('label', {}, 'Name'), name),
          el('div', { class: 'field' }, el('label', {}, 'Base32 secret'), secret),
          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            el('div', { class: 'field' }, el('label', {}, 'Algorithm'), algoSel),
            el('div', { class: 'field' }, el('label', {}, 'Digits'), digSel),
            el('div', { class: 'field' }, el('label', {}, 'Period (s)'), perIn)),
        );
        modal({
          title: 'Manual entry',
          build: (b) => b.append(box),
          actions: [{ label: 'Cancel' }, {
            label: 'Continue to pairing', kind: 'filled', action: () => {
              try {
                const bytes = base32Decode(secret.value);
                void name.value;
                pairConfirm({ issuer: 'Material Roblox', account: name.value || 'account', secretBytes: bytes, secretB32: base32Encode(bytes), algo: algoSel.value, digits: Number(digSel.value), period: Number(perIn.value) });
              } catch (err) { toast({ title: 'Invalid secret', body: err.message, tone: 'error' }); }
            },
          }],
        });
      }

      /** Confirm-before-arm: one current code must match or nothing saves. */
      async function pairConfirm(entry) {
        const qrCanvas = el('canvas', { 'aria-label': `QR pairing code for ${entry.issuer}` });
        const uri = buildUri(entry);
        try { drawQr(qrCanvas, uri, 5); } catch { qrCanvas.hidden = true; }
        const reveal = el('details', {}, el('summary', {}, 'Show manual secret'), el('code', { style: 'word-break:break-all;display:block;padding:8px' }, groupSecret(entry.secretB32)));
        const codeIn = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'current code', 'aria-label': 'Enter current code to confirm pairing', maxlength: 8 });
        const params = el('p', { class: 'applied-note' }, `${entry.algo} · ${entry.digits} digits · every ${entry.period}s`);
        const host = document.querySelector('.overlay .dialog');
        host?.replaceChildren(
          el('h2', {}, 'Confirm pairing'),
          el('p', { class: 'applied-note' }, 'Scan with your authenticator app, then type back one current code. Registration arms only after it matches.'),
          qrCanvas, reveal, params,
          el('div', { class: 'field', style: 'margin-top:10px' }, el('label', {}, 'Current code'), codeIn),
          el('div', { class: 'dialog-actions' },
            el('button', { class: 'mrb-btn text', onclick: () => openAuthenticator() }, 'Cancel'),
            el('button', { class: 'mrb-btn filled', onclick: async () => {
              const t = await totp(entry);
              if (t.code === codeIn.value.trim()) {
                const entries = load();
                entries.push({ ...entry, id: crypto.randomUUID(), secretBytes: [...entry.secretBytes] });
                save(entries);
                toast({ title: 'Pairing confirmed', body: `${entry.issuer} armed.`, tone: 'ok' });
                openAuthenticator();
              } else {
                toast({ title: 'Code did not match', body: 'Nothing was saved — check the clock and scan again.', tone: 'warn' });
              }
            } }, 'Confirm'),
          ),
        );
      }

      function buildUri(e) {
        const label = encodeURIComponent(`${e.issuer}: ${e.account}`);
        return `otpauth://totp/${label}?secret=${e.secretB32}&issuer=${encodeURIComponent(e.issuer)}&algorithm=${e.algo}&digits=${e.digits}&period=${e.period}`;
      }

      async function renderList() {
        const q = searchIn.value.trim().toLowerCase();
        const entries = load().filter((e) => !q || `${e.issuer} ${e.account}`.toLowerCase().includes(q));
        listWrap.replaceChildren(
          ...(entries.length ? entries.map((entry) => cardFor(entry)) : [el('p', { class: 'applied-note' }, 'No entries yet — import an otpauth URI or add one manually.')]),
        );
        tickAll();
      }
      searchIn.addEventListener('input', debounceRender);

      let debTimer;
      function debounceRender() { clearTimeout(debTimer); debTimer = setTimeout(renderList, 150); }

      const cards = new Map();
      function cardFor(entry) {
        entry.secretBytes = Uint8Array.from(entry.secretBytes);
        const codeEl = el('div', { class: 'code-big', role: 'timer', 'aria-live': 'off' }, '······');
        const countEl = el('span', { class: 'countdown applied-note' });
        const peekEl = el('span', { class: 'applied-note' });
        const copyBtn = el('button', { class: 'mrb-btn text', onclick: async () => { const t = await totp(entry); navigator.clipboard?.writeText(t.code); } }, 'Copy');
        const delBtn = el('button', { class: 'mrb-btn danger', onclick: () => {
          save(load().filter((x) => x.id !== entry.id));
          renderList();
          toast({ title: 'Entry removed', tone: 'info' });
        } }, 'Remove');
        const card = el('div', { class: 'card', style: 'padding:14px' },
          el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
            el('div', { style: 'flex:1 1 160px' },
              el('strong', {}, entry.issuer), el('div', { class: 'applied-note' }, entry.account)),
            codeEl, copyBtn, delBtn),
          el('div', { style: 'display:flex;gap:12px;align-items:center' }, countEl, peekEl),
        );
        cards.set(entry.id, { entry, codeEl, countEl, peekEl });
        return card;
      }

      async function tickAll() {
        for (const [, c] of cards) {
          const t = await totp(c.entry);
          c.codeEl.textContent = t.code.replace(/(\d{3})(?=\d)/, '$1 ');
          c.countEl.textContent = `${t.secondsLeft}s`;
          c.peekEl.textContent = `next: ${t.nextCode}`;
        }
      }
      const iv = setInterval(() => { if (!document.body.contains(listWrap)) clearInterval(iv); else tickAll(); }, 1000);

      function exportEntries() {
        // Ordinary export OMITS secrets — and says so right here.
        const data = load().map(({ secretBytes, secretB32, ...rest }) => { void secretBytes; void secretB32; return rest; });
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), secretsIncluded: false, note: 'Secrets are deliberately omitted from ordinary exports.', entries: data }, null, 2)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: 'material-roblox-authenticator.json' });
        a.click();
        URL.revokeObjectURL(a.href);
        toast({ title: 'Exported without secrets', body: 'The file states the omission itself.', tone: 'ok' });
      }

      renderList();
    },
  });
}
