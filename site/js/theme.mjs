// Theme engine: light/dark/system, accent seed or rainbow sentinel, density,
// fonts — plus the scheduled-rules engine (local-time windows, weekday sets,
// cross-midnight semantics, last-matching-rule precedence).

import { store } from './store.mjs';

const base = {
  theme: 'system',        // light | dark | system
  accent: '#e05a47',      // hex or {rainbow:true}
  rainbowSpeed: 2,        // level 1..5 -> duration mapping below
  density: 'cozy',        // compact | cozy | comfortable
  fontStack: 'system-ui',
  fontScale: 1,
  fontWeight: 400,
};

export const RAINBOW_LEVELS = { 1: '40s', 2: '24s', 3: '16s', 4: '10s', 5: '6s' };

export function applyAppearance(p = {}) {
  const prefs = { ...base, ...store.get('appearance', {}), ...p };
  document.documentElement.dataset.theme = resolveTheme(prefs.theme);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(prefs.accent)) {
    delete document.documentElement.dataset.accent;
    const h = hexHue(prefs.accent);
    document.documentElement.style.setProperty('--mrb-accent-h', String(h));
  } else {
    // Rainbow sentinel: stylesheet-driven via one global duration variable.
    document.documentElement.dataset.accent = 'rainbow';
    document.documentElement.style.setProperty('--mrb-rainbow-duration', RAINBOW_LEVELS[prefs.rainbowSpeed] || RAINBOW_LEVELS[2]);
  }
  document.documentElement.dataset.density = prefs.density;
  document.documentElement.style.setProperty('--mrb-scale', String(prefs.fontScale));
  const stacks = FONT_STACKS[prefs.fontStack] || FONT_STACKS['system-ui'];
  document.documentElement.style.setProperty('--mrb-font-body', stacks.body);
  document.body.style.fontWeight = String(prefs.fontWeight);
  return prefs;
}

function resolveTheme(mode) {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function hexHue(hex) {
  let s = hex.replace('#', '');
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}

export const FONT_STACKS = {
  'system-ui': { label: 'System UI', body: "system-ui, 'Segoe UI Variable', 'Segoe UI', Roboto, sans-serif" },
  'segoe': { label: 'Segoe UI', body: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" },
  'roboto': { label: 'Roboto (if installed)', body: "Roboto, system-ui, sans-serif" },
  'noto-hk': { label: 'Noto Sans HK (if installed)', body: "'Noto Sans HK', system-ui, sans-serif" },
  'georgia': { label: 'Georgia (serif)', body: "Georgia, 'Times New Roman', serif" },
  'cascadia': { label: 'Cascadia / mono', body: "'Cascadia Code', ui-monospace, Consolas, monospace" },
};

window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyAppearance());

/* ---------------- scheduled rules ---------------- */
// Rule: {id,label,type:'theme'|'accent'|'density'|'lang',value,start:{h,m},
//        end:{h,m},days:[0-6],enabled}

export function getRules() { return store.get('schedule.rules', []); }
export function setRules(rules) {
  store.set('schedule.rules', rules);
  evaluateRules(true);
}

function inWindow(now, rule) {
  if (!rule.enabled) return false;
  if (rule.days && rule.days.length && !rule.days.includes(now.getDay())) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = rule.start.h * 60 + rule.start.m;
  const end = rule.end.h * 60 + rule.end.m;
  // Cross-midnight windows span midnight; equal start/end is zero-length.
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

let lastAppliedSig = '';
export function evaluateRules(force = false) {
  const rules = getRules();
  const now = new Date();
  let winner = null;
  for (const r of rules) if (inWindow(now, r)) winner = r; // later matching rule wins
  const sig = winner ? `${winner.id}:${winner.type}:${winner.value}` : '';
  if (!force && sig === lastAppliedSig) return winner;
  lastAppliedSig = sig;

  const appearancePatch = {};
  if (winner?.type === 'theme') appearancePatch.theme = winner.value;
  if (winner?.type === 'accent') appearancePatch.accent = winner.value;
  if (winner?.type === 'density') appearancePatch.density = winner.value;
  if (Object.keys(appearancePatch).length) applyAppearance(appearancePatch);
  if (winner?.type === 'lang') window.dispatchEvent(new CustomEvent('mrb-schedule-lang', { detail: winner.value }));
  return winner;
}

export function initSchedule() {
  evaluateRules(true);
  setInterval(() => evaluateRules(), 30_000);
}
