/**
 * Renderer bootstrap.
 *
 * Every feature module is loaded through a dynamic import so one missing or
 * failing feature degrades alone: it is logged, counted, surfaced as a
 * non-blocking warning toast, and the rest of the app stays usable. The order
 * follows the development contract's bootstrap sequence, with the settings
 * definitions registered before the router mounts (the router renders the
 * settings tab lazily but needs the definitions) and the personal-vocabulary
 * cache reloaded right after i18n exposes its provider hook.
 */

import { i18n } from './js/core/i18n.js';
import { ui } from './js/core/ui.js';
import { router } from './js/core/router.js';

/**
 * [name, specifier] pairs. Names are stable identifiers used for logging and
 * for the failure summary; specifiers are the fixed paths from the contract.
 * Modules that belong to other lanes are listed too - when a lane has not
 * landed yet its entry simply reports as failed and everything else works.
 */
const BOOT = [
  ['store', './js/core/store.js'],
  ['school', './js/core/school.js'],
  ['i18n', './js/core/i18n.js'],
  ['vocabulary', './js/core/vocabulary.js'],
  ['ui', './js/core/ui.js'],
  ['appearance', './js/core/appearance.js'],
  ['narrator', './js/core/narrator.js'],
  ['adhd', './js/core/adhd.js'],
  ['settings', './js/core/settings.js'],
  ['router', './js/core/router.js'],
  ['regexbuilder', './js/core/regexbuilder.js'],
  ['notify', './js/core/notify.js'],
  ['palette', './js/core/palette.js'],
  ['locks', './js/core/locks.js'],
  ['ladder', './js/core/ladder.js'],
  ['authenticator', './js/core/authenticator.js'],
  ['history', './js/core/history.js'],
  ['exporter', './js/core/exporter.js'],
  ['bulk', './js/core/bulk.js'],
  // Roblox surfaces: the lane's aggregator registers every tab and isolates
  // failures per surface, so the boot manifest loads it once.
  ['roblox', './js/features/roblox/index.js'],
  // Tools and finishing touches.
  ['dimsum', './js/core/dimsum.js'],
  ['converter', './js/core/converter.js'],
  ['ollama', './js/core/ollama.js'],
  ['updater', './js/core/updater.js'],
  ['schedule', './js/core/schedule.js'],
  ['vscode', './js/core/vscode.js'],
];

function bridge() {
  return window.mrb || null;
}

/** Best-effort early appearance: language on <html>, theme before the router paints. */
function syncEarlyAppearance() {
  try {
    document.documentElement.lang = i18n.lang() === 'yue' ? 'zh-Hant' : 'en';
    let theme = 'dark';
    const raw = localStorage.getItem('mrb:settings');
    if (raw) {
      const map = JSON.parse(raw);
      if (map && typeof map === 'object' && typeof map['appearance.theme'] === 'string') {
        theme = map['appearance.theme'];
      }
    }
    document.documentElement.dataset.theme = ['light', 'dark', 'system'].includes(theme)
      ? theme
      : 'dark';
  } catch {
    /* cosmetic only; initialized modules apply the real values later */
  }
}

function wireTitlebar() {
  const buttons = document.querySelectorAll('#mrb-titlebar [data-mrb-win]');
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const action = button.getAttribute('data-mrb-win');
      try {
        await window.mrb.invoke('win:' + action, {});
      } catch {
        /* window operations are best-effort; never block the UI thread of the page */
      }
    });
  }

  const maximizeButton = document.querySelector('[data-mrb-win="toggleMaximize"]');
  if (maximizeButton && window.mrb) {
    window.mrb.on('win:maximized', (isMaximized) => {
      maximizeButton.setAttribute('aria-pressed', isMaximized ? 'true' : 'false');
      maximizeButton.classList.toggle('is-maximized', Boolean(isMaximized));
    });
  }
}

/** Register the global shortcut table entry for the command palette. */
function registerPaletteShortcut() {
  router.registerShortcut('Ctrl+Shift+F', async () => {
    try {
      const mod = await import('./js/core/palette.js');
      if (mod && typeof mod.palette?.open === 'function') {
        mod.palette.open();
      } else {
        ui.toast({
          title: i18n.t('palette.unavailable'),
          tone: 'warn',
        });
      }
    } catch {
      ui.toast({ title: i18n.t('palette.unavailable'), tone: 'warn' });
    }
  }, { id: 'palette.open', desc: i18n.t('palette.shortcutDesc') });
}

async function boot() {
  wireTitlebar();
  syncEarlyAppearance();

  /** @type {{spec: string, error: string}[]} */
  const failed = [];

  for (const [name, spec] of BOOT) {
    try {
      const mod = await import(spec);
      if (mod && typeof mod.init === 'function') {
        await mod.init();
      }
    } catch (error) {
      console.error('[boot]', name, spec, error);
      failed.push({ spec: name, error: error instanceof Error ? error.message : String(error) });
    }

    // Settings definitions must exist before the router mounts so the
    // settings tab renders with real definitions from the first open.
    if (name === 'settings') syncEarlyAppearance();
  }

  if (failed.length > 0) {
    const first = failed[0];
    console.error('[boot] ' + failed.length + ' feature(s) failed to load:', failed);
    try {
      ui.toast({
        title: i18n.t('boot.failedTitle', { count: failed.length }),
        body: first.spec + ': ' + first.error.slice(0, 160),
        tone: 'warn',
        timeoutMs: 12000,
      });
    } catch {
      /* toast surface unavailable - the console record above still stands */
    }
  }

  // Cross-lane glue (integration seam): locked tabs stay out of bulk closes,
  // and an actually-present appearance editor stops the honest not-installed toast.
  try {
    const locks = await import('./js/core/locks.js');
    if (locks && typeof locks.isLocked === 'function' && typeof router.setLockProbe === 'function') {
      router.setLockProbe((targetId) => {
        try { return Boolean(locks.isLocked(targetId)); } catch { return false; }
      });
    }
  } catch { /* locks unavailable - bulk close simply has no lock exclusions */ }
  try {
    const appearance = await import('./js/core/appearance.js');
    if (appearance && typeof appearance.editElement === 'function') {
      window.__mrbAppearanceEditorReady = true;
    }
  } catch { /* appearance unavailable - the router reports that honestly */ }

  registerPaletteShortcut();

  // The router schedules a minimal Home placeholder that only appears when no
  // other lane registered a tab with id "home" by the end of the boot turn.
  router.ensureHomePlaceholder();

  document.dispatchEvent(new CustomEvent('mrb-ready'));
  window.dispatchEvent(new CustomEvent('mrb-ready'));
}

boot();
