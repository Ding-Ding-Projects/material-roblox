/**
 * Roblox lane — Session surface (security-first).
 *
 * Connect flow: a masked paste field for the .ROBLOSECURITY cookie. The value
 * goes straight into the OS-backed encrypted vault over IPC and is never
 * echoed, logged, exported, or rendered anywhere. Verification calls
 * users.authenticated() and shows ONLY the resulting username + userId.
 *
 * Connected state shows identity, Disconnect (destructive → ui.superConfirm
 * two-key + slider gate), a what-is-stored disclosure, an explicit risks
 * note, and Clear-all-local-data (also super-confirmed) wiping localStorage
 * plus every vault key under service "roblox".
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { store } from '../../../core/store.js';
import {
  getSelf, hasSession, refreshSession, clearSelf,
} from '../api.js';
import { tr, voice } from '../peers.js';
import { announce, errorState } from '../cards.js';
import { runDestructiveBatch } from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-session';
const VAULT_SERVICE = 'roblox';
const VAULT_KEY = 'session';

export async function init() {
  const list = typeof router.list === 'function' ? router.list() : [];
  if (list.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.session', 'Session', 'Session'),
    icon: '🔐',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface rbx-session';
  rootEl.appendChild(el('h1', {}, tr('roblox.session.title', 'Session', 'Session')));

  const body = el('div', {});
  rootEl.appendChild(body);

  // Verify the stored cookie silently on open so the identity card is honest.
  if (hasSession()) await paintConnected(body);
  else await paintConnect(body);
}

/* ── Vault bridge helpers ───────────────────────────────────────────────────── */

function vaultInvoke(channel, payload) {
  return window.mrb.invoke(`vault:${channel}`, payload);
}

/** Store the cookie; returns true when the write succeeded. */
async function storeCookie(value) {
  try {
    await vaultInvoke('set', { service: VAULT_SERVICE, key: VAULT_KEY, value });
    return true;
  } catch {
    return false;
  }
}

/** Remove every key under service "roblox" (used by disconnect + wipe). */
async function wipeVaultService() {
  let keys = [];
  try {
    const listed = await vaultInvoke('list', { service: VAULT_SERVICE });
    keys = Array.isArray(listed) ? listed : (Array.isArray(listed?.keys) ? listed.keys : []);
  } catch { /* nothing listable means nothing deletable */ }
  for (const k of keys.map(String)) {
    try { await vaultInvoke('delete', { service: VAULT_SERVICE, key: k }); } catch { /* keep going */ }
  }
}

/* ── Connect flow ───────────────────────────────────────────────────────────── */

function connectIntro() {
  return el('section', { class: 'rbx-card rbx-home__card' },
    el('h2', {}, '🔑 ', tr('roblox.session.connectTitle', 'Connect your Roblox session', '連接你嘅 Roblox session')),
    el('p', {}, tr('roblox.session.intro1',
      'Paste your .ROBLOSECURITY browser cookie to unlock account-scoped data: your balance, transaction summary, presence polling, and friends defaults.',
      '貼上你嘅 .ROBLOSECURITY 瀏覽器 cookie 就可以解鎖帳戶層面嘅數據：餘額、交易摘要、在線狀態輪詢同朋友預設。')),
    el('blockquote', { class: 'rbx-session__risk' },
      el('strong', {}, tr('roblox.session.riskTitle', 'Understand the risk first:', '先了解風險：')),
      el('p', {}, tr('roblox.session.riskBody',
        'This cookie grants full access to your Roblox account while it stays valid. Only paste it on a machine you trust, and never share it with anyone or any other app.',
        '呢個 cookie 喺有效期間會授予你成個 Roblox 帳戶嘅存取權。只可以喺你信任嘅電腦上面貼，亦唔好同任何人或者任何其他 App 分享。'))),
    el('p', { class: 'rbx-muted' }, tr('roblox.session.whereToFind',
      'Find it in your browser’s developer tools → Application/Storage → Cookies → roblox.com → .ROBLOSECURITY.',
      '喺瀏覽器開發者工具 → Application/Storage → Cookies → roblox.com → .ROBLOSECURITY 就搵到。')));
}

async function paintConnect(body) {
  body.textContent = '';
  body.appendChild(connectIntro());

  // A password-type input keeps the cookie masked end to end. The cookie is
  // a single line, so one row suffices; textareas cannot be reliably masked.
  const field = el('input', {
    type: 'password',
    class: 'mrb-field rbx-session__paste',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: tr('roblox.session.pastePlaceholder', 'Paste .ROBLOSECURITY here — it stays hidden', '喺度貼上 .ROBLOSECURITY — 內容保持隱藏'),
    'aria-label': tr('roblox.session.pasteLabel', '.ROBLOSECURITY cookie (masked)', '.ROBLOSECURITY cookie（已遮蔽）'),
  });

  const statusLine = el('p', { class: 'rbx-muted', 'aria-live': 'polite' });

  const connectBtn = el('button', {
    type: 'button', class: 'mrb-btn filled',
    onclick: () => connect(),
    disabled: true,
  }, tr('roblox.session.connectBtn', 'Connect', '連接'));
  field.addEventListener('input', () => { connectBtn.disabled = !field.value.trim(); });
  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); if (!connectBtn.disabled) connect(); }
  });

  body.appendChild(el('section', { class: 'rbx-card rbx-home__card' },
    el('h3', {}, tr('roblox.session.pasteTitle', 'Paste and verify', '貼上並驗證')),
    field,
    el('div', { class: 'rbx-actions' }, connectBtn),
    statusLine));

  async function connect() {
    const value = field.value.trim();
    if (!value) return;
    connectBtn.disabled = true;
    statusLine.textContent = voice('info', tr('roblox.session.verifying', 'Verifying with Roblox…', '正在向 Roblox 驗證……'));

    const stored = await storeCookie(value);
    field.value = ''; // scrub from the DOM immediately
    if (!stored) {
      statusLine.textContent = voice('error', tr('roblox.session.storeFail',
        'Could not reach the encrypted store. Nothing was saved.', '接觸唔到加密儲存庫。乜都冇儲存到。'));
      announce(tr('roblox.session.storeFailAnnounce', 'Vault unavailable', '加密儲存庫用唔到'));
      connectBtn.disabled = false;
      return;
    }

    const result = await refreshSession();
    if (!result.ok) {
      // Cookie rejected: remove it rather than keeping an unusable secret.
      await wipeVaultService();
      statusLine.textContent = voice('error', `${tr('roblox.session.verifyFail', 'Roblox did not accept that cookie.', 'Roblox 唔接受嗰個 cookie。')} ${result.error?.message || ''}`);
      announce(tr('roblox.session.verifyFailAnnounce', 'Verification failed', '驗證失敗'));
      connectBtn.disabled = false;
      return;
    }

    statusLine.textContent = '';
    announce(tr('roblox.session.connectedAnnounce', `Connected as ${result.self.name}`, `已連接為 ${result.self.name}`));
    await paintConnected(body);
  }

  body.appendChild(whatIsStored());
}

/* ── Connected state ────────────────────────────────────────────────────────── */

async function paintConnected(body) {
  body.textContent = '';

  /* verify quietly so stale identities are caught */
  const verify = await refreshSession();
  if (!verify.ok) {
    body.appendChild(errorState(
      verify.error || { status: 401, message: 'Session no longer valid.' },
      {}));
    body.appendChild(el('p', { class: 'rbx-muted' }, tr('roblox.session.expiredNote',
      'The stored cookie was refused, so it was removed. Reconnect to continue.',
      '儲存咗嘅 cookie 被拒絕，所以已經移除。要繼續請重新連接。')));
    body.appendChild(await connectSection());
    return;
  }
  const self = getSelf();

  body.appendChild(el('section', { class: 'rbx-card rbx-home__card' },
    el('h2', {}, '✅ ', tr('roblox.session.connectedTitle', 'Connected', '已連接')),
    el('dl', { class: 'rbx-meta' },
      el('div', { class: 'rbx-meta__row' },
        el('dt', {}, tr('roblox.session.username', 'Username', '用户名')),
        el('dd', {}, self.name)),
      el('div', { class: 'rbx-meta__row' },
        el('dt', {}, tr('roblox.session.userId', 'User ID', '用户 ID')),
        el('dd', {}, String(self.id)))),
    el('p', { class: 'rbx-muted' }, tr('roblox.session.identityOnly',
      'That is all this screen shows about your session — never the cookie itself.',
      '呢個畫面關於你 session 只會顯示呢啲 — 永遠唔會顯示 cookie 本身。')),
    el('div', { class: 'rbx-actions' },
      el('button', {
        type: 'button', class: 'mrb-btn danger',
        onclick: () => disconnect(),
      }, tr('roblox.session.disconnect', 'Disconnect', '斷開連接')))));

  body.appendChild(whatIsStored());
  body.appendChild(clearAllCard());

  async function disconnect() {
    runDestructiveBatch({
      detailHtml: `<p><strong>${tr('roblox.session.dcDetailTitle', 'Disconnect removes your stored session cookie from this device.', '斷開連接會移除本機儲存嘅 session cookie。')}</strong></p>` +
        `<p>${tr('roblox.session.dcDetailBody', 'Account-scoped tabs (Economy, Presence) fall back to their explain-first states until you reconnect.', '帳戶相關分頁（經濟、在線狀態）會回到「先解釋」狀態，直至你重新連接。')}</p>`,
      confirmLabel: tr('roblox.session.dcConfirm', 'Disconnect and delete cookie', '斷開並刪除 cookie'),
      action: async () => {
        await wipeVaultService();
        clearSelf();
        announce(tr('roblox.session.disconnectedAnnounce', 'Disconnected', '已斷開連接'));
        await rerenderConnect();
      },
      done: (ok) => { void ok; },
    });
  }

  /** Re-render this tab's content as the unauthenticated connect flow. */
  async function rerenderConnect() {
    const parent = document.querySelector('.rbx-session');
    if (!parent) return;
    parent.textContent = '';
    parent.appendChild(el('h1', {}, tr('roblox.session.title', 'Session', 'Session')));
    const nb = el('div', {});
    parent.appendChild(nb);
    await paintConnect(nb);
  }
}

/* ── Shared disclosure cards ─────────────────────────────────────────────────── */

function whatIsStored() {
  return el('details', { class: 'rbx-details' },
    el('summary', {}, tr('roblox.session.storedTitle', 'What is stored, exactly?', '實際儲存咗啲乜？')),
    el('div', { class: 'rbx-details__body' },
      el('ul', { class: 'rbx-plainlist' },
        el('li', {}, tr('roblox.session.storedItem1',
          'The .ROBLOSECURITY cookie lives only in the operating-system encrypted vault, under service "roblox". It never appears in localStorage, logs, exports, screenshots, or Git.',
          '.ROBLOSECURITY cookie 只會存在於作業系統嘅加密儲存庫（service "roblox"）。佢永遠唔會出現喺 localStorage、日誌、匯出、截圖或者 Git 入面。')),
        el('li', {}, tr('roblox.session.storedItem2',
          'This app keeps your verified username + user ID locally so tabs can show who is connected.',
          '本 App 會喺本機記低已驗證嘅用户名＋用户 ID，等各分頁知道而家邊個連接緊。')),
        el('li', {}, tr('roblox.session.storedItem3',
          'Saved users, favorites, recent searches, and settings are plain local app data — no account data from Roblox is cached by this lane.',
          '收藏用户、最愛、最近搜尋同設定都係普通本機 App 數據 — 本 lane 唔會快取任何 Roblox 帳戶數據。')))));
}

function clearAllCard() {
  return el('section', { class: 'rbx-card rbx-home__card' },
    el('h3', {}, tr('roblox.session.wipeTitle', 'Clear all local data', '清除所有本機數據')),
    el('p', { class: 'rbx-muted' }, tr('roblox.session.wipeBody',
      'Removes everything this app stored locally: all preferences and saved lists in localStorage, plus every credential under the vault\'s "roblox" service. Your Roblox account itself is untouched.',
      '會移除本 App 儲存嘅所有本機數據：localStorage 入面所有偏好設定同收藏清單，以及加密儲存庫 "roblox" service 下面嘅所有憑證。你嘅 Roblox 帳戶本身完全唔受影響。')),
    el('div', { class: 'rbx-actions' },
      el('button', {
        type: 'button', class: 'mrb-btn danger',
        onclick: () => clearAll(),
      }, tr('roblox.session.wipeBtn', 'Clear all local data…', '清除所有本機數據……'))));

  function clearAll() {
    runDestructiveBatch({
      detailHtml: `<p><strong>${tr('roblox.session.wipeConfirmTitle', 'This wipes every local record this app owns.', '呢個操作會清走本 App 擁有嘅所有本機紀錄。')}</strong></p>` +
        `<ul><li>${tr('roblox.session.wipeConfirmItem1', 'All of this app\'s localStorage records (settings, saved users, favorites, search recents).', '本 App 喺 localStorage 嘅所有紀錄（設定、收藏用户、最愛、搜尋紀錄）。')}</li>` +
        `<li>${tr('roblox.session.wipeConfirmItem2', 'Every stored credential under vault service "roblox" (your session cookie).', '加密儲存庫 "roblox" service 下面嘅所有憑證（你嘅 session cookie）。')}</li></ul>` +
        `<p>${tr('roblox.session.wipeConfirmNote', 'There is no undo. You will need to reconnect and re-save anything you kept.', '冇得復原。之後要重新連接，亦要重新收藏你想留低嘅嘢。')}</p>`,
      confirmLabel: tr('roblox.session.wipeConfirmGo', 'Wipe local data', '清除本機數據'),
      action: async () => {
        // 1. Vault credentials first, so a later failure cannot leave a live
        //    cookie behind a wiped UI.
        await wipeVaultService();
        clearSelf();
        // 2. localStorage via the store facade when it exposes clearAll(),
        //    otherwise every mrb:-prefixed key individually.
        try {
          if (typeof store.clearAll === 'function') {
            store.clearAll();
          } else {
            const doomed = [];
            for (let i = 0; i < window.localStorage.length; i += 1) {
              const k = window.localStorage.key(i);
              if (k && (k.startsWith('mrb:') || k.startsWith('roblox:'))) doomed.push(k);
            }
            doomed.forEach((k) => { try { window.localStorage.removeItem(k); } catch { /* ignore */ } });
          }
        } catch { /* storage already gone */ }
        announce(tr('roblox.session.wipedAnnounce', 'All local data cleared', '所有本機數據已清除'));
      },
      done: async () => {
        // Re-render to the unauthenticated connect flow.
        const parent = document.querySelector('.rbx-session');
        if (parent) {
          const h1 = el('h1', {}, tr('roblox.session.title', 'Session', 'Session'));
          parent.textContent = '';
          parent.append(h1);
          const nb = el('div', {});
          parent.append(nb);
          await paintConnect(nb);
        }
      },
    });
  }
}

/** Standalone connect card used by the expired-session path. */
async function connectSection() {
  const holder = el('div', {});
  await paintConnect(holder);
  return holder;
}
