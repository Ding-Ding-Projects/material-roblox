/**
 * Shared School mode.
 *
 * The active flag and the user-chosen display name live in a SHARED record on
 * disk (via the sharedstore IPC), so every cooperating app switches together,
 * live, without a restart. Turning the mode ON needs nothing. Turning it OFF
 * requires the locally stored unlock credential to verify; the documented
 * escape hatch - deleting the shared record folder - is stated verbatim in
 * the off-flow UI rather than bypassed here.
 *
 * While active: presentation forces English, funny levels drop to 1, personal
 * vocabulary and every dim-sum capability behave as if uninstalled. i18n
 * reads the live checker each call; consumers omit suppressed controls.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

/** Verbatim path shown in recovery and settings copy. */
export const SHARED_FOLDER_DISPLAY = '%APPDATA%\\MaterialRobloxShared';

const VAULT_SERVICE = 'shared';
const VAULT_KEY = 'schoolUnlockHash';
const PBKDF2_ITERATIONS = 210000;
const SALT_BYTES = 16;

let record = { active: false, name: 'School mode', updatedAt: '' };
/** @type {Set<() => void>} */
const listeners = new Set();
let unsubscribeShared = null;

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEquals(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a[index] ^ b[index];
  }
  return mismatch === 0;
}

async function hashPassword(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function notify() {
  window.dispatchEvent(new CustomEvent('mrb-school-changed', { detail: { ...record } }));
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[school] listener failed:', err);
    }
  }
}

async function writePatch(patch) {
  try {
    record = await window.mrb.invoke('sharedstore:write', { patch });
    notify();
  } catch (err) {
    throw new Error(
      (err && err.message ? String(err.message) : 'The shared record refused the change.') +
        ''
    );
  }
}

async function recordHistory(labelText) {
  try {
    const mod = await import('./history.js');
    if (mod && mod.history && typeof mod.history.record === 'function') {
      await mod.history.record({ kind: 'settings', label: labelText });
    }
  } catch {
    /* history lane absent - the change still applies everywhere */
  }
}

export const school = {
  active() {
    return record.active === true;
  },

  /** The user-renamable mode name; renamed apps must never show the shipped name. */
  displayName() {
    return typeof record.name === 'string' && record.name.trim()
      ? record.name
      : 'School mode';
  },

  /**
   * Switch the mode. Turning it ON requires nothing (user freedom). Turning
   * it OFF requires options.credentialOk === true, which only verify() can
   * honestly supply. There is deliberately no code path around that here.
   */
  async set(active, options = {}) {
    if (active === school.active()) return;
    if (!active && options.credentialOk !== true) {
      throw new Error('Turning this mode off requires successful verification.');
    }
    await writePatch({ active });
    void recordHistory(active ? 'School mode turned on' : 'School mode turned off');
  },

  /** User-renamable name lives in the shared record so it propagates too. */
  async setName(name) {
    const trimmed = String(name || '').trim().slice(0, 100);
    if (!trimmed) throw new Error('A non-empty name is required.');
    await writePatch({ name: trimmed });
    void recordHistory('School mode renamed');
  },

  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return function unsubscribe() {
      listeners.delete(fn);
    };
  },

  credential: {
    /** Store a fresh unlock credential as a salted PBKDF2 hash in the vault. */
    async set(password) {
      const value = String(password || '');
      if (value.length < 4) {
        throw new Error('Use at least 4 characters for the unlock credential.');
      }
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const hash = await hashPassword(value, salt);
      await window.mrb.invoke('vault:set', {
        service: VAULT_SERVICE,
        key: VAULT_KEY,
        value: JSON.stringify({
          saltB64: bytesToBase64(salt),
          iter: PBKDF2_ITERATIONS,
          hashB64: bytesToBase64(hash),
        }),
      });
    },

    /** Constant-time verification against the vaulted hash. Never throws on mismatch. */
    async verify(password) {
      try {
        const raw = await window.mrb.invoke('vault:get', {
          service: VAULT_SERVICE,
          key: VAULT_KEY,
        });
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.saltB64 !== 'string' || typeof parsed.hashB64 !== 'string') {
          return false;
        }
        const candidate = await hashPassword(
          String(password ?? ''),
          base64ToBytes(parsed.saltB64)
        );
        const stored = base64ToBytes(parsed.hashB64);
        return constantTimeEquals(candidate, stored);
      } catch {
        // A missing vault or unavailable encryption simply means "cannot verify".
        return false;
      }
    },

    async remove() {
      try {
        await window.mrb.invoke('vault:delete', {
          service: VAULT_SERVICE,
          key: VAULT_KEY,
        });
      } catch {
        /* already gone or vault unavailable */
      }
    },

    async hasCredential() {
      try {
        const keys = await window.mrb.invoke('vault:list', { service: VAULT_SERVICE });
        return Array.isArray(keys) && keys.includes(VAULT_KEY);
      } catch {
        return false;
      }
    },
  },
};

/**
 * Register School-mode settings definitions plus its management card inside
 * the Settings tab. Type "custom" renders module-owned UI in place.
 */
function registerSettingsSurface() {
  import('./settings.js')
    .then(({ settings }) => {
      settings.register([
        {
          key: 'school.manage',
          type: 'custom',
          group: 'school',
          label: { en: 'School mode', yue: '專注模式' },
          explain: {
            en:
              'One switch shared by all cooperating apps on this computer. While it is on, presentation is English-only, playful styling is muted, personal vocabulary and dim-sum features behave as if uninstalled. Your previous choices return when it goes off.',
            yue:
              '呢個開關由電腦上所有合作 app 共用。開住時介面強制英文、趣味效果收細、個人詞彙同點心功能如同未安裝。關閉後之前嘅選擇會返返嚟。',
          },
          render(host) {
            renderSchoolCard(host);
          },
        },
      ]);
    })
    .catch((err) => console.error('[school] settings registration failed:', err));
}

function renderSchoolCard(host) {
  host.replaceChildren();

  const statusLine = ui.el('p', { class: 'mrb-field-support' });

  function paintStatus() {
    statusLine.textContent = school.active()
      ? i18n.t('common.lock') + ': ' + school.displayName() + ' — ON'
      : 'OFF';
  }

  async function repaint() {
    host.replaceChildren();

    const title = ui.el('strong', { text: school.displayName() });
    host.appendChild(title);
    host.appendChild(statusLine);

    if (school.active()) {
      // Off flow: requires verification; escape hatch stated verbatim.
      const passwordInput = ui.el('input', {
        type: 'password',
        placeholder: i18n.t('locks.unlockPrompt'),
        'aria-label': i18n.t('locks.unlockPrompt'),
        autocomplete: 'off',
      });
      const turnOffButton = ui.el('button', {
        type: 'button',
        class: ['mrb-btn', 'filled'],
        text: i18n.t('common.unlock'),
      });
      const feedback = ui.el('p', { class: 'mrb-field-support', role: 'status' });

      turnOffButton.addEventListener('click', async () => {
        feedback.textContent = '';
        const ok = await school.credential.verify(passwordInput.value);
        if (!ok) {
          feedback.textContent =
            i18n.t('locks.wrongAttempt') + ' ' + recoveryLineText();
          return;
        }
        try {
          await school.set(false, { credentialOk: true });
          passwordInput.value = '';
        } catch (err) {
          feedback.textContent = err && err.message ? err.message : 'Failed.';
        }
      });

      const enterHandler = (event) => {
        if (event.key === 'Enter') turnOffButton.click();
      };
      passwordInput.addEventListener('keydown', enterHandler);

      host.append(passwordInput, turnOffButton, feedback);
      host.appendChild(
        ui.el('p', {
          class: 'mrb-field-support',
          role: 'note',
          text: recoveryLineText(),
        })
      );
    } else {
      const turnOnButton = ui.el('button', {
        type: 'button',
        class: ['mrb-btn', 'tonal'],
        text: i18n.t('common.lock'),
      });
      turnOnButton.addEventListener('click', async () => {
        try {
          await school.set(true);
        } catch (err) {
          ui.toast({ title: err && err.message ? err.message : 'Failed.', tone: 'error' });
        }
      });
      host.appendChild(turnOnButton);

      // Credential setup / rename while off.
      const newNameInput = ui.el('input', {
        type: 'text',
        value: school.displayName(),
        'aria-label': 'Mode name',
        style: { maxWidth: '280px' },
      });
      const renameButton = ui.el('button', {
        type: 'button',
        class: ['mrb-btn', 'text'],
        text: i18n.t('common.apply'),
      });
      renameButton.addEventListener('click', async () => {
        try {
          await school.setName(newNameInput.value);
        } catch (err) {
          ui.toast({ title: err && err.message ? err.message : 'Failed.', tone: 'warn' });
        }
      });
      host.append(newNameInput, renameButton);

      const credRow = ui.el('div', { class: 'mrb-searchbar', style: { marginTop: '8px' } });
      const credInput = ui.el('input', {
        type: 'password',
        placeholder: i18n.t('locks.methodPassword'),
        'aria-label': i18n.t('locks.methodPassword'),
        autocomplete: 'new-password',
      });
      const credButton = ui.el('button', {
        type: 'button',
        class: ['mrb-btn', 'outlined'],
        text: i18n.t('common.save'),
      });
      credButton.addEventListener('click', async () => {
        try {
          await school.credential.set(credInput.value);
          credInput.value = '';
          ui.toast({ title: 'Unlock credential saved.', tone: 'ok' });
        } catch (err) {
          ui.toast({ title: err && err.message ? err.message : 'Failed.', tone: 'error' });
        }
      });
      credRow.append(credInput, credButton);
      host.appendChild(credRow);
    }

    paintStatus();
  }

  function recoveryLineText() {
    return i18n.t('locks.recoveryLine').replace('{path}', SHARED_FOLDER_DISPLAY);
  }

  school.onChange(repaint);
  void repaint();
}

export async function init() {
  // Force-English hook: i18n consults this on every call.
  i18n.registerSchoolProvider(() => school.active());

  // Load the shared record once, then follow live changes.
  try {
    record = await window.mrb.invoke('sharedstore:read');
  } catch (err) {
    console.error('[school] Could not read the shared record:', err);
    record = { active: false, name: 'School mode', updatedAt: '' };
  }

  try {
    unsubscribeShared = window.mrb.on('sharedstore:changed', (next) => {
      if (next && typeof next === 'object') {
        record = next;
        notify();
      }
    });
  } catch (err) {
    console.error('[school] Live updates unavailable:', err);
  }

  registerSettingsSurface();

  // Persist a tiny local mirror for surfaces that read localStorage directly.
  store.set('school.snapshot', { active: record.active === true });
}
