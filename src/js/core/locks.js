'use strict';

/**
 * Toy locks — a user-experience speed bump, deliberately NOT a security
 * boundary. Every fact below is stated to the user inside the product too:
 *  - Locks are for fun. They do not encrypt anything and they do not protect
 *    data; deleting this app's data folder removes every lock at once, and
 *    the UI names that folder verbatim wherever it matters.
 *  - EVERY lock carries its OWN credential. No master password exists, no
 *    implicit inheritance between elements, tabs, groups or properties.
 *  - Passwords are hashed in the MAIN process (PBKDF2-SHA-256, per-lock
 *    random salt, ≥210k iterations) and only the hash parameters persist, in
 *    the OS-backed encrypted vault under the service name "locks".
 *  - Wrong attempts get honest, rate-limited feedback and never wipe content.
 *    Repeated failures impose an escalating wait, during which the unlock
 *    ladder may end the WAIT early — never the credential check itself, and
 *    never by refunding attempts.
 *
 * Cross-lane contracts implemented here (documented for their owners):
 *  - Appearance modules MUST consult vetoPropertyChange(elementPath, prop)
 *    BEFORE applying an override, or dispatch
 *    'mrb-appearance-prop-change' {elementPath, prop, veto(fn)} and honor the
 *    callback result.
 *  - The router SHOULD dispatch 'mrb-tab-render-gate' {tabId, respond(promise)}
 *    before rendering a tab; this module answers respond(Promise<boolean>)
 *    and blocks rendering of locked tabs until unlocked.
 *  - Search surfaces SHOULD append decorateSearchResult(targetId) to results;
 *    locked items stay visible and searchable, labelled with a lock marker.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

const LOCKS_KEY = 'mrb:locks';
const TICKETS_KEY = 'mrb:supportTickets';
/** Rolling backoff (seconds) applied after each wrong attempt. */
const ATTEMPT_BACKOFF_S = [1, 2, 4, 8, 10];
/** Escalating full waits (ms) once repeated failures accumulate. */
const WAIT_LADDER_MS = [10000, 30000, 90000, 180000, 300000];

let routerMod = null;
let paletteMod = null;
let settingsMod = null;
let exporterMod = null;
let regexbuilderMod = null;

/** @type {Array<any>} */
let locks = [];
/** @type {Map<string,{until:number}>} targetId -> runtime unlock window */
const unlockedUntil = new Map();
/** @type {Map<string,{count:number}>} targetId -> consecutive wrong attempts */
const failureCounts = new Map();
/** @type {Map<string,number>} targetId -> wait end timestamp */
const activeWaits = new Map();
/** @type {Map<string,boolean>} targetId -> ladder already used for THIS wait */
const ladderUsedForWait = new Map();

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
// Registry
// ---------------------------------------------------------------------------

export function loadLocks() {
  const raw = store.get(LOCKS_KEY, []);
  locks = Array.isArray(raw)
    ? raw.filter((l) => l && typeof l.lockId === 'string' && typeof l.targetId === 'string')
    : [];
  return locks;
}

/** Alias kept for sibling-lane readability. */
export const listLocks = () => locks.slice();

function saveLocks() {
  // credRef strings only — no password material, no hashes, no seeds here.
  store.set(LOCKS_KEY, locks);
}

function announceChanged() {
  window.dispatchEvent(new CustomEvent('mrb-locks-changed'));
}

function newLockId(prefix = 'lk') {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return `${prefix}:${[...buf].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function findLock(targetId) {
  return locks.find((l) => l.targetId === targetId) || null;
}

function runtimeValid(targetId) {
  const rec = unlockedUntil.get(targetId);
  if (!rec) return false;
  if (rec.until === Infinity) return true;
  return Date.now() < rec.until;
}

/** True when a lock exists for the target AND it is currently engaged. */
export function isLocked(targetId) {
  return !!findLock(targetId) && !runtimeValid(targetId);
}

/**
 * Search-decoration hook: consumers append this to result labels so LOCKED
 * items remain fully visible in every search surface, marked rather than
 * hidden. Empty string when the target is not currently locked.
 */
export function decorateSearchResult(targetId) {
  return isLocked(targetId) ? ' · 🔒' : '';
}

/**
 * Appearance-property veto contract (see file header). Returns true when the
 * change must be BLOCKED because the property or its owning element is locked.
 * @param {string} elementPath
 * @param {string} prop
 */
export function vetoPropertyChange(elementPath, prop) {
  const elementScope = `appearance:${elementPath}`;
  const propertyScope = `appearance:${elementPath}:${prop}`;
  return isLocked(propertyScope) || isLocked(elementScope);
}

function applyDuration(targetId, lock) {
  const mode = lock.unlockDuration && lock.unlockDuration.mode ? lock.unlockDuration.mode : 'launch';
  if (mode === 'minutes') {
    const ms = Math.max(1, Number(lock.unlockDuration.minutes) || 15) * 60000;
    unlockedUntil.set(targetId, { until: Date.now() + ms });
  } else if (mode === 'session' || mode === 'surface') {
    unlockedUntil.set(targetId, { until: Infinity });
    if (mode === 'surface') markSurfaceScoped(targetId);
  } else {
    // 'launch': stays unlocked until the app restarts, then locks on launch.
    unlockedUntil.set(targetId, { until: Infinity });
  }
}

/** @type {Set<string>} */
const surfaceScoped = new Set();
function markSurfaceScoped(targetId) {
  surfaceScoped.add(targetId);
}
window.addEventListener('mrb-route-changed', () => {
  // Surface-scoped unlocks end at navigation.
  for (const id of [...surfaceScoped]) unlockedUntil.delete(id);
  surfaceScoped.clear();
});

/** Re-engage a lock immediately. */
export function lockAgain(targetId) {
  unlockedUntil.delete(targetId);
  surfaceScoped.delete(targetId);
  announceChanged();
}

async function verifyCredential(lock, credential) {
  if (lock.method === 'totp') {
    const res = await ipc('totp:verify', { entryId: lock.credRef, code: String(credential || ''), window: 1 });
    return !!(res && res.ok && res.match);
  }
  let rec = null;
  try {
    const raw = await ipc('vault:get', { service: 'locks', key: `hash:${lock.lockId}` });
    rec = raw && typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return false;
  }
  if (!rec || typeof rec.saltB64 !== 'string') return false;
  try {
    const res = await ipc('pwhash:verify', {
      password: String(credential == null ? '' : credential),
      saltB64: rec.saltB64,
      iter: rec.iter,
      hashB64: rec.hashB64,
    });
    return !!(res && res.ok && res.match);
  } catch {
    return false;
  }
}

/**
 * Verify a candidate credential WITHOUT opening any UI. Resolves true only on
 * a genuine match; never refunds attempts and never bypasses the wait.
 */
export async function unlock(targetId, credential) {
  const lock = findLock(targetId);
  if (!lock) return true;
  const wait = activeWaits.get(targetId);
  if (wait && Date.now() < wait) return false; // waiting out an escalation
  const ok = await verifyCredential(lock, credential);
  if (!ok) {
    const fc = failureCounts.get(targetId) || { count: 0 };
    fc.count += 1;
    failureCounts.set(targetId, fc);
    return false;
  }
  failureCounts.delete(targetId);
  activeWaits.delete(targetId);
  applyDuration(targetId, lock);
  announceChanged();
  return true;
}

function currentWaitMs(targetId) {
  const ends = activeWaits.get(targetId);
  if (!ends) return 0;
  return Math.max(0, ends - Date.now());
}

function beginEscalationWaitIfNeeded(targetId) {
  const fc = failureCounts.get(targetId);
  if (!fc || fc.count < 2 || activeWaits.has(targetId)) return;
  const idx = Math.min(fc.count - 2, WAIT_LADDER_MS.length - 1);
  activeWaits.set(targetId, Date.now() + WAIT_LADDER_MS[idx]);
  ladderUsedForWait.delete(targetId);
}

/**
 * Gate a protected action. Resolves true when the caller may proceed — either
 * nothing was locked, the lock is satisfied, or the user just unlocked it.
 * @param {string} targetId
 * @param {{anchorEl?:Element|null, title?:string}} [opts]
 * @returns {Promise<boolean>}
 */
export function assertUnlocked(targetId, opts = {}) {
  const lock = findLock(targetId);
  if (!lock) return Promise.resolve(true);
  if (runtimeValid(targetId)) return Promise.resolve(true);
  return openUnlockPrompt(lock, opts);
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

function randomB32(bytes = 20) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function normalizeB32(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
}

function groupSecret(secret) {
  return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
}

async function pathsInfo() {
  try {
    const res = await ipc('app:paths', {});
    if (res && res.ok) return res;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Anchored, non-modal creation wizard. Four explicit steps; Cancel at any
 * point returns focus to the originating control and persists nothing except
 * (for TOTP generation) a seed already stored under the pending lock id —
 * which the cancel path deletes.
 */
async function openWizard(anchorEl, detail = {}) {
  const panel = ui.el('div', { class: 'mrb-card mrb-lockwiz', role: 'dialog', 'aria-label': tr('locks.wizardTitle', 'Create a lock', '建立鎖頭') });

  const state = {
    step: 0,
    method: 'password',
    totpSource: 'generate',
    existingEntryId: '',
    lockId: newLockId(),
    generatedSecret: normalizeB32(randomB32()),
    confirmedTotp: false,
    durationMode: 'launch',
    durationMinutes: 15,
  };
  const targetLabel =
    detail.label ||
    (detail.el instanceof Element
      ? (detail.el.getAttribute('aria-label') || detail.el.textContent || detail.el.tagName || 'this element').trim().slice(0, 80)
      : String(detail.targetId || 'this element'));
  const targetId = String(detail.targetId || `${detail.kind || 'element'}:${state.lockId}`);

  const body = ui.el('div', { class: 'mrb-lockwiz-body' });
  const navRow = ui.el('div', { class: 'mrb-auth-editoractions' });
  panel.append(body, navRow);

  /** Resolves true when a lock was actually created, false on any cancel. */
  let settleWizard = () => {};
  const wizardDone = new Promise((resolve) => {
    settleWizard = resolve;
  });

  const close = anchorEl ? ui.anchored(anchorEl, panel, {}) : () => {};
  const originFocus = anchorEl instanceof Element && typeof document !== 'undefined' ? anchorEl : null;

  const cancelAll = async () => {
    // Remove any half-created credential so nothing orphaned survives.
    try {
      await ipc('totp:remove', { entryId: `lock:${state.lockId}` });
    } catch {
      /* nothing was stored */
    }
    close();
    settleWizard(false);
    if (originFocus && typeof originFocus.focus === 'function') originFocus.focus();
  };

  const finish = async () => {
    /** @type {any} */
    const lock = {
      lockId: state.lockId,
      targetKind: detail.kind || 'element',
      targetId,
      label: targetLabel,
      method: state.method,
      credRef: state.method === 'totp' ? `lock:${state.lockId}` : '',
      createdAt: Date.now(),
      unlockDuration: { mode: state.durationMode, minutes: state.durationMinutes },
      lockedOnLaunch: state.durationMode === 'launch',
    };
    if (state.method === 'totp' && state.totpSource === 'existing' && state.existingEntryId) {
      // Deliberate reuse: THIS lock points at the entry the user picked.
      lock.credRef = state.existingEntryId;
    }
    if (state.method === 'password') {
      const pw1 = state.pw1 || '';
      try {
        const made = await ipc('pwhash:make', { password: pw1 });
        if (!made || !made.ok) throw new Error('Hashing failed.');
        await ipc('vault:set', {
          service: 'locks',
          key: `hash:${state.lockId}`,
          value: JSON.stringify({ saltB64: made.saltB64, iter: made.iter, hashB64: made.hashB64 }),
        });
      } catch (err) {
        ui.toast({
          title: tr('locks.wizardHashFail', 'Could not store the credential:', '存唔到憑證：'),
          body: err instanceof Error ? err.message : String(err),
          tone: 'error',
        });
        return;
      }
    }
    locks.push(lock);
    saveLocks();
    announceChanged();
    close();
    ui.toast({ title: tr('locks.created', 'Lock created.', '鎖頭整好喇。'), tone: 'ok', timeoutMs: 4000 });
    if (originFocus && typeof originFocus.focus === 'function') originFocus.focus();
    settleWizard(true);
  };

  const mkRadio = (name, value, labelText, checked, onChange) => {
    const id = `mrb-${name}-${String(value)}-${Math.random().toString(36).slice(2, 6)}`;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.id = id;
    input.checked = !!checked;
    input.addEventListener('change', onChange);
    const lab = ui.el('label', { class: 'mrb-lockwiz-radio', for: id });
    lab.append(input, document.createTextNode(` ${labelText}`));
    return lab;
  };

  const renderStep = () => {
    body.textContent = '';
    navRow.textContent = '';
    const heading = ui.el('h4', {});
    body.appendChild(heading);

    const backBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
    backBtn.textContent = tr('locks.back', 'Back', '返回');
    const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
    cancelBtn.textContent = tr('locks.cancel', 'Cancel', '取消');
    cancelBtn.addEventListener('click', cancelAll);
    const nextBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });

    if (state.step === 0) {
      heading.textContent = tr('locks.step1', 'What are you locking?', '鎖邊樣？');
      const echo = ui.el('p', { class: 'mrb-lockwiz-target' });
      echo.textContent = targetLabel;
      body.appendChild(echo);
      nextBtn.textContent = tr('locks.next', 'Next', '下一步');
      nextBtn.addEventListener('click', () => {
        state.step = 1;
        renderStep();
      });
    }

    if (state.step === 1) {
      heading.textContent = tr('locks.step2', 'How should it unlock?', '用咩開鎖？');
      body.appendChild(
        mkRadio('method', 'password', tr('locks.methodPassword', 'Password'), state.method === 'password', () => {
          state.method = 'password';
          renderStep();
        })
      );
      body.appendChild(
        mkRadio('method', 'totp', tr('locks.methodTotp', 'One-time code (authenticator)'), state.method === 'totp', () => {
          state.method = 'totp';
          state.confirmedTotp = false;
          renderStep();
        })
      );

      if (state.method === 'password') {
        const mkPw = (labelText) => {
          const input = document.createElement('input');
          input.type = 'password';
          input.className = 'mrb-field__input';
          input.autocomplete = 'new-password';
          const holder = ui.el('div', { class: 'mrb-field' });
          const lab = ui.el('label', { class: 'mrb-field__label' });
          lab.textContent = labelText;
          holder.append(lab, input);
          return { holder, input };
        };
        const f1 = mkPw(tr('locks.pwEnter', 'Password for this lock', '呢把鎖嘅密碼'));
        const f2 = mkPw(tr('locks.pwConfirm', 'Same password again', '再輸入一次相同密碼'));
        const errBox = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
        body.append(f1.holder, f2.holder, errBox);
        nextBtn.textContent = tr('locks.next', 'Next', '下一步');
        nextBtn.addEventListener('click', () => {
          const a = f1.input.value;
          const b = f2.input.value;
          if (!a) {
            errBox.textContent = tr('locks.pwEmpty', 'Type a password first.', '請先輸入密碼。');
            return;
          }
          if (a !== b) {
            errBox.textContent = tr('locks.pwMismatch', 'The two passwords do not match.', '兩次密碼唔一致。');
            return;
          }
          state.pw1 = a;
          state.step = 2;
          renderStep();
        });
      } else {
        body.appendChild(
          mkRadio('totpsrc', 'generate', tr('locks.totpGenerate', 'Generate a new secret for this lock'), state.totpSource === 'generate', () => {
            state.totpSource = 'generate';
            state.confirmedTotp = false;
            renderStep();
          })
        );
        const existingHolder = ui.el('div', {});
        body.appendChild(existingHolder);
        ipc('totp:list', {})
          .then((res) => {
            const allEntries = (res && res.entries) || [];
            const takenByOthers = new Set(
              locks.filter((l) => l.method === 'totp').map((l) => l.credRef)
            );
            const usable = allEntries.filter((e) => !takenByOthers.has(e.entryId));
            if (usable.length === 0) {
              const note = ui.el('p', { class: 'mrb-vocab-status' });
              note.textContent = tr(
                'locks.noExistingTotp',
                'No existing authenticator entry available for reuse.',
                '暫時冇可以重用嘅驗證器條目。'
              );
              existingHolder.appendChild(note);
              return;
            }
            existingHolder.appendChild(
              mkRadio('totpsrc', 'existing', tr('locks.totpExisting', 'Use an existing entry (deliberate shared credential)'), state.totpSource === 'existing', () => {
                state.totpSource = 'existing';
                state.confirmedTotp = false;
                renderStep();
              })
            );
            if (state.totpSource === 'existing') {
              const sel = document.createElement('select');
              sel.className = 'mrb-select';
              sel.setAttribute('aria-label', tr('locks.existingPick', 'Pick the entry to reuse', '揀要重用嘅條目'));
              usable.forEach((e) => {
                const opt = document.createElement('option');
                opt.value = e.entryId;
                opt.textContent = e.entryId;
                sel.appendChild(opt);
              });
              sel.addEventListener('change', () => {
                state.existingEntryId = sel.value;
                state.confirmedTotp = false;
              });
              state.existingEntryId = state.existingEntryId || usable[0].entryId;
              sel.value = state.existingEntryId;
              existingHolder.appendChild(sel);
            }
          })
          .catch(() => {});

        // Live-code confirmation is MANDATORY before the wizard can proceed.
        const confirmWrap = ui.el('div', { class: 'mrb-field' });
        const confirmLab = ui.el('label', { class: 'mrb-field__label' });
        confirmLab.textContent = tr(
          'locks.totpConfirm',
          'Confirm by typing the CURRENT code now',
          '輸入而家嘅即時驗證碼確認'
        );
        const confirmInput = document.createElement('input');
        confirmInput.type = 'text';
        confirmInput.inputMode = 'numeric';
        confirmInput.className = 'mrb-field__input';
        confirmInput.autocomplete = 'one-time-code';
        confirmInput.addEventListener('change', () => {
          state._confirmCode = confirmInput.value.replace(/\D/g, '');
        });
        confirmWrap.append(confirmLab, confirmInput);
        body.appendChild(confirmWrap);

        if (state.totpSource === 'generate') {
          const qrArea = ui.el('div', { class: 'mrb-auth-qrarea' });
          const qrCanvas = document.createElement('canvas');
          qrCanvas.className = 'mrb-auth-qr';
          qrCanvas.setAttribute('role', 'img');
          const revealBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
          revealBtn.textContent = tr('locks.showSecret', 'Show secret', '顯示密鑰');
          const secretEcho = ui.el('code', { class: 'mrb-auth-secretcopy' });
          secretEcho.hidden = true;
          revealBtn.addEventListener('click', () => {
            secretEcho.hidden = !secretEcho.hidden;
            revealBtn.textContent = secretEcho.hidden
              ? tr('locks.showSecret', 'Show secret', '顯示密鑰')
              : tr('locks.hideSecret', 'Hide secret', '收起密鑰');
          });
          import('./qr.js')
            .then((qrModule) => {
              const uri = `otpauth://totp/${encodeURIComponent('Material Roblox Lock')}:${encodeURIComponent(state.lockId)}?secret=${state.generatedSecret}&issuer=${encodeURIComponent('Material Roblox Locks')}&algorithm=SHA1&digits=6&period=30`;
              try {
                const info = qrModule.encodeToCanvas(qrCanvas, uri, { scale: 5 });
                qrCanvas.setAttribute(
                  'aria-label',
                  tr('locks.qrAlt', `Pairing QR for lock ${state.lockId}; ${info.size} by ${info.size} modules.`, `鎖頭 ${state.lockId} 嘅配對 QR；${info.size}×${info.size} 格。`)
                );
              } catch {
                /* drawing failure leaves the manual secret as the pairing path */
              }
            })
            .catch(() => {});
          secretEcho.textContent = groupSecret(state.generatedSecret);
          qrArea.append(qrCanvas, revealBtn, secretEcho);
          body.appendChild(qrArea);
        }

        nextBtn.textContent = tr('locks.verifyNext', 'Verify and continue', '驗證並繼續');
        nextBtn.addEventListener('click', async () => {
          const entryIdToCheck =
            state.totpSource === 'existing' && state.existingEntryId
              ? state.existingEntryId
              : `lock:${state.lockId}`;
          if (state.totpSource === 'generate') {
            try {
              await ipc('totp:put', {
                entryId: `lock:${state.lockId}`,
                secretB32: state.generatedSecret,
                params: { algo: 'sha1', digits: 6, period: 30 },
              });
            } catch (err) {
              ui.toast({
                title: tr('locks.seedStoreFail', 'Could not store the new secret:', '存唔到新密鑰：'),
                body: err instanceof Error ? err.message : String(err),
                tone: 'error',
              });
              return;
            }
          }
          try {
            const verdict = await ipc('totp:verify', {
              entryId: entryIdToCheck,
              code: String(state._confirmCode || ''),
              window: 1,
            });
            if (!(verdict && verdict.ok && verdict.match)) {
              ui.toast({
                title: tr('locks.confirmFailed', 'That code did not match — nothing was changed.', '驗證碼唔啱——乜都冇變過。'),
                tone: 'error',
              });
              return;
            }
            state.confirmedTotp = true;
            state.credRefFinal = entryIdToCheck;
            state.step = 2;
            renderStep();
          } catch (err) {
            ui.toast({
              title: tr('locks.confirmError', 'Verification failed:', '驗證失敗：'),
              body: err instanceof Error ? err.message : String(err),
              tone: 'error',
            });
          }
        });
      }
    }

    if (state.step === 2) {
      heading.textContent = tr('locks.step3', 'How long should it stay unlocked?', '解鎖後維持幾耐？');
      body.appendChild(
        mkRadio('dur', 'surface', tr('locks.durSurface', 'Just this surface (until navigation)'), state.durationMode === 'surface', () => { state.durationMode = 'surface'; })
      );
      const minutesRow = ui.el('div', { class: 'mrb-field mrb-field--row mrb-lockwiz-minrow' });
      body.appendChild(
        mkRadio('dur', 'minutes', tr('locks.durMinutes', 'A number of minutes'), state.durationMode === 'minutes', () => {
          state.durationMode = 'minutes';
        })
      );
      const stepper = document.createElement('input');
      stepper.type = 'number';
      stepper.min = '5';
      stepper.max = '720';
      stepper.step = '5';
      stepper.value = String(state.durationMinutes);
      stepper.className = 'mrb-field__input mrb-lockwiz-stepper';
      stepper.setAttribute('aria-label', tr('locks.minutesLabel', 'Minutes (5–720)', '分鐘（5–720）'));
      stepper.addEventListener('change', () => {
        const v = Math.max(5, Math.min(720, Math.round(Number(stepper.value) || 15)));
        state.durationMinutes = v;
        stepper.value = String(v);
      });
      minutesRow.append(document.createTextNode(' '), stepper);
      body.appendChild(minutesRow);
      body.appendChild(
        mkRadio('dur', 'session', tr('locks.durSession', 'Until the app closes'), state.durationMode === 'session', () => { state.durationMode = 'session'; })
      );
      body.appendChild(
        mkRadio('dur', 'launch', tr('locks.durLaunch', 'Locked again on next launch (default)'), state.durationMode === 'launch', () => { state.durationMode = 'launch'; })
      );
      nextBtn.textContent = tr('locks.next', 'Next', '下一步');
      nextBtn.addEventListener('click', () => {
        state.step = 3;
        renderStep();
      });
    }

    if (state.step === 3) {
      heading.textContent = tr('locks.step4', 'The honest small print', '老實講清楚');
      const card = ui.el('div', { class: 'mrb-lockwiz-disclosure' });
      const ul = ui.el('ul', {});
      [
        tr('locks.disc1', 'This lock is for fun — a self-imposed speed bump.'),
        tr('locks.disc2', 'It is not security, encryption, or protection of any data.'),
        tr('locks.disc3', 'Anyone with access to this computer can delete the app data folder and every lock disappears.'),
      ].forEach((t) => {
        const li = ui.el('li', {});
        li.textContent = t;
        ul.appendChild(li);
      });
      card.appendChild(ul);

      const recover = ui.el('div', { class: 'mrb-field' });
      const recoverLab = ui.el('span', { class: 'mrb-field__label' });
      recoverLab.textContent = tr('locks.recoveryPath', 'Recovery: delete this folder (removes every lock, ticket, and preference)', '復原方法：刪除呢個資料夾（所有鎖頭、工單同偏好設定一併清除）');
      const pathLine = ui.el('code', { class: 'mrb-lockwiz-path' });
      pathLine.textContent = tr('locks.pathPending', 'Reading folder location…', '讀取資料夾位置中…');
      const copyBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-auth-min', type: 'button' });
      copyBtn.textContent = tr('locks.copyPath', 'Copy path', '複製路徑');
      copyBtn.disabled = true;
      copyBtn.addEventListener('click', async () => {
        try {
          await ui.copyText(pathLine.textContent || '');
        } catch {
          /* clipboard unavailable */
        }
      });
      const ticketsBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button' });
      ticketsBtn.textContent = tr('locks.openTickets', 'Open Support Tickets', '開啟支援工單');
      ticketsBtn.addEventListener('click', () => {
        close();
        openTicketsDesk(null);
      });
      const recoverActions = ui.el('div', { class: 'mrb-auth-editoractions' }, copyBtn, ticketsBtn);
      recover.append(recoverLab, pathLine, recoverActions);
      card.appendChild(recover);
      body.appendChild(card);

      void pathsInfo().then((info) => {
        if (info && info.userData) {
          pathLine.textContent = info.userData;
          copyBtn.disabled = false;
        } else {
          pathLine.textContent = tr('locks.pathUnknown', 'Folder location unavailable right now.', '暫時攞唔到資料夾位置。');
        }
      });

      const finishBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
      finishBtn.textContent = tr('locks.finish', 'Create the lock', '建立鎖頭');
      finishBtn.addEventListener('click', finish);
      navRow.append(backBtn, cancelBtn, finishBtn);
      backBtn.addEventListener('click', () => {
        state.step = 2;
        renderStep();
      });
      return;
    }

    if (state.step > 0) {
      backBtn.addEventListener('click', () => {
        state.step -= 1;
        renderStep();
      });
      navRow.append(backBtn);
    }
    navRow.append(cancelBtn, nextBtn);
  };

  renderStep();
  return wizardDone;
}

// ---------------------------------------------------------------------------
// Unlock prompt
// ---------------------------------------------------------------------------

function openUnlockPrompt(lock, opts = {}) {
  return new Promise((resolve) => {
    const anchor = opts.anchorEl instanceof Element ? opts.anchorEl : document.body;
    const panel = ui.el('div', { class: 'mrb-card mrb-unlockprompt', role: 'dialog', 'aria-label': tr('locks.unlockTitle', 'Unlock', '解鎖') });
    const title = ui.el('h4', {});
    title.textContent = `${tr('locks.lockedBy', '🔒 Locked:')} ${lock.label || lock.targetId}`;
    const intro = ui.el('p', { class: 'mrb-vocab-status' });
    intro.textContent = tr(
      'locks.unlockIntro',
      'This is a for-fun lock, not security. Forgot it? Recover below.',
      '呢個係玩味性質嘅鎖，唔係保安。唔記得咗？下面有復原路。'
    );

    const field = ui.el('div', { class: 'mrb-field' });
    const lab = ui.el('label', { class: 'mrb-field__label' });
    lab.textContent =
      lock.method === 'totp'
        ? tr('locks.enterCode', 'Enter the 6-digit code', '輸入6位驗證碼')
        : tr('locks.enterPassword', 'Enter this lock’s password', '輸入呢把鎖嘅密碼');
    const input = document.createElement('input');
    input.type = lock.method === 'totp' ? 'text' : 'password';
    input.inputMode = lock.method === 'totp' ? 'numeric' : undefined;
    input.className = 'mrb-field__input';
    input.autocomplete = 'off';
    field.append(lab, input);

    const feedback = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
    const submitBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
    submitBtn.textContent = tr('locks.unlockBtn', 'Unlock', '解鎖');
    const forgotBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
    forgotBtn.textContent = tr('locks.forgot', 'Forgotten your password?', '唔記得密碼？');

    let panelClosed = false;
    const closePanel = () => {
      if (panelClosed) return; // settle() and explicit closes can both arrive
      panelClosed = true;
      try {
        closeFn();
      } catch {
        /* anchor already gone */
      }
      if (timer) clearInterval(timer);
    };
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      closePanel();
    };

    const refreshWaitUi = () => {
      const left = currentWaitMs(lock.targetId);
      if (left <= 0) {
        submitBtn.disabled = false;
        input.disabled = false;
        feedback.textContent = '';
        return;
      }
      submitBtn.disabled = true;
      input.disabled = true;
      const secs = Math.ceil(left / 1000);
      feedback.textContent = tr(
        'locks.waitingOut',
        `Too many tries — wait ${secs}s before trying again.`,
        `試太多次——等 ${secs} 秒先再試。`
      );
    };
    const timer = setInterval(refreshWaitUi, 500);

    submitBtn.addEventListener('click', async () => {
      if (currentWaitMs(lock.targetId) > 0) return;
      // Per-attempt backoff (1s → 2s → 4s … capped) keeps guessing honest
      // without ever wiping what the user typed.
      const fc = failureCounts.get(lock.targetId) || { count: 0 };
      const backoffS = ATTEMPT_BACKOFF_S[Math.min(fc.count, ATTEMPT_BACKOFF_S.length - 1)];
      submitBtn.disabled = true;
      setTimeout(async () => {
        try {
          const ok = await unlock(lock.targetId, input.value);
          if (ok) {
            ui.toast({ title: tr('locks.unlockedToast', 'Unlocked.', '已解鎖。'), tone: 'ok', timeoutMs: 3000 });
            settle(true);
            return;
          }
          beginEscalationWaitIfNeeded(lock.targetId);
          feedback.textContent = tr(
            'locks.wrongAttempt',
            'Did not match — recover by deleting the data folder or open Support Tickets.',
            '唔啱喎——可以刪除資料夾復原，或者開支援工單。'
          );
          // Nothing the user typed is destroyed: the attempt stays in the
          // field, selected for a quick correction.
          input.select();
          input.focus();
        } finally {
          refreshWaitUi();
        }
      }, backoffS * 1000);
      feedback.textContent = tr('locks.checking', 'Checking…', '核對中…');
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitBtn.click();
    });

    forgotBtn.addEventListener('click', () => {
      closePanel();
      settle(openTicketsDesk(anchor));
    });

    // Ladder offer: only while a wait is running, once per wait, and only
    // when the rolling-hour budget has room.
    const gameBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined', type: 'button' });
    gameBtn.textContent = tr('locks.playGame', 'Play a quick game to end the wait early', '玩個小遊戲提早完等待');
    gameBtn.addEventListener('click', async () => {
      if (currentWaitMs(lock.targetId) <= 0 || ladderUsedForWait.get(lock.targetId)) return;
      try {
        const budget = await ipc('ladder:budget', {});
        if (!budget || !(budget.leftOf3 > 0)) {
          feedback.textContent = tr(
            'locks.budgetGone',
            'The quick-game skips are used up for this hour — the clock it is.',
            '呢個鐘頭嘅跳過配額用晒——剩係得等。'
          );
          return;
        }
      } catch {
        feedback.textContent = tr('locks.gameUnavailable', 'The game grader is unavailable right now.', '暫時用唔到遊戲判官。');
        return;
      }
      gameBtn.disabled = true;
      import('./ladder.js')
        .then(async (ladderModule) => {
          const cleared = await ladderModule.runLadder({
            anchorEl: panel,
            schoolActive: (() => {
              try {
                return !!i18n.schoolActive();
              } catch {
                return false;
              }
            })(),
            waitMsRemaining: currentWaitMs(lock.targetId),
          });
          if (cleared) {
            ladderUsedForWait.set(lock.targetId, true);
            activeWaits.set(lock.targetId, Date.now()); // wait ENDS; escalation untouched
            refreshWaitUi();
          }
          gameBtn.disabled = false;
        })
        .catch(() => {
          gameBtn.disabled = false;
        });
    });

    const actions = ui.el('div', { class: 'mrb-auth-editoractions' });
    actions.append(submitBtn, forgotBtn);
    panel.append(title, intro, field, feedback, actions, gameBtn);
    const closeFn = ui.anchored(anchor, panel, {});
    refreshWaitUi();
    input.focus();

    // Escape/back cancellation path resolves false honestly.
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !settled) {
        settled = true;
        resolve(false);
        closePanel();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tab render gate + appearance veto listeners
// ---------------------------------------------------------------------------

window.addEventListener('mrb-tab-render-gate', (event) => {
  const detail = event.detail || {};
  if (typeof detail.respond !== 'function' || !detail.tabId) return;
  const targetId = `tab:${detail.tabId}`;
  if (!findLock(targetId) || runtimeValid(targetId)) {
    detail.respond(Promise.resolve(true));
    return;
  }
  const lock = findLock(targetId);
  // Blocking render until unlocked; declining leaves the tab honestly closed.
  detail.respond(assertUnlocked(targetId, { anchorEl: detail.anchorEl || null, title: lock.label }));
});

window.addEventListener('mrb-appearance-prop-change', (event) => {
  const detail = event.detail || {};
  if (typeof detail.veto !== 'function') return;
  detail.veto(vetoPropertyChange(String(detail.elementPath || ''), String(detail.prop || '')));
});

// ---------------------------------------------------------------------------
// Manage surface + Support Tickets desk (shared 'security' tab)
// ---------------------------------------------------------------------------

function renderManager(hostEl) {
  hostEl.textContent = '';
  const wrap = ui.el('div', { class: 'mrb-card mrb-lockman' });
  const heading = ui.el('h3', {});
  heading.textContent = tr('locks.manageTitle', 'Your locks', '你嘅鎖頭');
  wrap.appendChild(heading);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mrb-field__input';
  search.placeholder = tr('locks.searchPlaceholder', 'Search locks…', '搜尋鎖頭…');
  search.setAttribute('aria-label', tr('locks.searchLabel', 'Search locks', '搜尋鎖頭'));
  let query = '';
  search.addEventListener('input', () => {
    query = search.value.toLowerCase();
    paintRows();
  });
  if (regexbuilderMod && typeof regexbuilderMod.attachSearch === 'function') {
    try {
      regexbuilderMod.attachSearch(search, {
        onQuery: (q) => {
          query = String((q && (q.plain != null ? q.plain : q.raw)) || '').toLowerCase();
          paintRows();
        },
      });
    } catch {
      /* plain filtering continues */
    }
  }
  wrap.appendChild(search);

  const rows = ui.el('ul', { class: 'mrb-list', role: 'list' });
  const bulkBar = ui.el('div', { class: 'mrb-auth-bulkbar' });
  const countBadge = ui.el('span', { class: 'mrb-badge' });
  const removeSelected = ui.el('button', { class: 'mrb-btn mrb-btn--danger', type: 'button', disabled: true });
  removeSelected.textContent = tr('locks.bulkRemove', 'Remove selected…', '移除所選…');
  const exportBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined', type: 'button' });
  exportBtn.textContent = tr('locks.exportRedacted', 'Export (redacted)…', '匯出（已隱去）…');

  const paintRows = () => {
    rows.textContent = '';
    const list = locks.filter((l) =>
      !query || `${l.label || ''} ${l.targetId} ${l.targetKind} ${l.method}`.toLowerCase().includes(query)
    );
    if (list.length === 0) {
      const empty = ui.el('li', { class: 'mrb-auth-empty' });
      empty.textContent = tr(
        'locks.noneYet',
        'Nothing is locked. Use “Lock this…” on any element, tab, or appearance value.',
        '而家乜都冇鎖。喺任何元素、分頁或外觀數值度用「鎖住呢個…」。'
      );
      rows.appendChild(empty);
      syncBulkBar();
      return;
    }
    for (const lock of list) rows.appendChild(renderManageRow(lock, paintRows));
    syncBulkBar();
  };
  const syncBulkBar = () => {
    const checked = rows.querySelectorAll('input[data-lock-bulk]:checked').length;
    countBadge.textContent = tr('locks.selectedCount', `${checked} selected`, `已揀 ${checked} 個`);
    removeSelected.disabled = checked === 0;
  };
  rows.addEventListener('change', syncBulkBar);

  removeSelected.addEventListener('click', () => {
    const ids = [...rows.querySelectorAll('input[data-lock-bulk]:checked')].map((elNode) => elNode.getAttribute('data-lock-bulk'));
    if (ids.length === 0) return;
    ui.superConfirm({
      title: tr('locks.bulkRemoveTitle', `Remove ${ids.length} lock${ids.length === 1 ? '' : 's'}?`, `移除 ${ids.length} 把鎖頭？`),
      detailHtml: tr(
        'locks.bulkRemoveDetail',
        'Each removed lock forgets ONLY its own credential. Nothing else changes.',
        '每把被移除嘅鎖只會忘記自己嗰份憑證，其他嘢不變。'
      ),
      confirmLabel: tr('locks.bulkRemoveConfirm', 'Remove locks', '移除鎖頭'),
      onConfirm: async () => {
        for (const id of ids) await removeLockById(id, { silent: true });
        paintRows();
      },
    });
  });

  exportBtn.addEventListener('click', async () => {
    const statement = tr(
      'locks.exportStatement',
      'REDACTED EXPORT — credential references and hashes are omitted on purpose.',
      '已隱去嘅匯出——刻意略去憑證引用同雜湊。'
    );
    const data = locks.map((l) => ({
      label: l.label,
      targetKind: l.targetKind,
      targetId: l.targetId,
      method: l.method,
      createdAt: new Date(l.createdAt || Date.now()).toISOString(),
      unlockDuration: l.unlockDuration,
    }));
    if (exporterMod && exporterMod.exporter && typeof exporterMod.exporter.exportData === 'function') {
      try {
        await exporterMod.exporter.exportData({
          name: 'material-roblox-locks-redacted',
          data: { notice: statement, locks: data },
          rows: data,
          formats: ['json'],
        });
        return;
      } catch {
        /* clipboard fallback below */
      }
    }
    try {
      await ui.copyText(JSON.stringify({ notice: statement, locks: data }, null, 2));
      ui.toast({ title: tr('locks.exportCopied', 'Copied redacted lock list.', '已複製隱去版鎖頭清單。'), tone: 'ok', timeoutMs: 4000 });
    } catch {
      ui.toast({ title: tr('locks.exportFail', 'Export failed.', '匯出失敗。'), tone: 'error' });
    }
  });

  bulkBar.append(countBadge, removeSelected, exportBtn);
  wrap.append(rows, bulkBar);
  hostEl.appendChild(wrap);
}

function renderManageRow(lock, repaint) {
  const row = ui.el('li', { class: 'mrb-list-row mrb-lockman-row' });
  const select = ui.el('input', {
    type: 'checkbox',
    'data-lock-bulk': lock.lockId,
    'aria-label': tr('locks.selectOne', `Select ${lock.label}`, `揀「${lock.label}」`),
  });
  const main = ui.el('div', { class: 'mrb-lockman-main' });
  const nameLine = ui.el('span', { class: 'mrb-lockman-name' });
  nameLine.textContent = `${isLocked(lock.targetId) ? '🔒 ' : '🔓 '}${lock.label || lock.targetId}`;
  const metaLine = ui.el('span', { class: 'mrb-auth-account' });
  const durLabel = (() => {
    const m = lock.unlockDuration && lock.unlockDuration.mode;
    if (m === 'minutes') return tr('locks.durMinutesShort', `${lock.unlockDuration.minutes} min`, `${lock.unlockDuration.minutes} 分鐘`);
    if (m === 'session') return tr('locks.durSession', 'Until the app closes', '關閉前有效');
    if (m === 'surface') return tr('locks.durSurface', 'This surface', '呢個介面');
    return tr('locks.durLaunch', 'On launch', '下次啟動上鎖');
  })();
  metaLine.textContent = `${lock.targetKind} · ${lock.method} · ${durLabel}${decorateSearchResult(lock.targetId) ? ' · 🔒' : ''}`;
  main.append(nameLine, metaLine);

  const toggleBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-auth-min', type: 'button' });
  toggleBtn.textContent = isLocked(lock.targetId)
    ? tr('locks.unlockAction', 'Unlock…', '解鎖…')
    : tr('locks.relock', 'Lock again', '即刻上鎖');
  toggleBtn.addEventListener('click', () => {
    if (isLocked(lock.targetId)) {
      assertUnlocked(lock.targetId, { anchorEl: row }).then(() => repaint());
    } else {
      lockAgain(lock.targetId);
      repaint();
    }
  });

  const durBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-auth-min', type: 'button' });
  durBtn.textContent = tr('locks.editDuration', 'Edit duration', '改時長');
  durBtn.addEventListener('click', () => {
    const panel = ui.el('div', { class: 'mrb-card mrb-lockman-editor', role: 'dialog' });
    const modes = ['surface', 'minutes', 'session', 'launch'];
    modes.forEach((m) => {
      const labels = {
        surface: tr('locks.durSurface', 'Just this surface', '呢個介面'),
        minutes: tr('locks.durMinutes', 'N minutes', 'N 分鐘'),
        session: tr('locks.durSession', 'Until the app closes', '關閉前有效'),
        launch: tr('locks.durLaunch', 'Locked on launch', '啟動時上鎖'),
      };
      panel.appendChild(
        (() => {
          const id = `mrb-dur-${m}-${Math.random().toString(36).slice(2, 6)}`;
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'editDur';
          input.value = m;
          input.id = id;
          input.checked = (lock.unlockDuration && lock.unlockDuration.mode) === m;
          const lab = ui.el('label', { class: 'mrb-lockwiz-radio', for: id });
          lab.append(input, document.createTextNode(` ${labels[m]}`));
          input.addEventListener('change', () => {
            lock.unlockDuration = { mode: m, minutes: lock.unlockDuration ? lock.unlockDuration.minutes : 15 };
            lock.lockedOnLaunch = m === 'launch';
            saveLocks();
            announceChanged();
          });
          return lab;
        })()
      );
    });
    const doneBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
    doneBtn.textContent = tr('locks.done', 'Done', '完成');
    doneBtn.addEventListener('click', () => {
      closeEd();
      repaint();
    });
    panel.appendChild(doneBtn);
    const closeEd = ui.anchored(row, panel, {});
  });

  const methodBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-auth-min', type: 'button' });
  methodBtn.textContent = tr('locks.changeMethod', 'Change method…', '轉換方式…');
  methodBtn.addEventListener('click', () => {
    // Re-enrolment flow: the NEW method gets ITS OWN fresh credential for
    // this lock; only a completed wizard retires the old one (a cancelled
    // wizard changes nothing), keeping "each lock its own credential" intact.
    openWizard(row, {
      kind: lock.targetKind,
      targetId: lock.targetId,
      label: lock.label,
    }).then((created) => {
      if (!created) return;
      removeLockById(lock.lockId, { silent: true }).then(() => repaint());
    });
  });

  const rmBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-auth-danger mrb-auth-min', type: 'button' });
  rmBtn.textContent = tr('locks.remove', 'Remove', '移除');
  rmBtn.addEventListener('click', () => {
    ui.superConfirm({
      title: tr('locks.removeTitle', `Remove “${lock.label || lock.targetId}”?`, `移除「${lock.label || lock.targetId}」？`),
      detailHtml: tr(
        'locks.removeDetail',
        'The lock and its own credential are deleted together. The underlying element or tab is untouched.',
        '鎖頭同它自己嘅憑證會一齊刪除；底下的元素或分頁不受影響。'
      ),
      confirmLabel: tr('locks.removeConfirm', 'Remove lock', '移除鎖頭'),
      onConfirm: async () => {
        await removeLockById(lock.lockId, { silent: true });
        repaint();
      },
    });
  });

  row.append(select, main, toggleBtn, durBtn, methodBtn, rmBtn);
  return row;
}

async function removeLockById(lockId, { silent } = {}) {
  const lock = locks.find((l) => l.lockId === lockId);
  if (!lock) return;
  if (lock.method === 'password') {
    try {
      await ipc('vault:delete', { service: 'locks', key: `hash:${lock.lockId}` });
    } catch {
      /* vault cleanup best-effort */
    }
  } else if (lock.method === 'totp' && typeof lock.credRef === 'string' && lock.credRef.startsWith('lock:')) {
    // Only delete seeds the lock OWNS; deliberately reused entries survive.
    try {
      await ipc('totp:remove', { entryId: lock.credRef });
    } catch {
      /* best-effort */
    }
  }
  locks = locks.filter((l) => l.lockId !== lockId);
  saveLocks();
  unlockedUntil.delete(lock.targetId);
  announceChanged();
  if (!silent) ui.toast({ title: tr('locks.removedToast', 'Lock removed.', '已移除鎖頭。'), tone: 'ok', timeoutMs: 3000 });
}

// ---------------------------------------------------------------------------
// Support Tickets — the fictional desk that opens the real folder
// ---------------------------------------------------------------------------

/**
 * DELIBERATE ABSENCE (assertion comment): there is NO in-app deletion action
 * anywhere in this desk. Resolution consists exclusively of showing the exact
 * folder and handing the user to their own file manager. Any future change
 * that adds an in-app delete here must route through ui.superConfirm like
 * every other destructive batch — and the plain-line box must stay unstyled
 * by the funny level.
 */
function openTicketsDesk(anchorEl) {
  const panel = ui.el('div', { class: 'mrb-card mrb-tickets', role: 'dialog', 'aria-label': tr('tickets.title', 'Support Tickets', '支援工單') });
  const heading = ui.el('h3', {});
  heading.textContent = tr('tickets.heading', 'Material Roblox Support Tickets™', 'Material Roblox 支援工單™');
  const subline = ui.el('p', { class: 'mrb-vocab-status' });
  subline.textContent = tr(
    'tickets.subline',
    'Our world-class desk answers every ticket with the same carefully rehearsed gravity.',
    '我哋嘅世界級服務台會以排練十足嘅莊嚴語氣回覆每一張工單。'
  );

  // THE PLAIN LINE — outside the comedy, intentionally unstyled by funny level.
  const plainBox = ui.el('p', { class: 'mrb-tickets-plainline' });
  plainBox.textContent =
    'Nothing is sent anywhere. No ticket exists outside this computer. No network request is made. No data is collected. Nobody is reading this.';

  const form = ui.el('form', { class: 'mrb-tickets-form' });
  const mkSelect = (labelText, options) => {
    const sel = document.createElement('select');
    sel.className = 'mrb-select';
    sel.setAttribute('aria-label', labelText);
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    const holder = ui.el('div', { class: 'mrb-field' });
    const lab = ui.el('label', { class: 'mrb-field__label' });
    lab.textContent = labelText;
    holder.append(lab, sel);
    return { holder, sel };
  };
  const category = mkSelect(tr('tickets.category', 'Category'), [
    { value: 'toy-lock', label: tr('tickets.catToyLock', 'Toy lock', '玩味鎖頭') },
    { value: 'appearance-lock', label: tr('tickets.catAppearance', 'Appearance lock', '外觀鎖') },
    { value: 'authenticator', label: tr('tickets.catAuthenticator', 'Authenticator', '驗證器') },
    { value: 'something', label: tr('tickets.catOther', 'Something else entirely', '其他嘢') },
  ]);
  const severity = mkSelect(tr('tickets.severity', 'Severity (advisory; nobody will honour it)'), [
    { value: 'cosmetic', label: tr('tickets.sevCosmetic', 'Cosmetic scratch', '表面花痕') },
    { value: 'annoying', label: tr('tickets.sevAnnoying', 'Mildly annoying', '少少煩') },
    { value: 'existential', label: tr('tickets.sevExistential', 'Existential', '存在危機') },
    { value: 'defcon', label: tr('tickets.sevDefcon', 'DEFCON 1', 'DEFCON 1') },
  ]);
  const descField = ui.el('div', { class: 'mrb-field' });
  const descLab = ui.el('label', { class: 'mrb-field__label' });
  descLab.textContent = tr('tickets.describe', 'Describe the trouble', '描述一下狀況');
  const desc = document.createElement('textarea');
  desc.rows = 3;
  desc.className = 'mrb-field__input';
  descField.append(descLab, desc);

  const statusLine = ui.el('p', { class: 'mrb-vocab-status', role: 'status' });
  const replyBox = ui.el('blockquote', { class: 'mrb-tickets-reply', hidden: true });
  const resolution = ui.el('div', { class: 'mrb-tickets-resolution', hidden: true });
  const submitBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'submit' });
  submitBtn.textContent = tr('tickets.submit', 'Submit ticket', '提交工單');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const number = `MRB-${String(Math.floor(Math.random() * 900000) + 100000)}`;
    const ticket = {
      number,
      category: category.sel.value,
      severity: severity.sel.value,
      description: desc.value.slice(0, 2000),
      createdAt: Date.now(),
      status: 'pending',
    };
    const tickets = store.get(TICKETS_KEY, []);
    tickets.unshift(ticket);
    store.set(TICKETS_KEY, tickets.slice(0, 100));

    statusLine.textContent = tr('tickets.filed', `Ticket ${number} filed — status: Pending`, `工單 ${number} 已提交——狀態：待處理`);
    replyBox.hidden = false;
    replyBox.textContent = tr(
      'tickets.cannedReply',
      '“Thank you for contacting Material Roblox Support Tickets™. Your concern has been assigned the importance it deserves, which is to say: it has been assigned. A specialist who is definitely not the same three lines of script will review your case in due course.”',
      '「多謝聯絡 Material Roblox 支援工單™。你嘅查詢已獲分配應有嘅重視程度——即係話：已經分配咗。一位肯定唔係同三行腳本嘅專家將會適時跟進。」'
    );
    submitBtn.disabled = true;

    setTimeout(() => {
      statusLine.textContent = tr('tickets.inReview', `Ticket ${number} — In review (impressively fast)`, `工單 ${number}——審核中（快得出奇）`);
      setTimeout(() => {
        statusLine.textContent = tr('tickets.resolvedStatus', `Ticket ${number} — Resolved. Here is the entire remedy:`, `工單 ${number}——已完成。成個解決方法如下：`);
        buildResolution(resolution);
        resolution.hidden = false;
        submitBtn.disabled = false;
      }, 4000);
    }, 2000);
  });

  form.append(category.holder, severity.holder, descField, submitBtn);
  panel.append(heading, subline, plainBox, form, statusLine, replyBox, resolution);

  // Ticket history (local only, searchable, clearable).
  const historyWrap = ui.el('details', { class: 'mrb-tickets-history' });
  const summary = ui.el('summary', {});
  summary.textContent = tr('tickets.history', 'Previous tickets (stored locally)', '之前嘅工單（只存本地）');
  const histList = ui.el('ul', { class: 'mrb-list', role: 'list' });
  const histSearch = document.createElement('input');
  histSearch.type = 'search';
  histSearch.className = 'mrb-field__input';
  histSearch.placeholder = tr('tickets.histSearch', 'Filter tickets…', '篩選工單…');
  histSearch.setAttribute('aria-label', tr('tickets.histSearchLabel', 'Filter previous tickets', '篩選之前嘅工單'));
  const clearBtn = ui.el('button', { class: 'mrb-btn mrb-btn--danger', type: 'button' });
  clearBtn.textContent = tr('tickets.clearAll', 'Clear all tickets…', '清除全部工單…');
  const paintHistory = () => {
    histList.textContent = '';
    const q = histSearch.value.toLowerCase();
    const tickets = store.get(TICKETS_KEY, []).filter(
      (t) => !q || `${t.number} ${t.category} ${t.description}`.toLowerCase().includes(q)
    );
    if (tickets.length === 0) {
      const empty = ui.el('li', { class: 'mrb-auth-empty' });
      empty.textContent = tr('tickets.noHistory', 'No tickets yet. May it long continue.', '仲未有工單，可喜可賀。');
      histList.appendChild(empty);
      return;
    }
    for (const t of tickets.slice(0, 50)) {
      const li = ui.el('li', { class: 'mrb-list-row' });
      li.textContent = `${t.number} · ${t.category} · ${t.severity} · ${t.description || '—'}`;
      histList.appendChild(li);
    }
  };
  histSearch.addEventListener('input', paintHistory);
  clearBtn.addEventListener('click', () => {
    ui.superConfirm({
      title: tr('tickets.clearTitle', 'Delete every stored ticket?', '刪除全部已儲存工單？'),
      detailHtml: tr('tickets.clearDetail', 'They exist only here and nobody read them anyway.', '工單只存喺呢度，反正都冇人睇過。'),
      confirmLabel: tr('tickets.clearConfirm', 'Delete tickets', '刪除工單'),
      onConfirm: async () => {
        store.set(TICKETS_KEY, []);
        paintHistory();
      },
    });
  });
  paintHistory();
  historyWrap.append(summary, histSearch, histList, clearBtn);
  panel.appendChild(historyWrap);

  const closePanel = anchorEl ? ui.anchored(anchorEl, panel, {}) : ui.modal({
    title: tr('tickets.title', 'Support Tickets', '支援工單'),
    build: (bodyEl) => bodyEl.appendChild(panel),
    actions: [],
  });
  return Promise.resolve(false);
}

async function buildResolution(hostEl) {
  hostEl.textContent = '';
  const title = ui.el('h4', {});
  title.textContent = tr('tickets.resolutionTitle', 'Resolution: delete the data folder yourself', '解決方法：自己刪除資料夾');
  const explain = ui.el('p', { class: 'mrb-vocab-status' });
  explain.textContent = tr(
    'tickets.resolutionExplain',
    'Deleting this folder resets every lock, every ticket, and every saved preference. The app opens it for you in your own file manager — the deletion itself is always YOUR click, never ours.',
    '刪除呢個資料夾會重設所有鎖頭、工單同偏好設定。App 只會幫你喺檔案管理員開啟資料夾——真正刪除嗰下一定係你自己撳，唔會係我哋代勞。'
  );
  const pathLine = ui.el('code', { class: 'mrb-lockwiz-path' });
  const copyBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-auth-min', type: 'button', disabled: true });
  copyBtn.textContent = tr('tickets.copyPath', 'Copy path', '複製路徑');
  copyBtn.addEventListener('click', async () => {
    try {
      await ui.copyText(pathLine.textContent || '');
    } catch {
      /* ignore */
    }
  });
  const openBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button', disabled: true });
  openBtn.textContent = tr('tickets.openFolder', 'Open the folder', '開啟資料夾');
  openBtn.addEventListener('click', async () => {
    try {
      await ipc('shell:openPath', { path: pathLine.textContent || '' });
    } catch (err) {
      ui.toast({
        title: tr('tickets.openFail', 'Could not open the folder:', '開唔到資料夾：'),
        body: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  });
  const info = await pathsInfo();
  if (info && info.userData) {
    pathLine.textContent = info.userData;
    copyBtn.disabled = false;
    openBtn.disabled = false;
  } else {
    pathLine.textContent = tr('locks.pathUnknown', 'Folder location unavailable right now.', '暫時攞唔到資料夾位置。');
  }
  const actions = ui.el('div', { class: 'mrb-auth-editoractions' }, copyBtn, openBtn);
  hostEl.append(title, explain, pathLine, actions);
}

// ---------------------------------------------------------------------------
// Context-menu wiring + init
// ---------------------------------------------------------------------------

window.addEventListener('mrb-lock-target', (event) => {
  const detail = event.detail || {};
  if (!detail || !(detail.el instanceof Element) && !detail.targetId) return;
  openWizard(detail.el || null, detail);
});

function renderSecurityTab(el) {
  el.textContent = '';
  const head = ui.el('h2', {});
  head.textContent = tr('locks.tabTitle', 'Locks & support', '鎖頭與支援');
  el.appendChild(head);
  const managerHost = ui.el('section', {});
  renderManager(managerHost);
  el.appendChild(managerHost);
  const deskHost = ui.el('div', {});
  const deskBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button' });
  deskBtn.textContent = tr('locks.openTicketsInline', 'Open the Support Tickets desk', '開啟支援工單服務台');
  deskBtn.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : el;
    openTicketsDesk(target);
  });
  deskHost.appendChild(deskBtn);
  el.appendChild(deskHost);
}

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/delight.css', import.meta.url).href);
  } catch {
    /* styling degrades */
  }

  const loads = await Promise.allSettled([
    import('./router.js'),
    import('./palette.js'),
    import('./settings.js'),
    import('./exporter.js'),
    import('./regexbuilder.js'),
  ]);
  routerMod = loads[0].status === 'fulfilled' ? loads[0].value : null;
  paletteMod = loads[1].status === 'fulfilled' ? loads[1].value : null;
  settingsMod = loads[2].status === 'fulfilled' ? loads[2].value : null;
  exporterMod = loads[3].status === 'fulfilled' ? loads[3].value : null;
  regexbuilderMod = loads[4].status === 'fulfilled' ? loads[4].value : null;

  loadLocks();

  if (routerMod && routerMod.router && typeof routerMod.router.registerTab === 'function') {
    try {
      routerMod.router.registerTab({
        id: 'security',
        title: tr('locks.tabStripTitle', 'Locks & support', '鎖頭與支援'),
        icon: '🧷',
        closable: false,
        render: (elNode) => renderSecurityTab(elNode),
      });
    } catch {
      /* router unavailable */
    }
  }

  if (paletteMod && paletteMod.palette && typeof paletteMod.palette.register === 'function') {
    try {
      paletteMod.palette.register([
        {
          id: 'locks.manage',
          title: tr('locks.paletteManage', 'Open Locks & support', '開啟鎖頭與支援'),
          keywords: 'lock unlock password tickets support',
          action: () => {
            if (routerMod && routerMod.router) routerMod.router.navigate('security');
          },
        },
        {
          id: 'locks.tickets',
          title: tr('locks.paletteTickets', 'Open Support Tickets', '開啟支援工單'),
          keywords: 'forgotten password recovery help desk',
          action: () => {
            openTicketsDesk(null);
          },
        },
      ]);
    } catch {
      /* palette unavailable */
    }
  }
}
