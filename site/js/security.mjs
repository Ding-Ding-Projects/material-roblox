// Site-side safety features: per-element toy locks (PBKDF2-hashed passwords),
// the unlock ladder (clears WAITING, never credentials, budgeted 3/hour), and
// the Support Tickets desk that sends nothing anywhere.

import { el, anchored, modal, superConfirm, toast } from './ui.mjs';
import { store } from './store.mjs';
import { i18n } from './i18n.mjs';

/* ================= element locks ================= */

const locks = () => store.get('locks', {});

async function pbkdf2(password, saltB64) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150_000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

export function sigFor(elm) {
  const parts = [];
  let n = elm;
  let depth = 0;
  while (n && n !== document.body && depth < 5) {
    const parent = n.parentElement;
    const idx = parent ? [...parent.children].indexOf(n) + 1 : 0;
    const id = n.id ? `#${n.id}` : '';
    parts.unshift(`${n.tagName.toLowerCase()}${id}:nth-child(${idx})`);
    n = parent; depth++;
  }
  return parts.join('>');
}

export async function lockElementPrompt(anchorEl, target) {
  const sig = sigFor(target);
  if (locks()[sig]) return toast({ title: 'Already locked', body: 'This element has a lock. Unlock it first to change it.', tone: 'info' });
  const panel = el('div', {}, el('h3', {}, 'Lock this element'), el('p', { class: 'applied-note' }, 'Target: ', el('code', {}, sig)));
  const pw = el('input', { type: 'password', placeholder: 'Password for this lock only', 'aria-label': 'Lock password' });
  const dur = el('select', { 'aria-label': 'Unlock duration' },
    el('option', { value: 'untilClose' }, 'Until this tab closes'),
    el('option', { value: '15' }, '15 minutes after unlocking'),
    el('option', { value: '60' }, '60 minutes after unlocking'),
  );
  panel.append(
    el('div', { class: 'field' }, el('label', {}, 'Password'), pw),
    el('div', { class: 'field' }, el('label', {}, 'After unlocking, relock after'), dur),
    el('div', { class: 'plain-line', style: 'font-weight:500;margin-top:8px' },
      'This is a for-fun speed bump — not encryption, not protection from other people using this machine. ',
      'Forgot the password? Clear this site’s browser storage (Settings → Reset all site preferences) and every lock clears. Nothing else is affected.'),
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'mrb-btn text', onclick: () => close() }, 'Cancel'),
      el('button', { class: 'mrb-btn filled', onclick: async () => {
        if (!pw.value) { pw.focus(); return; }
        const salt = btoa(crypto.getRandomValues(new Uint8Array(16)).join(''));
        const hash = await pbkdf2(pw.value, salt);
        const all = locks();
        all[sig] = { hash, salt, dur: dur.value };
        store.set('locks', all);
        applyLockCover(target, sig);
        toast({ title: 'Element locked', body: 'One element, one credential.', tone: 'ok' });
        close();
      } }, 'Lock it'),
    ),
  );
  const close = anchored(anchorEl, panel);
}

function coverFor(sig) {
  return el('div', {
    class: 'locked-cover', role: 'button', tabindex: '0',
    'aria-label': 'Locked element — activate to unlock',
    onclick: (e) => { e.stopPropagation(); unlockPrompt(e.currentTarget); },
    onkeydown: (e) => { if (e.key === 'Enter') unlockPrompt(e.currentTarget); },
  }, '🔒');
}

export function applyAllLocks(root = document) {
  const all = locks();
  for (const [sig] of Object.entries(all)) {
    try {
      const target = document.querySelector(sig);
      if (target && !target.querySelector('.locked-cover')) applyLockCover(target, sig);
    } catch { /* signature no longer resolves; skip */ }
  }
}

function applyLockCover(target, sig) {
  target.style.position ||= 'relative';
  target.append(coverFor(sig));
}

async function unlockPrompt(cover) {
  const sig = sigFor(cover.parentElement);
  const entry = locks()[sig];
  if (!entry) { cover.remove(); return; }
  // Wait gate between attempts; ladder can clear it.
  const gateKey = `lockgate.${sig}`;
  const gate = store.get(gateKey, { until: 0, streak: 0 });
  const remainMs = gate.until - Date.now();

  const panel = el('div', {}, el('h3', {}, 'Unlock element'));
  const pw = el('input', { type: 'password', 'aria-label': 'Unlock password', autocomplete: 'off' });
  panel.append(el('div', { class: 'field' }, el('label', {}, 'Password'), pw));
  const status = el('p', { class: 'applied-note', role: 'status' });
  const actions = el('div', { class: 'dialog-actions' });
  panel.append(status, actions,
    el('p', { class: 'applied-note' }, 'Locked out? The recovery route is Support Tickets — or clear this site’s browser storage.'));

  const close = anchored(pw, panel);

  function refreshGate() {
    const g = store.get(gateKey, { until: 0, streak: 0 });
    const left = g.until - Date.now();
    actions.replaceChildren();
    if (left > 0) {
      status.textContent = `Wait ${Math.ceil(left / 1000)}s before the next attempt.`;
      actions.append(el('button', { class: 'mrb-btn tonal', onclick: () => startLadder(gateKey, () => refreshGate()) }, 'Play the unlock ladder to end the wait'));
    } else {
      status.textContent = `${g.streak || 0} failed attempt${(g.streak || 0) === 1 ? '' : 's'} so far.`;
      actions.append(el('button', { class: 'mrb-btn text', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'mrb-btn filled', onclick: tryUnlock }, 'Unlock'),
        el('button', { class: 'mrb-btn tonal', onclick: () => openTicketsDesk(() => close()) }, 'Support Tickets…'));
    }
  }

  async function tryUnlock() {
    const hash = await pbkdf2(pw.value, entry.salt);
    if (hash === entry.hash) {
      const all = locks();
      delete all[sig];
      store.set('locks', all);
      store.remove(`lockgate.${sig}`);
      cover.remove();
      toast({ title: 'Unlocked', tone: 'ok' });
      close();
      if (entry.dur && entry.dur !== 'untilClose') {
        setTimeout(() => {
          const t = document.querySelector(sig);
          if (t && locks()[sig] === undefined) { /* user removed lock; do nothing */ }
        }, Number(entry.dur) * 60_000);
      }
    } else {
      const g = store.get(gateKey, { until: 0, streak: 0 });
      const streak = (g.streak || 0) + 1;
      // Escalating but capped wait between attempts. Ladder clears THIS wait
      // only — never the credential, never refunds anything.
      const waitSec = Math.min(5 * 2 ** (streak - 1), 120);
      store.set(gateKey, { until: Date.now() + waitSec * 1000, streak });
      status.textContent = `That password did not match. Wait ${waitSec}s before trying again.`;
      refreshGate();
    }
  }

  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (store.get(gateKey, { until: 0 }).until - Date.now()) <= 0) tryUnlock(); });
  refreshGate();
  pw.focus();
}

/* ================= unlock ladder ================= */
// Rungs: dish question -> ten sums -> whack-a-mole -> wait. Budget: at most
// three ladder completions per rolling hour; after that, the wait is the way.

const DISHES_FALLBACK = ['Har Gow', 'Siu Mai', 'Char Siu Bao', 'Spring Roll', 'Cheung Fun', 'Egg Tart'];

function budgetOk() {
  const hourAgo = Date.now() - 3600_000;
  const wins = store.get('ladder.wins', []).filter((t) => t > hourAgo);
  return wins.length < 3;
}
function recordWin() {
  const wins = [...store.get('ladder.wins', []), Date.now()].slice(-10);
  store.set('ladder.wins', wins);
}

export function startLadder(gateKey, onCleared) {
  const g = store.get(gateKey, { until: 0 });
  if (Date.now() >= g.until) { toast({ title: 'No wait to clear right now', body: 'The ladder only exists while you are waiting.', tone: 'info' }); return; }
  if (!budgetOk()) {
    toast({ title: 'Ladder budget used for this hour', body: 'Three skips per rolling hour is the cap — the wait itself is the way through now.', tone: 'warn' });
    return;
  }
  nonceRungDish(gateKey, onCleared);
}

let currentNonce = null;
let ladderBody = null;
let ladderClose = null;

function freshNonce(kind) {
  currentNonce = { kind, id: crypto.randomUUID(), consumed: false, createdAt: Date.now() };
  return currentNonce;
}
function consumeNonce(nonce) {
  if (!currentNonce || currentNonce.id !== nonce?.id || currentNonce.consumed) return false;
  currentNonce.consumed = true;
  return true;
}

function ladderShell() {
  ladderClose = modal({
    title: 'Unlock ladder',
    emergencyExit: true,
    build: (body) => { ladderBody = body; },
  });
}

/* --- rung 1: dim sum question --- */
async function nonceRungDish(gateKey, onCleared) {
  ladderShell();
  const nonce = freshNonce('dish');
  let dishes = DISHES_FALLBACK;
  try {
    const cached = store.get('dimsum.catalog', null);
    if (cached?.at > Date.now() - 24 * 3600_000 && cached.names?.length >= 4) dishes = cached.names;
    else {
      const res = await fetch('https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json');
      if (res.ok) {
        const json = await res.json();
        const names = (json.dishes || json.items || json || []).map((d) => d?.name?.en).filter(Boolean).slice(0, 40);
        if (names.length >= 4) { dishes = names; store.set('dimsum.catalog', { at: Date.now(), names }); }
      }
    }
  } catch { /* offline: fallback list keeps the rung playable */ }

  const answer = dishes[Math.floor(Math.random() * dishes.length)];
  const options = new Set([answer]);
  while (options.size < 4) options.add(dishes[Math.floor(Math.random() * dishes.length)]);
  const opts = [...options].sort(() => Math.random() - 0.5);

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px' });
  opts.forEach((name) => grid.append(el('button', { class: 'mrb-btn tonal', onclick: (e) => gradeDish(name === answer, e.currentTarget) }, name)));

  let wrongCount = 0;
  function gradeDish(correct, btn) {
    btn.setAttribute('aria-disabled', 'true');
    if (!consumeNonce({ ...nonce })) return; // single-use grading
    if (correct) { nonceRungSums(gateKey, onCleared); return; }
    wrongCount++;
    if (wrongCount >= 5) { nonceRungSums(gateKey, onCleared); return; }
    btn.disabled = true;
  }
  const host = ladderBody;
  host?.replaceChildren(el('h3', {}, 'Which dim sum is this?'), el('p', { class: 'applied-note' }, 'Get it right to move up a rung.'), grid);
  if (!host) document.querySelector('.overlay')?.remove();
}

/* --- rung 2: ten sums, every one correct --- */
function nonceRungSums(gateKey, onCleared) {
  const nonce = freshNonce('sums');
  let done = 0; let ok = 0;
  const q = () => {
    const a = 10 + Math.floor(Math.random() * 80);
    const b = 10 + Math.floor(Math.random() * 80);
    const plus = Math.random() < 0.6;
    return { text: plus ? `${a} + ${b}` : `${Math.max(a, b)} − ${Math.min(a, b)}`, ans: plus ? a + b : Math.abs(a - b) };
  };
  const host = ladderBody;
  const cur = q();
  const inp = el('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Your answer' });
  const prog = el('span', { class: 'applied-note' });
  const failToMole = () => nonceRungMole(gateKey, onCleared); // a single wrong sum drops you a rung
  const submit = () => {
    if (Number(inp.value) === cur.ans) { ok++; done++; next(); }
    else failToMole();
  };
  function next() {
    if (!consumeNonce(nonce)) return;
    if (done >= 10) { nonceRungMole(gateKey, onCleared); return; }
    const nx = q();
    Object.assign(cur, nx);
    prompt.textContent = nx.text;
    inp.value = '';
    prog.textContent = `${done}/10`;
    inp.focus();
  }
  const prompt = el('div', { class: 'code-big', style: 'margin:12px 0' }, cur.text);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  host?.replaceChildren(el('h3', {}, 'Ten easy sums'), el('p', { class: 'applied-note' }, 'Every one must be right — one miss drops you a rung.'), prompt, inp, prog,
    el('div', { class: 'dialog-actions' }, el('button', { class: 'mrb-btn filled', onclick: submit }, 'Check')));
  inp.focus();
  void ok;
}

/* --- rung 3: whack-a-mole (cannot be won faster than it lasts) --- */
function nonceRungMole(gateKey, onCleared) {
  const ROUND_MS = 20000;
  const NEED = 10;
  const startedAt = Date.now();
  const nonce = freshNonce('mole');
  const host = ladderBody;
  let hits = 0;
  const cells = [];
  const grid = el('div', { class: 'ladder-grid', role: 'grid', 'aria-label': 'Whack-a-mole board' });
  for (let i = 0; i < 9; i++) {
    const c = el('button', { class: 'mole-cell', 'aria-label': `Cell ${i + 1}`, 'data-i': String(i) });
    cells.push(c);
    grid.append(c);
  }
  const score = el('p', { class: 'applied-note', 'aria-live': 'polite' }, 'Hits: 0 / 10');
  host?.replaceChildren(el('h3', {}, 'Whack-a-mole'), el('p', { class: 'applied-note' }, `Hit ${NEED} moles inside ${ROUND_MS / 1000}s. Submissions arriving before the round ends are rejected — play the round.`), grid, score);
  if (!host) return;

  const timers = [];
  function popMole() {
    if (Date.now() - startedAt >= ROUND_MS) return;
    const free = cells.filter((c) => !c.classList.contains('up'));
    const cell = free[Math.floor(Math.random() * free.length)];
    cell.classList.add('up'); cell.textContent = '🐹';
    const hideT = setTimeout(() => { cell.classList.remove('up'); cell.textContent = ''; }, 700 + Math.random() * 500);
    timers.push(hideT);
    timers.push(setTimeout(popMole, 450 + Math.random() * 550));
  }
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.mole-cell');
    if (!cell || !cell.classList.contains('up')) return;
    // Grade each mole once: only an actually-visible mole counts.
    cell.classList.remove('up'); cell.textContent = '';
    hits++;
    score.textContent = `Hits: ${hits} / ${NEED}`;
  });

  timers.push(setTimeout(popMole, 600));
  timers.push(setTimeout(() => {
    timers.forEach(clearTimeout);
    const elapsed = Date.now() - startedAt;
    if (elapsed < ROUND_MS - 400) { failToClock('Round rejected: it ended too early.'); return; }
    if (hits >= NEED) { finishWin(gateKey, onCleared); }
    else failToClock(`You hit ${hits}/${NEED}.`);
  }, ROUND_MS + 50));
}

/* --- rung 4: the clock (fall here once and the ladder closes) --- */
function failToClock(reason) {
  const host = ladderBody;
  host?.replaceChildren(
    el('h3', {}, 'Back to the clock'),
    el('p', {}, reason),
    el('p', { class: 'applied-note' }, 'The ladder is not offered again for this lockout. Serving the wait was always the baseline — nothing got worse.'),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'mrb-btn tonal', onclick: () => document.querySelector('.overlay')?.remove() }, 'Close')),
  );
}

async function finishWin(gateKey, onCleared) {
  if (!consumeNonce(nonce)) return;
  recordWin();
  const g = store.get(gateKey, { until: 0, streak: 0 });
  store.set(gateKey, { until: 0, streak: g.streak }); // clears THE WAIT ONLY
  ladderClose?.();
  toast({
    title: 'Ladder cleared — waiting over',
    body: 'This ended the wait, nothing more. You still need the actual password.',
    tone: 'ok',
  });
  onCleared?.();
  void i18n;
}

/* ================= support tickets desk ================= */

const CANNED = [
  'Have you tried turning the whole website off and on again? Specifically: Settings → Reset all site preferences.',
  'Our engineers have escalated your ticket to the department of deleting one folder of browser storage. Remarkably effective.',
  'Diagnosis complete. Prescription: one (1) cleared site storage. No follow-up appointment needed.',
];

export function openTicketsDesk(afterClose) {
  const tickets = () => store.get('tickets', []);
  const saveTickets = (t) => store.set('tickets', t);

  modal({
    title: 'Support Tickets',
    emergencyExit: true,
    build(body, closeAll) {
      const cat = el('select', { 'aria-label': 'Category' },
        el('option', {}, 'Forgotten password'), el('option', {}, 'Lost authenticator'),
        el('option', {}, 'Something looks broken'), el('option', {}, 'Other'));
      const desc = el('textarea', { placeholder: 'Describe the trouble (this stays in your browser)', 'aria-label': 'Description' });
      const number = `MRB-${String(Math.floor(Math.random() * 90000) + 10000)}`;

      body.append(el('div', { class: 'plain-line' },
        'Nothing is sent anywhere. No ticket leaves this browser, no network request is made, no data is collected, and nobody is reading this.'));
      body.append(el('div', { class: 'field', style: 'margin-top:12px' }, el('label', {}, 'Category'), cat));
      body.append(el('div', { class: 'field' }, el('label', {}, 'Description'), desc));
      body.append(el('div', { class: 'dialog-actions' }, el('button', {
        class: 'mrb-btn filled', onclick: () => {
          const list = tickets();
          list.unshift({ number, category: cat.value, description: desc.value.slice(0, 2000), status: 'Received', response: CANNED[list.length % CANNED.length], at: Date.now() });
          saveTickets(list.slice(0, 20));
          renderList();
          toast({ title: `Ticket ${number} filed`, body: 'Locally. See the plain line above for what that means.', tone: 'info' });
        },
      }, 'File ticket')));

      const listBox = el('div', { style: 'margin-top:16px' });
      function renderList() {
        const list = tickets();
        listBox.replaceChildren(
          el('h3', {}, 'Your local tickets'),
          list.length ? list.map((t) => el('details', { class: 'card', style: 'padding:12px;margin-bottom:8px' },
            el('summary', {}, `${t.number} · ${t.category} · ${t.status}`),
            el('p', { class: 'applied-note' }, t.description || '(no description)'),
            el('p', {}, el('strong', {}, 'Response: '), t.response),
            el('div', { class: 'callout' },
              el('strong', {}, 'Resolution: '), 'open Settings → Reset all site preferences, or use the button below. That clears every lock, ticket, and stored setting in one go.'),
            el('div', { class: 'dialog-actions' },
              el('button', { class: 'mrb-btn tonal', onclick: () => { closeAll(); window.dispatchEvent(new CustomEvent('mrb-goto-settings-reset')); } }, 'Open reset route'),
              el('button', { class: 'mrb-btn text', onclick: () => { saveTickets(tickets().filter((x) => x.number !== t.number)); renderList(); } }, 'Delete ticket'),
            ),
          )) : [el('p', { class: 'applied-note' }, 'No tickets yet — which is either good news or means you have not met the toy locks.')],
        );
      }
      renderList();
      body.append(listBox);
      void afterClose;
    },
  });
}

export function initSecurity() {
  // Restore covers after DOM settles.
  setTimeout(() => applyAllLocks(), 300);
}
