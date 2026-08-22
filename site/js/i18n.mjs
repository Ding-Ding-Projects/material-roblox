// Site i18n: English / playful Hong Kong-style Cantonese / bilingual modes,
// per-language funny levels (voice only — facts never change), and the
// personal-vocabulary replacement boundary. All local, no network.

import { store } from './store.mjs';

export const CAT_EN = {
  'app.name': 'Material Roblox',
  'nav.home': 'Home', 'nav.features': 'Features', 'nav.docs': 'Docs',
  'nav.changelog': 'Changelog', 'nav.download': 'Download', 'nav.status': 'Status',
  'nav.settings': 'Settings', 'nav.about': 'About',
  'skip': 'Skip to main content',
  'hero.title': 'Explore Roblox, in Material Design 3',
  'hero.sub': 'A fast local desktop explorer for Roblox platform APIs — users, friends, groups, games, marketplace and more. No account needed for public data; nothing phones home.',
  'hero.download': 'Download installer',
  'hero.docs': 'Read the docs',
  'home.features': 'Feature overview',
  'home.shots': 'Screenshots',
  'shots.pending': 'Capture pending — ultra-speed delivery pass skipped screenshot evidence; see roadmap',
  'dl.title': 'Download',
  'dl.requirements': 'Requirements',
  'dl.req.body': 'Windows 10 or later, 64-bit. ~90 MB installed.',
  'dl.squirrel.h': 'Squirrel.Windows installer',
  'dl.squirrel.b': 'The installer is a genuine Squirrel.Windows package: it installs per-user without admin rights, self-updates in the background, and can be uninstalled cleanly from Windows Settings.',
  'dl.unsigned': 'Unsigned build — by policy, not accident',
  'dl.unsigned.b': 'This project never signs its installers. Microsoft Defender SmartScreen may show an “unknown publisher” warning; choose More info → Run anyway if you trust this build. No signature verification is claimed anywhere.',
  'dl.checking': 'Checking whether the latest release is published…',
  'dl.ready': 'Latest release verified on GitHub Releases.',
  'dl.pending': 'Not published yet — the download unlocks automatically once the first release run lands.',
  'dl.error': 'Could not reach GitHub to verify the release right now. The link stays disabled rather than guessing.',
  'dl.portable': 'Portable ZIP: not offered. Squirrel handles updates and clean uninstall; a parallel portable route would split update integrity.',
  'dl.teaser': 'Recent changes',
  'docs.title': 'Documentation',
  'docs.search': 'Search articles…',
  'docs.empty': 'No articles match your search.',
  'docs.loadfail': 'This article could not be loaded. It may not be deployed yet — check back after the next Pages run.',
  'cl.title': 'Changelog',
  'cl.search': 'Search changelog…',
  'cl.empty': 'No releases recorded yet. Entries appear after the first tagged release.',
  'cl.export': 'Export filtered view (Markdown)',
  'cl.dish': 'Code name',
  'st.title': 'Status',
  'st.empty': 'No published workflow runs recorded yet — statuses appear after the first release run',
  'st.actions': 'Open repository Actions',
  'set.title': 'Settings',
  'set.search': 'Search settings…',
  'about.title': 'About',
  'foot.license': 'Released under the MIT License.',
  'foot.disclaimer': 'Material Roblox is an independent open-source project and is not affiliated with, endorsed by, or connected to Roblox Corporation.',
  'foot.repo': 'Source on GitHub',
  'toast.dismiss': 'Dismiss',
};

export const CAT_YUE = {
  'app.name': 'Material Roblox',
  'nav.home': '主頁', 'nav.features': '功能', 'nav.docs': '文檔',
  'nav.changelog': '更新日誌', 'nav.download': '下載', 'nav.status': '狀態',
  'nav.settings': '設定', 'nav.about': '關於',
  'skip': '跳去主要內容',
  'hero.title': '用 Material Design 3 玩轉 Roblox 資料',
  'hero.sub': '一個又快又企理嘅桌面工具，專門睇 Roblox 平台 API——用戶、朋友、群組、遊戲、市集樣樣有。公開資料唔使登入，亦都冇嘢偷偷上網。',
  'hero.download': '下載安裝程式',
  'hero.docs': '睇說明書',
  'home.features': '功能一覽',
  'home.shots': '畫面截圖',
  'shots.pending': '截圖仲未影——超高速出貨嗰次刻意跳咗截圖證圖證據；睇下路線圖啦',
  'dl.title': '下載',
  'dl.requirements': '系統需求',
  'dl.req.body': 'Windows 10 或以上，64 位元。裝完約 90 MB。',
  'dl.squirrel.h': 'Squirrel.Windows 安裝程式',
  'dl.squirrel.b': '真材實料嘅 Squirrel.Windows 包：唔要管理員權限、按使用者安裝，背景自動更新，喺 Windows 設定度可以乾乾淨淨解除安裝。',
  'dl.unsigned': '無簽署版本——係政策，唔係意外',
  'dl.unsigned.b': '呢個項目永遠唔會簽署安裝檔。Microsoft Defender SmartScreen 可能會話「不明發佈者」；信得過就㩒「更多資訊」→「仍要執行」。邊度都冇聲稱過有簽章驗證。',
  'dl.checking': '而家查緊最新版本出咗未……',
  'dl.ready': '已經確認 GitHub Releases 有最新版。',
  'dl.pending': '仲未發佈——第一次 release 跑完，個掣就會自動解鎖。',
  'dl.error': '而家連唔到 GitHub 驗證版本。寧願保持停用，都唔會亂估。',
  'dl.portable': '便攜 ZIP：唔提供。Squirrel 一手包辦更新同解除安裝；多開一條便攜路線只會拆散更新完整性。',
  'dl.teaser': '最近改動',
  'docs.title': '說明文件',
  'docs.search': '搵文章……',
  'docs.empty': '冇文章啱你搜嘅字。',
  'docs.loadfail': '呢篇文章載入唔到，可能仲未部署——下次 Pages 跑完再嚟睇啦。',
  'cl.title': '更新日誌',
  'cl.search': '搜尋日誌……',
  'cl.empty': '仲未有 release 記錄。第一個 tag 出咗之後就會有。',
  'cl.export': '匯出現時篩選（Markdown）',
  'cl.dish': '點心代號',
  'st.title': '狀態',
  'st.empty': '仲未有已發佈嘅 workflow 記錄——第一次 release 跑完就會見到',
  'st.actions': '打開 repo 嘅 Actions',
  'set.title': '設定',
  'set.search': '搜尋設定……',
  'about.title': '關於',
  'foot.license': '以 MIT 授權條款發佈。',
  'foot.disclaimer': 'Material Roblox 係獨立開源項目，同 Roblox Corporation 冇任何隸屬、認可或關連。',
  'foot.repo': 'GitHub 原始碼',
  'toast.dismiss': '閂咗佢',
};

// Playful voice variants used at funny level >= 4. Facts live elsewhere.
const FUNNY = {
  en: {
    'hero.sub': 'A quick, tidy desktop window into Roblox platform APIs — users, friends, groups, games, marketplace, the lot. Public data works with no sign-in, and nothing quietly phones home. Promise.',
    'dl.pending': 'Still warming up — the download button unlocks itself the moment the first release run lands.',
    'st.empty': 'No workflow runs on the board yet — statuses show up after the first release run brings snacks',
  },
  yue: {
    'hero.sub': '一個又快又企理嘅桌面窗口，直接望穿 Roblox 平台 API——用戶朋友群組遊戲市集，一嘢晒冷。公開資料免登入，仲有乜嘢偷偷上網？冇。講真。',
    'dl.pending': '仲焗緊爐——第一次 release 出爐，個掣即刻自己彈開俾你㩒。',
    'st.empty': '看板上仲未有 workflow 跑數——第一次 release 跑完帶埋點心上嚟先有得睇',
  },
};

const state = {
  lang: store.get('lang', 'en'),           // 'en' | 'yue' | 'bi'
  funnyEn: store.get('funny.en', 5),
  funnyYue: store.get('funny.yue', 5),
  quietStudy: false,                        // set by settings; suppresses delight copy
  vocab: null,                              // {replacements:{from:to}}
};

function applyVocab(text) {
  const v = state.vocab;
  if (!v || !v.replacements) return text;
  let out = text;
  for (const [from, to] of Object.entries(v.replacements)) {
    if (typeof from === 'string' && typeof to === 'string' && from) {
      out = out.split(from).join(to);
    }
  }
  return out;
}

export const i18n = {
  lang: () => state.lang,
  setLang(mode) { state.lang = mode; store.set('lang', mode); applyDocumentLang(); },
  funny: (which) => (which === 'yue' ? state.funnyYue : state.funnyEn),
  setFunny(which, n) {
    n = Math.max(1, Math.min(5, Number(n) || 1));
    if (which === 'yue') { state.funnyYue = n; store.set('funny.yue', n); }
    else { state.funnyEn = n; store.set('funny.en', n); }
    document.documentElement.classList.toggle(`funny-${n}`, n >= 4);
  },
  setQuietStudy(on) { state.quietStudy = !!on; },

  t(key, params) {
    const lvlEn = state.quietStudy ? 1 : state.funnyEn;
    const lvlYue = state.quietStudy ? 1 : state.funnyYue;
    const pick = (cat, which, lvl) => {
      let s = cat[key];
      if (!s) return undefined;
      if (lvl >= 4 && !state.quietStudy) {
        const alt = (FUNNY[which] || {})[key];
        if (alt) s = alt;
      }
      return s;
    };
    let text;
    switch (state.lang) {
      case 'yue': text = pick(CAT_YUE, 'yue', lvlYue) ?? pick(CAT_EN, 'en', lvlEn) ?? key; break;
      case 'bi': text = pick(CAT_EN, 'en', lvlEn) ?? key; break;
      default: text = pick(CAT_EN, 'en', lvlEn) ?? key;
    }
    if (params) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return applyVocab(text);
  },

  /** Renders a translated string as DOM nodes honouring bilingual mode. */
  node(key, params) {
    const span = document.createElement('span');
    span.dataset.i18n = key;
    fillNode(span, key, params);
    return span;
  },

  voice(category, text) {
    // Playful wrapper by category+level; the factual `text` passes untouched.
    const lvl = Math.max(state.funnyEn, state.funnyYue);
    if (state.quietStudy || lvl < 4) return text;
    const deco = { info: ' ✦', ok: ' ✔︎', warn: ' ⚠︎', error: ' ‼', neutral: '' }[category] || '';
    return text + deco;
  },

  async loadVocabularyFile(fileObj) {
    try {
      if (fileObj.size > 256 * 1024) return { ok: false, error: 'File exceeds the 256 KiB limit.' };
      const text = await fileObj.text();
      const json = JSON.parse(text);
      if (json?.version !== 1) return { ok: false, error: 'Unsupported schema version (expected version: 1).' };
      const reps = json.replacements;
      if (!reps || typeof reps !== 'object' || Array.isArray(reps)) return { ok: false, error: 'Missing "replacements" object.' };
      const keys = Object.keys(reps);
      if (keys.length > 5000) return { ok: false, error: 'More than 5000 entries.' };
      for (const k of keys) {
        if (typeof reps[k] !== 'string') return { ok: false, error: `Replacement for "${k}" is not a string.` };
        if (k.length > 200 || reps[k].length > 400) return { ok: false, error: 'Key/value length bound exceeded.' };
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return { ok: false, error: 'Unsafe object key rejected.' };
      }
      state.vocab = { replacements: reps };
      store.set('vocab.cache', state.vocab);
      rerender();
      return { ok: true, count: keys.length };
    } catch (e) {
      return { ok: false, error: `Malformed JSON: ${e.message}` };
    }
  },
  clearVocabulary() {
    state.vocab = null;
    store.remove('vocab.cache');
    rerender();
  },
  hasVocabulary: () => !!state.vocab,

  applyToDom(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((n) => fillNode(n));
  },
};

function fillNode(node, key = node.dataset.i18n, params) {
  if (!key) return;
  const primary = (() => {
    if (state.lang === 'yue') return CAT_YUE[key] ?? CAT_EN[key] ?? key;
    return CAT_EN[key] ?? CAT_YUE[key] ?? key;
  })();
  const secondary = state.lang === 'bi'
    ? ((state.lang === 'bi') ? (CAT_YUE[key] ?? '') : '') : '';

  const lvlPrimary = state.lang === 'yue' ? state.funnyYue : state.funnyEn;
  let pText = primary;
  const funnySet = state.lang === 'yue' ? FUNNY.yue : FUNNY.en;
  if (lvlPrimary >= 4 && !state.quietStudy && funnySet[key]) pText = funnySet[key];

  node.textContent = '';
  const main = document.createElement('span');
  main.className = 'funnyable';
  main.textContent = applyVocab(pText);
  node.append(main);
  if (state.lang === 'bi' && secondary) {
    const sec = document.createElement('span');
    sec.className = 'yue-sec';
    sec.lang = 'yue-Hant-HK';
    sec.textContent = applyVocab(secondary);
    node.append(sec);
  }
}

function applyDocumentLang() {
  document.documentElement.lang = state.lang === 'yue' ? 'yue-Hant-HK' : 'en';
}

function rerender() { i18n.applyToDom(document); }

export function initI18n() {
  const cached = store.get('vocab.cache', null);
  if (cached && cached.replacements) state.vocab = cached;
  applyDocumentLang();
  const lvl = Math.max(state.funnyEn, state.funnyYue);
  if (lvl >= 4) document.documentElement.classList.add(`funny-${lvl}`);
}
