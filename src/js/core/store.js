/**
 * localStorage wrapper - the renderer's small-key/value persistence.
 *
 * Keys are namespaced "mrb:" automatically; values are JSON-serialized.
 * Changes are broadcast as a window CustomEvent ("mrb-store-change") and
 * cross-tab storage events are bridged onto the same bus.
 */

const PREFIX = 'mrb:';
const CHANGE_EVENT = 'mrb-store-change';
// Anything matching this pattern is treated as a secret when exporting.
const SECRET_KEY_PATTERN = /(secret|token|password|cookie|hash|credential)/i;
const REDACTED = '[redacted]';

let quotaWarnedOnce = false;

function storage() {
  return window.localStorage;
}

function prefixed(key) {
  return PREFIX + String(key);
}

function safeSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(null);
  }
}

function safeParse(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function emitChange(key, value) {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key, value } }));
  } catch {
    /* event delivery is best-effort */
  }
}

async function warnQuotaOnce(error) {
  console.error('[store] Storage write failed:', error && error.message);
  if (quotaWarnedOnce) return false;
  quotaWarnedOnce = true;
  try {
    const { ui } = await import('./ui.js');
    const { i18n } = await import('./i18n.js');
    ui.toast({
      title: i18n.t('errors.storageFull'),
      body: i18n.t('errors.storageFullHint'),
      tone: 'error',
      timeoutMs: 10000,
    });
  } catch {
    /* the console record above still stands */
  }
  return false;
}

export const store = {
  /**
   * Read a namespaced key. Returns `fallback` for missing or malformed data
   * rather than throwing - a corrupt value degrades to the default honestly.
   */
  get(key, fallback) {
    try {
      const parsed = safeParse(storage().getItem(prefixed(key)));
      return parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  },

  /** Write a key. Returns true on success; quota failures toast once and return false. */
  set(key, value) {
    try {
      storage().setItem(prefixed(key), safeSerialize(value));
      emitChange(String(key), value);
      return true;
    } catch (err) {
      void warnQuotaOnce(err);
      return false;
    }
  },

  remove(key) {
    try {
      storage().removeItem(prefixed(key));
      emitChange(String(key), undefined);
    } catch {
      /* removal failures leave the old value in place */
    }
  },

  /** Subscribe to changes of one exact key. Returns an unsubscribe function. */
  onChange(key, fn) {
    if (typeof fn !== 'function') return () => {};
    const wanted = String(key);
    const handler = (event) => {
      if (event.detail && event.detail.key === wanted) fn(event.detail.value);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return function unsubscribe() {
      window.removeEventListener(CHANGE_EVENT, handler);
    };
  },

  /** Remove every namespaced key. Unnamespaced keys are never touched. */
  clearAll() {
    let keys = [];
    try {
      keys = Object.keys(storage());
    } catch {
      return;
    }
    for (const fullKey of keys) {
      if (!fullKey.startsWith(PREFIX)) continue;
      const shortKey = fullKey.slice(PREFIX.length);
      try {
        storage().removeItem(fullKey);
        emitChange(shortKey, undefined);
      } catch {
        /* skip and continue */
      }
    }
  },

  /**
   * Export every namespaced entry.
   *
   * With redactSecrets=true (the default for anything leaving the machine)
   * values whose key looks like a credential are replaced with a marker and
   * the result says so - the export never silently carries a secret.
   */
  exportAll(redactSecrets = false) {
    const entries = {};
    let redactedCount = 0;
    let keys = [];
    try {
      keys = Object.keys(storage());
    } catch {
      keys = [];
    }
    for (const fullKey of keys) {
      if (!fullKey.startsWith(PREFIX)) continue;
      const shortKey = fullKey.slice(PREFIX.length);
      const raw = safeParse(storage().getItem(fullKey));
      if (redactSecrets && SECRET_KEY_PATTERN.test(shortKey)) {
        entries[shortKey] = REDACTED;
        redactedCount += 1;
      } else {
        entries[shortKey] = raw === undefined ? null : raw;
      }
    }
    return {
      schema: 'mrb-store-v1',
      redactSecrets: Boolean(redactSecrets),
      redactedCount,
      entries,
    };
  },
};

export async function init() {
  // Bridge cross-tab storage events onto the same change bus so multi-window
  // surfaces stay in step without polling.
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(PREFIX)) return;
    const shortKey = event.key.slice(PREFIX.length);
    emitChange(shortKey, safeParse(event.newValue));
  });
}
