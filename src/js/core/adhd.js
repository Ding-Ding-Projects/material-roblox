'use strict';

/**
 * Attention modes — five INDEPENDENT, off-by-default accommodations:
 *   Focus · Low stimulation · Time awareness · One thing at a time · Momentum
 *
 * Tone rules implemented here: copy states facts ("nothing has changed here
 * for 45 minutes") and never judges, scores, ranks, streaks, or congratulates.
 * Nothing here is medical: these are interface accommodations, named for what
 * they DO. Every mode composes independently with the others, and School mode
 * does not suppress any of them — attention accommodations are orthogonal to
 * presentation language (documented in the feature docs).
 *
 * Low-stimulation toast reduction is implemented as a wrapper around ui.toast
 * installed ONLY while the mode is on. Boot order guarantees this module runs
 * before the notification centre wraps the same function, so suppressed toasts
 * still reach the reviewable centre/journal while skipping their visible
 * popup. The original reference is restored verbatim when the mode goes off.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

const IDLE_THRESHOLD_MS = 45 * 60 * 1000;
const ACTIVITY_SAMPLE_MS = 30000;

let settingsMod = null;
let routerMod = null;

let toastWrapInstalled = false;
let capturedToast = null; // whatever ui.toast was when we wrapped it

let lastActivityAt = Date.now();
let workDirty = false;
let momentumTimer = null;
let exitPill = null;
let titlebarChip = null;
let tickTimer = null;

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

function getSetting(path, fallback) {
  if (settingsMod && settingsMod.settings) {
    try {
      const v = settingsMod.settings.get(path, fallback);
      if (v !== undefined) return v;
    } catch {
      /* fall through */
    }
  }
  const stored = store.get(`mrb:setting:${path}`, fallback);
  return stored === undefined ? fallback : stored;
}

function setSetting(path, value) {
  if (settingsMod && settingsMod.settings) {
    try {
      settingsMod.settings.set(path, value);
      return;
    } catch {
      /* fall through */
    }
  }
  store.set(`mrb:setting:${path}`, value);
}

// ---------------------------------------------------------------------------
// Mode application
// ---------------------------------------------------------------------------

function applyModes() {
  const body = document.body;
  const flags = [];
  if (getSetting('adhd.focus.enabled', false)) flags.push('focus');
  if (getSetting('adhd.lowstim.enabled', false)) flags.push('lowstim');
  body.dataset.adhd = flags.join(' ');

  // Focus never hides or removes anything — dimming is opacity-only and one
  // obvious pill exits the mode from anywhere.
  if (flags.includes('focus')) ensureExitPill();
  else removeExitPill();

  if (flags.includes('lowstim')) installToastWrap();
  else uninstallToastWrap();

  updateTimeAwareness(flags.includes('time'));
}

// --- Focus ---------------------------------------------------------------

function ensureExitPill() {
  if (exitPill || !document.body) return;
  exitPill = ui.el('button', {
    class: 'mrb-btn mrb-btn--filled mrb-adhd-exitpill',
    type: 'button',
    onclick: () => setSetting('adhd.focus.enabled', false),
  });
  exitPill.textContent = tr('adhd.exitFocus', 'Exit focus', '離開專注模式');
  document.body.appendChild(exitPill);
}

function removeExitPill() {
  if (exitPill) {
    exitPill.remove();
    exitPill = null;
  }
  if (document.body) delete document.body.dataset.mrbSpotlit;
}

function bindSpotlightTracking() {
  // Marking the active panel lets the stylesheet dim everything else without
  // ever removing it from the page or the accessibility tree.
  const mark = (event) => {
    if (!(document.body.dataset.adhd || '').includes('focus')) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const panel =
      target.closest('.mrb-card, [role="tabpanel"], .mrb-dialog, section, article') || null;
    document.querySelectorAll('.mrb-adhd-spotlit').forEach((elNode) => {
      elNode.classList.remove('mrb-adhd-spotlit');
    });
    if (panel) panel.classList.add('mrb-adhd-spotlit');
  };
  document.addEventListener('focusin', mark, true);
  document.addEventListener('click', mark, true);
}

// --- Low stimulation ------------------------------------------------------

function installToastWrap() {
  if (toastWrapInstalled || typeof ui.toast !== 'function') return;
  try {
    capturedToast = ui.toast;
    /**
     * @param {Object} spec
     */
    ui.toast = (spec = {}) => {
      const tone = String(spec.tone || 'info');
      const hasActions = Array.isArray(spec.actions) && spec.actions.length > 0;
      const mustShow = tone === 'error' || tone === 'warn' || hasActions;
      if (!mustShow) {
        // Hidden from the screen, still recorded downstream by the centre,
        // still narratable-by-nothing (this skips the narrator layer too).
        return `lowstim-suppressed-${Date.now()}`;
      }
      return capturedToast(spec);
    };
    toastWrapInstalled = true;
  } catch {
    /* frozen export or absent function: suppression degrades to no-op */
  }
}

function uninstallToastWrap() {
  if (!toastWrapInstalled) return;
  try {
    if (typeof capturedToast === 'function') ui.toast = capturedToast;
  } catch {
    /* nothing sensible to restore onto a frozen export */
  }
  capturedToast = null;
  toastWrapInstalled = false;
}

// --- Time awareness -------------------------------------------------------

function fmtElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function ensureTitlebarChip() {
  if (titlebarChip || !document.body) return;
  const bar = document.querySelector('.mrb-titlebar');
  if (!bar) return;
  titlebarChip = ui.el('span', { class: 'mrb-adhd-timechip', role: 'timer' });
  titlebarChip.title = tr('adhd.sessionLength', 'This session has been open for:', '呢個工作階段已開咗：');
  bar.appendChild(titlebarChip);
}

function updateLastChangedFootnotes() {
  if (!document.body) return;
  const groups = document.querySelectorAll(
    '[data-setting-group], .mrb-settings-group, .mrb-settings-section'
  );
  groups.forEach((groupEl) => {
    const key =
      groupEl.getAttribute('data-setting-group') ||
      groupEl.getAttribute('data-group') ||
      groupEl.id ||
      '';
    if (!key) return;
    const changedAt = Number(store.get(`mrb:adhd.changed.${key}`, 0)) || 0;
    let note = groupEl.querySelector(':scope > .mrb-adhd-lastchange');
    if (!changedAt) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = document.createElement('p');
      note.className = 'mrb-adhd-lastchange';
      groupEl.appendChild(note);
    }
    const mins = Math.floor((Date.now() - changedAt) / 60000);
    note.textContent = tr(
      'adhd.lastChanged',
      `Last changed ${mins} min ago`,
      `${mins} 分鐘前改過`
    );
  });
}

function bindChangeTracking() {
  // Any persisted change refreshes that group's "last changed" stamp and
  // counts as started work for momentum purposes.
  window.addEventListener('mrb-store-change', (event) => {
    const detail = event.detail || {};
    const key = String(detail.key || '');
    if (!key.startsWith('mrb:') || key.includes('adhd.')) return;
    const group = key.slice(4).split('.')[0];
    if (!group) return;
    store.set(`mrb:adhd.changed.${group}`, Date.now());
    workDirty = true;
  });

  // Ambient input only refreshes the activity clock; the dirty flag is set by
  // surfaces calling markActive() deliberately, never by a stray mouse wiggle.
  const noteActivity = () => {
    lastActivityAt = Date.now();
  };
  window.addEventListener('click', noteActivity, { passive: true });
  window.addEventListener('keydown', noteActivity, { passive: true });
  window.addEventListener('pointermove', noteActivity, { passive: true });
}

function updateTimeAwareness(on) {
  if (on) ensureTitlebarChip();
  else if (titlebarChip) {
    titlebarChip.remove();
    titlebarChip = null;
  }
  if (tickTimer) clearInterval(tickTimer);
  if (on) {
    const startedAt = Number(store.get('mrb:adhd.startedAt', 0)) || Date.now();
    store.set('mrb:adhd.startedAt', startedAt);
    tickTimer = setInterval(() => {
      if (titlebarChip) titlebarChip.textContent = fmtElapsed(Date.now() - startedAt);
      updateLastChangedFootnotes();
    }, 1000);
    updateLastChangedFootnotes();
  }
}

// --- One thing at a time ---------------------------------------------------

function renderOneThingBanner() {
  const existing = document.querySelector('.mrb-adhd-onething');
  if (existing) existing.remove();
  if (!getSetting('adhd.onething.enabled', false)) return;
  try {
    if (sessionStorage.getItem('mrb:adhd.onethingDismissed') === '1') return;
  } catch {
    /* per-session dismissal unavailable: banner simply always shows */
  }
  const text = String(getSetting('adhd.oneThing.text', '') || '');
  if (!text.trim()) return; // honest empty state lives in settings, not here

  const banner = ui.el('div', { class: 'mrb-card mrb-adhd-onething', role: 'region' });
  const label = ui.el('span', { class: 'mrb-badge' });
  label.textContent = tr('adhd.nextAction', 'Current next action', '而家下一步');
  const body = ui.el('p', { class: 'mrb-adhd-onething-text' });
  body.textContent = text; // user-authored, rendered verbatim
  const doneBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--text',
    type: 'button',
    onclick: () => {
      try {
        sessionStorage.setItem('mrb:adhd.onethingDismissed', '1');
      } catch {
        /* ignore */
      }
      banner.remove();
    },
  });
  doneBtn.textContent = tr('adhd.doneForNow', 'Not now', '陣間先');
  banner.append(label, body, doneBtn);

  const mountAfter = document.querySelector('.mrb-titlebar');
  if (mountAfter && mountAfter.parentElement) {
    mountAfter.parentElement.insertBefore(banner, mountAfter.nextSibling);
  } else {
    document.body.prepend(banner);
  }
}

// --- Momentum ----------------------------------------------------------------

/**
 * Record meaningful activity. Any surface may call this to mark the work area
 * as actively used (and therefore "dirty" for momentum purposes).
 */
export function markActive() {
  lastActivityAt = Date.now();
  workDirty = true;
}

function snoozeKey(kind) {
  const now = new Date();
  if (kind === 'today') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }
  const hours = kind === '2h' ? 2 : 0.5;
  return Date.now() + hours * 3600000;
}

function checkMomentum() {
  if (!getSetting('adhd.momentum.enabled', false)) return;
  const snoozedUntil = Number(store.get('mrb:adhd.momentumSnoozeUntil', 0)) || 0;
  if (Date.now() < snoozedUntil) return;
  if (!workDirty) return; // untouched-but-also-unstarted is nobody's business
  if (Date.now() - lastActivityAt < IDLE_THRESHOLD_MS) return;

  const minutes = Math.floor(IDLE_THRESHOLD_MS / 60000);
  ui.toast({
    title: tr('adhd.momentumTitle', `Nothing has changed here for ${minutes} minutes`, `呢度${minutes}分鐘冇變過`),
    body: tr('adhd.momentumBody', 'That is just a fact, not a nudge.', '淨係講個事實，唔係催你。'),
    tone: 'info',
    timeoutMs: 0,
    sticky: true,
    actions: [
      {
        label: tr('adhd.snooze30', 'Snooze 30 min'),
        run: () => store.set('mrb:adhd.momentumSnoozeUntil', snoozeKey('30m')),
      },
      {
        label: tr('adhd.snooze2h', 'Snooze 2 h'),
        run: () => store.set('mrb:adhd.momentumSnoozeUntil', snoozeKey('2h')),
      },
      {
        label: tr('adhd.snoozeToday', 'Until tomorrow'),
        run: () => store.set('mrb:adhd.momentumSnoozeUntil', snoozeKey('today')),
      },
    ],
  });
}

// ---------------------------------------------------------------------------

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/delight.css', import.meta.url).href);
  } catch {
    /* styling degrades */
  }

  const loads = await Promise.allSettled([import('./settings.js'), import('./router.js')]);
  settingsMod = loads[0].status === 'fulfilled' ? loads[0].value : null;
  routerMod = loads[1].status === 'fulfilled' ? loads[1].value : null;

  if (settingsMod && settingsMod.settings && typeof settingsMod.settings.register === 'function') {
    try {
      settingsMod.settings.register([
        {
          key: 'adhd.focus.enabled',
          type: 'toggle',
          def: false,
          group: 'Attention modes',
          label: { en: 'Focus — dim everything but the active panel', yue: '專注 — 淨係亮住目前嗰塊' },
          explain: {
            en: 'Diminishes non-active panels using opacity only. Nothing is hidden or removed; an Exit focus pill stays available everywhere.',
            yue: '用透明度調低其他面板，唔會收埋或刪走任何嘢；任何位置都有「離開專注模式」掣。',
          },
        },
        {
          key: 'adhd.lowstim.enabled',
          type: 'toggle',
          def: false,
          group: 'Attention modes',
          label: { en: 'Low stimulation — quieter colours and motion', yue: '低刺激 — 色同動靜收細' },
          explain: {
            en: 'Desaturates surfaces, stops non-essential animation, and shows pop-up notifications only for errors, warnings, and things needing an action. Everything still lands in the notification centre.',
            yue: '表面減色、停非必要動畫，彈出通知淨係剩錯誤、警告同行動項；全部照樣入通知中心。',
          },
        },
        {
          key: 'adhd.time.enabled',
          type: 'toggle',
          def: false,
          group: 'Attention modes',
          label: { en: 'Time awareness — show elapsed time where you work', yue: '時間感 — 工作位顯示經過時間' },
          explain: {
            en: 'Adds a small elapsed-session clock and a "last changed N min ago" line under each settings group. States numbers; never nags.',
            yue: '加一個小時計同每組設定下面「幾耐之前改過」，只報數，唔會催。',
          },
        },
        {
          key: 'adhd.onething.enabled',
          type: 'toggle',
          def: false,
          group: 'Attention modes',
          label: { en: 'One thing at a time — show my current next action', yue: '一次一件 — 顯示目前下一步' },
          explain: {
            en: 'Shows a gentle banner carrying the sentence YOU wrote below. It survives restarts; dismissing lasts until the next launch.',
            yue: '顯示你自己寫嗰句下一步，重開都喺度；撳「陣間先」就去到下次啟動為止。',
          },
        },
        {
          key: 'adhd.oneThing.text',
          type: 'text',
          def: '',
          group: 'Attention modes',
          label: { en: 'My current next action', yue: '我而家嘅下一步' },
          explain: {
            en: 'Your own words, shown verbatim in the banner. Leave empty to show nothing.',
            yue: '你自己寫嘅句子會照字顯示；留空就乜都唔顯示。',
          },
        },
        {
          key: 'adhd.momentum.enabled',
          type: 'toggle',
          def: false,
          group: 'Attention modes',
          label: { en: 'Momentum — mention long unchanged stretches', yue: '動量 — 提一提長時間冇變' },
          explain: {
            en: 'Once, after 45 quiet minutes on started work, says so plainly and offers real snoozes (30 min / 2 h / until tomorrow). No streaks, no scores.',
            yue: '開始咗嘅工作靜咗45分鐘後提一次，可以真係貪睡（半粒鐘／兩粒鐘／聽日）。冇紀錄卡冇分數。',
          },
        },
      ]);
    } catch {
      /* settings surface unavailable; modes still toggle via stored defaults */
    }
  }

  bindSpotlightTracking();
  bindChangeTracking();

  // React live to any of the five switches flipping.
  const watchKeys = [
    'mrb:setting:adhd.focus.enabled',
    'mrb:setting:adhd.lowstim.enabled',
    'mrb:setting:adhd.time.enabled',
    'mrb:setting:adhd.onething.enabled',
    'mrb:setting:adhd.oneThing.text',
    'mrb:setting:adhd.momentum.enabled',
  ];
  watchKeys.forEach((key) => {
    try {
      store.onChange(key, () => {
        applyModes();
        renderOneThingBanner();
      });
    } catch {
      /* store events unavailable; next boot applies */
    }
  });

  momentumTimer = setInterval(checkMomentum, 60000);
  applyModes();
  renderOneThingBanner();

  // Navigation re-renders content: re-hang the one-thing banner and footnotes.
  if (routerMod && routerMod.router && typeof routerMod.router.navigate === 'function') {
    try {
      window.addEventListener('mrb-route-changed', () => {
        renderOneThingBanner();
        updateLastChangedFootnotes();
      });
    } catch {
      /* best effort */
    }
  }
}
