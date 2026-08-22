// Tiny localStorage wrapper with change events. Keys are namespaced 'mrb:'.
const NS = 'mrb:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export const store = {
  get: read,
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch { /* storage full or blocked — state stays in memory only */ }
    window.dispatchEvent(new CustomEvent('mrb-store-change', { detail: { key, value } }));
  },
  remove(key) {
    localStorage.removeItem(NS + key);
    window.dispatchEvent(new CustomEvent('mrb-store-change', { detail: { key, value: undefined } }));
  },
  onChange(key, fn) {
    const h = (e) => { if (!key || e.detail.key === key) fn(e.detail.value); };
    window.addEventListener('mrb-store-change', h);
    return () => window.removeEventListener('mrb-store-change', h);
  },
};
