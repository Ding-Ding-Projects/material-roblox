/**
 * updater.js — Chrome-style updates, renderer side (Lane E).
 *
 * Behaviour:
 *  - Checks on start (20 s after boot, so launch never waits on the network)
 *    and then on a bounded interval (`updates.checkIntervalHours`, 1..72,
 *    default 6), plus a manual "Check now" action in Settings and the palette.
 *  - A named state machine drives every visible surface:
 *      upToDate / checking / downloading(bytes) / readyToRestart /
 *      failed(reason)+retry / offline(keeps last known state silently).
 *  - When an update is DOWNLOADED AND STAGED a persistent non-blocking M3
 *    tonal banner appears at the top of the window: new version, release-notes
 *    link (external https), an explicit UNSIGNED-ARTIFACT warning line, and
 *    [Restart to install update] / [Later].
 *  - Restart first fires the cancelable `mrb-unsaved-guard` DOM event so any
 *    surface holding unsaved work can veto; only then does it ask main to
 *    spawn the staged Setup.exe detached and quit.
 *  - The staged file's SHA-256 and size are shown after download; failures are
 *    never dressed up as success and never hidden behind a spinner.
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';
import { ensureToolsStyles } from './colorpicker.js';

const peerCache = new Map();
function peer(name) {
  if (!peerCache.has(name)) peerCache.set(name, import(name).then((m) => m).catch(() => null));
  return peerCache.get(name);
}

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* English always correct */ }
  return en;
}

const invoke = async (channel, payload) => {
  if (!window.mrb || typeof window.mrb.invoke !== 'function') throw new Error('Shell bridge unavailable.');
  return window.mrb.invoke(channel, payload);
};

let state = {
  phase: 'upToDate',
  version: null,
  notesUrl: null,
  bytesDone: 0,
  bytesTotal: 0,
  sha256: null,
  error: null,
  appVersion: '',
};

/* ------------------------------------------------------------------ */
/* surfaces                                                            */
/* ------------------------------------------------------------------ */

let bannerEl = null;
let chipEl = null;

const PHASE_EMOJI = {
  upToDate: '✅',
  checking: '⏳',
  available: '⬇️',
  downloading: '⬇️',
  readyToRestart: '🔁',
  failed: '❌',
  offline: '📴',
};

function phaseLabel(phase) {
  switch (phase) {
    case 'upToDate': return tt('up to date', '已經最新');
    case 'checking': return tt('checking…', '檢查中…');
    case 'available': return tt('update available', '有更新');
    case 'downloading': return tt('downloading…', '下載中…');
    case 'readyToRestart': return tt('ready to restart', '準備好重啟');
    case 'failed': return tt('failed', '失敗');
    case 'offline': return tt('offline', '離線');
    default: return phase;
  }
}

function updateChip() {
  if (!chipEl) return;
  const pct = state.bytesTotal
    ? ` ${Math.round((state.bytesDone / state.bytesTotal) * 100)}%`
    : '';
  chipEl.textContent = `${PHASE_EMOJI[state.phase] || '•'} ${phaseLabel(state.phase)}${state.phase === 'downloading' ? pct : ''}`;
  chipEl.title = state.error || '';
}

/** Persistent non-blocking banner — M3 tonal, top of window, dismissable. */
function showReadyBanner() {
  hideBanner();
  bannerEl = ui.el('div', {
    class: 'mrb-update-banner',
    role: 'status',
    'aria-live': 'polite',
  });
  bannerEl.append(
    ui.el('span', { class: 'mrb-update-banner-icon', text: '🔁', 'aria-hidden': 'true' }),
    ui.el('span', { class: 'mrb-update-banner-text' },
      ui.el('strong', { text: `${tt('Version', '版本')} ${state.version || ''}` }),
      document.createTextNode(` ${tt('available — downloaded and ready to install.', '已有更新 — 下載完成，可以安裝。')}`)),
  );
  const notesBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: tt('View release notes', '睇發佈說明') });
  notesBtn.addEventListener('click', () => {
    if (state.notesUrl) window.mrb?.invoke?.('shell:openExternal', { url: state.notesUrl });
  });
  bannerEl.append(notesBtn);
  bannerEl.append(ui.el('span', {
    class: 'mrb-update-banner-unsigned',
    text: tt('Unsigned build — SmartScreen may ask on first install.', '未簽署版本 — 首次安裝時 SmartScreen 可能會提示。'),
  }));
  const restartBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Restart to install update', '重啟以安裝更新') });
  restartBtn.addEventListener('click', () => requestRestart());
  const laterBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Later', '遲啲先') });
  laterBtn.addEventListener('click', hideBanner);
  bannerEl.append(restartBtn, laterBtn);
  document.body.append(bannerEl);
}

function hideBanner() {
  if (bannerEl) { bannerEl.remove(); bannerEl = null; }
}

/**
 * Ask every surface whether restarting is safe, then hand over to main.
 * Any listener calling preventDefault() vetoes the restart.
 */
export async function requestRestart() {
  let vetoed = false;
  try {
    const ev = new CustomEvent('mrb-unsaved-guard', { cancelable: true, detail: { action: 'update-restart' } });
    window.dispatchEvent(ev);
    vetoed = ev.defaultPrevented;
  } catch (_) { /* guard event optional */ }
  if (vetoed) {
    ui.toast?.({
      title: tt('Restart postponed', '暫緩重啟'),
      body: tt('Something in the app still has unsaved work. Save it, then restart from the Updates card.', '應用程式仲有未儲存的嘢；儲存之後再喺「更新」卡度重啟。'),
      tone: 'warn', timeoutMs: 7000,
    });
    return false;
  }
  try {
    const res = await invoke('update:restart', {});
    if (!res.ok) throw new Error(res.reason || 'nothing staged');
    return true;
  } catch (err) {
    setState({ phase: 'failed', error: String(err.message || err) });
    return false;
  }
}

function setState(patch) {
  const prev = state.phase;
  state = { ...state, ...patch };
  updateChip();
  renderCard();
  if (state.phase === 'readyToRestart' && prev !== 'readyToRestart') showReadyBanner();
  if ((state.phase === 'downloading' || state.phase === 'checking') && bannerEl) hideBanner();
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function checkNow({ announce = true } = {}) {
  setState({ phase: 'checking' });
  try {
    const res = await invoke('update:check', {});
    applyServerState(res.state || {});
    if (announce) {
      if (res.updateAvailable) {
        ui.toast?.({
          title: `${tt('Version', '版本')} ${state.version} ${tt('is available', '有得更新')}`,
          body: tt('It will download automatically.', '會自動下載。'),
          tone: 'info', timeoutMs: 6000,
        });
      }
    }
    if (res.updateAvailable) downloadNow();
    else if (announce) {
      ui.toast?.({
        title: tt('You are up to date', '已經係最新版'),
        body: `${tt('Installed', '目前')}: ${state.appVersion}`,
        tone: 'ok', timeoutMs: 5000,
      });
    }
  } catch (err) {
    setState({ phase: 'failed', error: String(err.message || err) });
  }
}

async function downloadNow() {
  setState({ phase: 'downloading', bytesDone: 0, bytesTotal: state.bytesTotal || 0 });
  try {
    const res = await invoke('update:download', {});
    if (!res.ok) {
      setState({ phase: 'failed', error: String(res.error || 'download failed') });
      /* hash mismatch / truncation deletes the staged file main-side */
      return;
    }
    setState({ phase: 'readyToRestart', sha256: res.sha256, bytesTotal: res.bytes });
  } catch (err) {
    setState({ phase: 'failed', error: String(err.message || err) });
  }
}

function applyServerState(s) {
  setState({
    phase: s.phase || state.phase,
    version: s.version ?? state.version,
    notesUrl: s.notesUrl ?? state.notesUrl,
    bytesDone: s.bytesDone ?? state.bytesDone,
    bytesTotal: s.bytesTotal ?? state.bytesTotal,
    sha256: s.sha256 ?? state.sha256,
    error: s.error ?? state.error,
  });
}

let checkTimer = null;
function scheduleChecks() {
  clearTimeout(checkTimer);
  let hours = 6;
  try {
    const raw = store.get('updates.checkIntervalHours', 6);
    hours = Math.min(Math.max(Math.round(Number(raw)) || 6, 1), 72);
  } catch (_) { /* shipped interval stands */ }
  checkTimer = setTimeout(async () => {
    await checkNow({ announce: false });
    scheduleChecks();
  }, hours * 3600 * 1000);
}

/* ------------------------------------------------------------------ */
/* Updates card (tab)                                                  */
/* ------------------------------------------------------------------ */

let cardBody = null;

function registerTab() {
  peer('./router.js').then((routerM) => {
    const router = routerM && routerM.router;
    if (!router || typeof router.registerTab !== 'function') return;
    router.registerTab({
      id: 'updates',
      title: tt('Updates', '更新'),
      icon: '⬆️',
      closable: true,
      group: 'settings',
      render(el) { el.append(buildCard()); },
    });
  }).catch(() => { /* router optional */ });
}

function buildCard() {
  const card = ui.el('section', { class: 'mrb-card mrb-updates-card' },
    ui.el('h2', {}, '⬆️ ', document.createTextNode(tt('Updates', '更新'))));
  card.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt(
      'Updates come from this project\'s GitHub Releases over HTTPS. Builds are UNSIGNED by policy — nothing verifies a publisher signature, and the installer may trigger a first-run warning.',
      '更新來自本項目嘅 GitHub Releases（HTTPS）。按政策全部唔簽署 — 冇任何簽章驗證，安裝時可能彈首次執行警告。',
    ),
  }));

  cardBody = ui.el('div', { class: 'mrb-updates-statebody' });
  card.append(cardBody);

  const row = ui.el('div', { class: 'mrb-converter-toolbar' });
  const checkBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Check now', '即刻檢查') });
  checkBtn.addEventListener('click', () => checkNow());
  const retryBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Retry', '再試') });
  retryBtn.addEventListener('click', async () => {
    if (state.phase === 'failed' && state.version) await downloadNow();
    else await checkNow();
  });
  const restartBtn = ui.el('button', { class: 'mrb-btn mrb-btn-danger mrb-btn-sm', type: 'button', text: tt('Restart to install', '重啟並安裝') });
  restartBtn.addEventListener('click', () => requestRestart());
  row.append(checkBtn, retryBtn, restartBtn);
  card.append(row);
  renderCard();
  return card;
}

function renderCard() {
  if (!cardBody || !document.contains(cardBody)) return;
  cardBody.textContent = '';

  const grid = ui.el('dl', { class: 'mrb-updates-grid' });
  const addRow = (label, value) => grid.append(
    ui.el('dt', { text: label }),
    ui.el('dd', { text: value }),
  );
  addRow(tt('Status', '狀態'), `${PHASE_EMOJI[state.phase] || ''} ${phaseLabel(state.phase)}`);
  addRow(tt('Installed version', '已安裝版本'), state.appVersion || '?');
  if (state.version) addRow(tt('Latest version', '最新版本'), state.version);
  if (state.phase === 'downloading') {
    addRow(tt('Downloaded', '已下載'), `${ui.fmtBytes(state.bytesDone)} / ${ui.fmtBytes(state.bytesTotal || 0)}`);
  }
  if (state.sha256) addRow('SHA-256', state.sha256);
  if (state.error) addRow(tt('Last error', '最近錯誤'), state.error);
  cardBody.append(grid);

  if (state.phase === 'readyToRestart') {
    cardBody.append(ui.el('p', { class: 'mrb-explain', text: tt('The installer is staged locally. Restarting hands over to it and closes the app.', '安裝程式已備好；重啟會交接並關閉本程式。') }));
  }
  if (state.phase === 'failed') {
    cardBody.append(ui.el('p', { class: 'mrb-explain', role: 'alert', text: `${tt('The last attempt failed:', '上次失敗：')} ${state.error}. ${tt('Retry keeps your data untouched.', '再試一次唔會影響你嘅資料。')}` }));
  }
  if (state.phase === 'offline') {
    cardBody.append(ui.el('p', { class: 'mrb-explain', text: tt('Offline — keeping the last known state; no fake success here.', '離線 — 保留最後已知狀態；唔會假裝成功。') }));
  }
}

/* ------------------------------------------------------------------ */
/* settings defs                                                       */
/* ------------------------------------------------------------------ */

function registerSettingDefs() {
  peer('./settings.js').then((m) => {
    const settings = m && m.settings;
    if (!settings || typeof settings.register !== 'function') return;
    settings.register([
      {
        key: 'updates.checkIntervalHours', type: 'slider', def: 6, group: 'Updates', min: 1, max: 72, step: 1,
        label: { en: 'Check interval (hours)', yue: '檢查間隔（小時）' },
        explain: { en: 'How often to look for a new release. A manual check is always available.', yue: '隔幾耐檢查一次新版本；隨時可以手動檢查。' },
      },
      {
        key: 'updates.autoDownload', type: 'toggle', def: true, group: 'Updates',
        label: { en: 'Download updates automatically', yue: '自動下載更新' },
        explain: { en: 'Stages the installer in the background. Installing still waits for YOUR restart click.', yue: '背景預先落好安裝檔；安裝仍然等你親自㩒重啟。' },
      },
    ]);
    settings.onChange(() => scheduleChecks());
  }).catch(() => { /* settings optional */ });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
export async function init() {
  ensureToolsStyles();

  chipEl = ui.el('button', {
    class: 'mrb-update-chip',
    type: 'button',
    'aria-label': tt('Update status', '更新狀態'),
    title: tt('Update status — opens the Updates card', '更新狀態 — 開啟更新卡'),
  });
  chipEl.addEventListener('click', () => {
    peer('./router.js').then((m) => { if (m && m.router) m.router.navigate('updates'); });
  });
  document.body.append(chipEl);

  try {
    const info = await invoke('update:info', {});
    state.appVersion = info.version || '';
    applyServerState(info.state || {});
  } catch (_) { /* bridge absent: chip shows unknown state honestly */ }

  registerSettingDefs();
  registerTab();

  try {
    const paletteM = await peer('./palette.js');
    if (paletteM && paletteM.palette && typeof paletteM.palette.register === 'function') {
      paletteM.palette.register({
        id: 'updates.checkNow',
        title: tt('Check for updates now', '即刻檢查更新'),
        group: tt('Updates', '更新'),
        keywords: ['upgrade', 'version'],
        control: (rowEl) => {
          const b = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Check', '檢查') });
          b.addEventListener('click', () => checkNow());
          rowEl.append(b);
        },
        teleport: 'updates',
      });
    }
  } catch (_) { /* palette optional */ }

  if (window.mrb && typeof window.mrb.on === 'function') {
    window.mrb.on('update:progress', (p) => {
      setState({ bytesDone: p.bytesDone, bytesTotal: p.bytesTotal });
    });
    window.mrb.on('update:state', (s) => applyServerState(s));
  }

  /* first check 20 s after boot so startup never blocks on the network */
  setTimeout(() => { checkNow({ announce: false }); }, 20000);
  scheduleChecks();
}
