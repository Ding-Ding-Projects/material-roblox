'use strict';

/**
 * Spoken narrator for app events. OFF by default; enabling is entirely the
 * user's choice, but the implementation ships regardless.
 *
 * Behavior contract implemented here:
 *  - Serialized queue: exactly one utterance plays at a time.
 *  - Supersede rule: a higher-priority utterance of the same category replaces
 *    that category's still-waiting entries rather than stacking behind them.
 *  - Per-category cooldowns (15s; 8s for errors). Errors are NEVER dropped by
 *    the cooldown — they are deferred until it expires, so a genuine failure
 *    always ends up spoken.
 *  - Both-language mode speaks English then Cantonese strictly in sequence.
 *  - Voice pickers exist PER LANGUAGE, default to "Choose automatically"
 *    (never a named voice), handle late platform enumeration, persist a
 *    stable voice identity triple instead of a display name, and state the
 *    effective voice plus every fallback/caveat beneath the picker.
 *  - Ducks under an active screen reader (best-effort, honestly labelled),
 *    honors a quiet-hours window for everything except errors, and passes all
 *    narration copy through i18n.voice so funny-level styling applies while
 *    facts stay exact.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

const COOLDOWN_MS_DEFAULT = 15000;
const COOLDOWN_MS_ERROR = 8000;
const AUTO = '__auto__';

/** @type {Map<string,number>} category -> last spoken timestamp */
const lastSpokenAt = new Map();
/** @type {Array<{text:string, opts:Object, resolve:Function}>} */
let queue = [];
let speakingNow = false;

let settingsMod = null;
let routerMod = null;
let paletteMod = null;

let toastWrapInstalled = false;
let originalToast = null;

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

// --- settings access (Settings module is optional; degrade to the store) ---

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

// --- speech engine ------------------------------------------------------

function synth() {
  return typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;
}

function listVoices(which) {
  const s = synth();
  if (!s) return [];
  const all = s.getVoices() || [];
  return all.filter((v) => {
    const lang = String(v.lang || '').toLowerCase().replace('_', '-');
    return which === 'yue' ? /^(yue|zh-hk|zh-yue)/.test(lang) : /^en/.test(lang);
  });
}

function identityOf(voice) {
  return JSON.stringify({ uri: voice.voiceURI, lang: voice.lang, name: voice.name });
}

function findVoice(which) {
  const voices = listVoices(which);
  if (voices.length === 0) return null;
  const savedRaw = getSetting(`narrator.voice.${which}`, '');
  if (savedRaw) {
    try {
      const saved = JSON.parse(savedRaw);
      const exact = voices.find((v) => v.voiceURI === saved.uri && v.lang === saved.lang && v.name === saved.name);
      if (exact) return exact;
      // Chosen-but-not-installed: fall back automatically, choice stays kept.
      const byUri = voices.find((v) => v.voiceURI === saved.uri);
      if (byUri) return byUri;
    } catch {
      /* corrupt identity falls back below */
    }
  }
  return null; // Choose automatically → platform default
}

function statusLineFor(which) {
  const s = synth();
  if (!s) return tr('narrator.noEngine', 'Speech synthesis is not available in this environment.');
  const voices = listVoices(which);
  if (voices.length === 0) {
    return tr(
      `narrator.noVoices.${which}`,
      which === 'en'
        ? 'No English voice is installed on this computer — nothing will be spoken for English.'
        : 'No Cantonese-capable voice is installed on this computer — nothing will be spoken for Cantonese.'
    );
  }
  const savedRaw = getSetting(`narrator.voice.${which}`, '');
  if (savedRaw) {
    try {
      const saved = JSON.parse(savedRaw);
      const exact = voices.find((v) => v.voiceURI === saved.uri && v.lang === saved.lang && v.name === saved.name);
      if (exact) {
        return offlineNote(exact, tr('narrator.effective', 'Will speak with:') + ` ${exact.name}`);
      }
      const byUri = voices.find((v) => v.voiceURI === saved.uri);
      if (byUri) {
        return (
          tr(
            'narrator.fallback',
            'The chosen voice is not installed under that exact profile any more — falling back to:'
          ) +
          ` ${byUri.name}. ` +
          tr('narrator.choiceKept', 'Your choice is kept in case it returns.')
        );
      }
      return tr(
        'narrator.chosenMissing',
        'The chosen voice is not installed on this computer — falling back to the system default. Your choice is kept.'
      );
    } catch {
      /* corrupt identity */
    }
  }
  return tr(
    'narrator.automatic',
    'Choose automatically — the system picks its default voice for this language.'
  );
}

function offlineNote(voice, base) {
  if (voice.localService === false) {
    return `${base} ${tr('narrator.networkVoice', 'That voice is provided over the network and will go quiet when offline.')}`;
  }
  return base;
}

// --- queue --------------------------------------------------------------

function pumpQueue() {
  if (speakingNow) return;
  const next = queue.shift();
  if (!next) return;
  speakingNow = true;
  try {
    playUtterance(next.text, next.opts).catch(() => {});
  } finally {
    // Utterances report their own end asynchronously; release happens there.
  }
}

function releaseAndPump() {
  speakingNow = false;
  setTimeout(pumpQueue, 60); // small gap prevents engine overlap glitches
}

function playUtterance(text, opts) {
  const s = synth();
  if (!s) {
    releaseAndPump();
    return Promise.resolve();
  }
  const seq = [];
  const lang = opts.lang === 'both' ? 'both' : opts.lang === 'yue' ? 'yue' : 'en';
  // Both-language mode speaks English first, then the Cantonese track —
  // strictly serialized. A missing Cantonese variant simply drops that part.
  const parts =
    lang === 'both'
      ? [{ text, which: 'en' }, { text: opts._yueText || '', which: 'yue' }]
      : [{ text, which: lang }];
  const playable = parts.filter((p) => p.text);
  if (playable.length === 0) {
    releaseAndPump();
    return Promise.resolve();
  }

  playable.forEach((part, index) => {
    const utter = new SpeechSynthesisUtterance(part.text);
    const which = part.which;
    utter.lang = which === 'yue' ? 'zh-HK' : 'en-US';
    const chosen = findVoice(which);
    if (chosen) {
      utter.voice = chosen;
      utter.lang = chosen.lang;
    }
    utter.rate = clamp(Number(getSetting(`narrator.rate.${which}`, 1)), 0.5, 2);
    utter.pitch = clamp(Number(getSetting(`narrator.pitch.${which}`, 1)), 0, 2);
    if (screenReaderDefers() && (opts.category || 'info') !== 'error') {
      utter.volume = 0.25; // ducked, never silent — honest best-effort coexistence
    }
    seq.push(
      new Promise((resolve) => {
        utter.addEventListener('end', resolve, { once: true });
        utter.addEventListener('error', resolve, { once: true });
        s.speak(utter);
      }).then(() => {
        if (index === playable.length - 1) releaseAndPump();
      })
    );
  });

  return Promise.all(seq);
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function screenReaderDefers() {
  if (!getSetting('narrator.deferToScreenReader', true)) return false;
  // Best-effort assistive-technology sniffing; stated plainly in the UI as
  // best-effort because no standard runtime signal exists across platforms.
  const ua = navigator.userAgent || '';
  return /NVDA|JAWS|VoiceOver|Orca|Narrator/i.test(ua);
}

function inQuietHours(now = new Date()) {
  const start = String(getSetting('narrator.quietStart', '') || '');
  const end = String(getSetting('narrator.quietEnd', '') || '');
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // cross-midnight window
}

/**
 * Speak one line. Serialized; superseding within a category; cooldowns apply
 * except that error-category lines are deferred rather than dropped.
 * @param {string} text
 * @param {{lang?:'en'|'yue'|'both', category?:string, priority?:'normal'|'high', yueText?:string}} [opts]
 */
export function speak(text, opts = {}) {
  if (!getSetting('narrator.enabled', false)) return;
  const category = opts.category || 'info';
  const isError = category === 'error';

  if (!isError && inQuietHours()) return;
  if (screenReaderDefers() && !isError) return; // errors still speak, quietly

  const now = Date.now();
  const cooldown = isError ? COOLDOWN_MS_ERROR : COOLDOWN_MS_DEFAULT;
  const last = lastSpokenAt.get(category) || 0;
  const waitMs = last + cooldown - now;
  if (waitMs > 0) {
    if (isError) {
      setTimeout(() => speak(text, opts), waitMs + 20); // deferred, never dropped
      return;
    }
    return; // non-error chatter inside its cooldown window is skipped
  }

  // Supersede: same-category pending items are replaced by higher priority.
  if (opts.priority === 'high' || isError) {
    queue = queue.filter((item) => (item.opts.category || 'info') !== category);
  }

  lastSpokenAt.set(category, Date.now());
  queue.push({
    text: String(text == null ? '' : text),
    opts: {
      ...opts,
      _yueText: opts.yueText || '',
    },
    resolve: () => {},
  });
  pumpQueue();
}

/** Stop speaking immediately and clear the waiting queue. */
export function stopSpeaking() {
  queue = [];
  const s = synth();
  if (s) s.cancel();
  speakingNow = false;
}

// --- toast narration hook ----------------------------------------------

function installToastHook() {
  if (toastWrapInstalled || typeof ui.toast !== 'function') return;
  try {
    originalToast = ui.toast.bind(ui);
    /** @param {Object} spec */
    ui.toast = (spec = {}) => {
      const id = originalToast(spec);
      try {
        window.dispatchEvent(
          new CustomEvent('mrb-toast-shown', {
            detail: { id, title: spec.title || '', tone: spec.tone || 'info' },
          })
        );
      } catch {
        /* narration must never break toasting */
      }
      return id;
    };
    toastWrapInstalled = true;
  } catch {
    /* frozen exports or missing function: narration simply skips toasts */
  }
}

let toastListenerBound = false;
/** Toast id -> narrated timestamp; guards a double emission within 1.5s. */
const narratedToasts = new Map();
function bindToastNarration() {
  if (toastListenerBound) return;
  toastListenerBound = true;
  window.addEventListener('mrb-toast-shown', (event) => {
    const detail = event.detail || {};
    // If the notification centre ALSO emits this event, the second copy
    // arrives with the same id moments later — speak it once.
    const key = detail.id == null ? '' : String(detail.id);
    const nowTs = Date.now();
    if (key && nowTs - (narratedToasts.get(key) || 0) < 1500) return;
    if (key) {
      narratedToasts.set(key, nowTs);
      for (const [k, t] of narratedToasts) if (nowTs - t > 4000) narratedToasts.delete(k);
    }
    if (!detail.title) return;
    const toneToCategory = { ok: 'ok', warn: 'warn', error: 'error', info: 'info' };
    const category = toneToCategory[detail.tone] || 'info';
    let styled = detail.title;
    try {
      styled = i18n.voice(category, String(detail.title));
    } catch {
      /* unstyled fallback above keeps facts exact anyway */
    }
    let mode = getSetting('narrator.languageMode', 'follow');
    if (mode === 'follow') {
      try {
        const lang = i18n.lang();
        mode = lang === 'bi' ? 'both' : lang;
      } catch {
        mode = 'en';
      }
    }
    // Toast titles are final rendered strings, so a separate Cantonese track
    // only exists when one was produced upstream; otherwise Both speaks the
    // single available line rather than reading the same words twice.
    const yueTrack =
      mode === 'both' && typeof detail.yueTitle === 'string' ? detail.yueTitle : '';
    speak(styled, { lang: mode, category, yueText: yueTrack });
  });
}

// ---------------------------------------------------------------------------

function buildVoicePicker(bodyEl, which) {
  const fieldLabel =
    which === 'en'
      ? tr('narrator.voiceEn', 'English voice')
      : tr('narrator.voiceYue', 'Cantonese voice');
  const label = ui.el('label', { class: 'mrb-field__label' });
  label.textContent = fieldLabel;
  const select = document.createElement('select');
  select.className = 'mrb-select mrb-narr-picker';
  select.setAttribute('aria-label', fieldLabel);

  const populate = () => {
    select.textContent = '';
    const auto = document.createElement('option');
    auto.value = AUTO;
    auto.textContent = tr('narrator.autoVoice', 'Choose automatically');
    select.appendChild(auto);
    for (const v of listVoices(which)) {
      const opt = document.createElement('option');
      opt.value = identityOf(v);
      opt.textContent = `${v.name} (${v.lang})`;
      select.appendChild(opt);
    }
    const savedRaw = getSetting(`narrator.voice.${which}`, '');
    if (savedRaw && ![...select.options].some((o) => o.value === savedRaw)) {
      // Chosen voice not currently installed: keep it selectable and visible.
      try {
        const parsed = JSON.parse(savedRaw);
        const opt = document.createElement('option');
        opt.value = savedRaw;
        opt.textContent = `${parsed.name || 'Saved voice'} (${parsed.lang || '?'} — not installed)`;
        select.appendChild(opt);
      } catch {
        /* ignore malformed */
      }
    }
    select.value = savedRaw || AUTO;
  };
  populate();

  // Platforms commonly answer the first getVoices() with an empty list and
  // fill it in moments later — repopulate on that event, every time.
  const s = synth();
  const onVoicesChanged = () => populate();
  if (s) s.addEventListener('voiceschanged', onVoicesChanged);

  select.addEventListener('change', () => {
    setSetting(`narrator.voice.${which}`, select.value === AUTO ? '' : select.value);
    status.textContent = statusLineFor(which);
  });

  const status = ui.el('p', { class: 'mrb-narr-status' });
  status.textContent = statusLineFor(which);

  const sliderBlock = (pathKey, labelText, min, max, step) => {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'mrb-slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(getSetting(pathKey, pathKey.endsWith('.pitch') ? 1 : 1));
    input.id = `mrb-narr-${pathKey}`;
    const lab = ui.el('label', { class: 'mrb-field__label', for: input.id });
    lab.textContent = labelText;
    const out = ui.el('span', { class: 'mrb-badge' });
    out.textContent = String(input.value);
    input.addEventListener('input', () => {
      setSetting(pathKey, Number(input.value));
      out.textContent = String(input.value);
    });
    const wrap = ui.el('div', { class: 'mrb-field' });
    wrap.append(lab, input, out);
    return wrap;
  };

  const testBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button' });
  testBtn.textContent = tr('narrator.testSpeak', 'Test this voice');
  testBtn.addEventListener('click', () => {
    const sample = tr('narrator.sample', 'This is how announcements will sound.', '呢把聲就係之後廣播嘅樣子。');
    setSetting('narrator.enabled', true);
    speak(sample, {
      lang: which === 'en' ? 'en' : 'yue',
      category: 'neutral',
      priority: 'high',
    });
  });

  const wrap = ui.el('section', { class: 'mrb-card mrb-narr-pickerCard' });
  wrap.append(label, select, status, sliderBlock(`narrator.rate.${which}`, tr('narrator.rate', 'Speaking rate'), 0.5, 2, 0.05), sliderBlock(`narrator.pitch.${which}`, tr('narrator.pitch', 'Pitch'), 0, 2, 0.05), testBtn);
  return wrap;
}

function renderTab(el) {
  el.textContent = '';

  const intro = ui.el('p', { class: 'mrb-narr-intro' });
  intro.textContent = tr(
    'narrator.intro',
    'The narrator reads app events aloud. It stays off until you turn it on here.',
    '旁白會讀出應用程式事件，預設關閉，喺度先開得。'
  );

  const enableWrap = ui.el('div', { class: 'mrb-field mrb-field--row' });
  const enableId = 'mrb-narr-enabled';
  const enableInput = document.createElement('input');
  enableInput.type = 'checkbox';
  enableInput.className = 'mrb-switch';
  enableInput.id = enableId;
  enableInput.checked = !!getSetting('narrator.enabled', false);
  const enableLabel = ui.el('label', { for: enableId });
  enableLabel.textContent = tr('narrator.enableToggle', 'Enable the narrator');
  enableInput.addEventListener('change', () => {
    setSetting('narrator.enabled', enableInput.checked);
    if (!enableInput.checked) stopSpeaking();
  });
  enableWrap.append(enableInput, enableLabel);

  const deferWrap = ui.el('div', { class: 'mrb-field mrb-field--row' });
  const deferId = 'mrb-narr-defer';
  const deferInput = document.createElement('input');
  deferInput.type = 'checkbox';
  deferInput.className = 'mrb-switch';
  deferInput.id = deferId;
  deferInput.checked = !!getSetting('narrator.deferToScreenReader', true);
  const deferLabel = ui.el('label', { for: deferId });
  deferLabel.textContent = tr(
    'narrator.defer',
    'Duck under screen readers (best-effort)'
  );
  deferInput.addEventListener('change', () => setSetting('narrator.deferToScreenReader', deferInput.checked));
  deferWrap.append(deferInput, deferLabel);
  const deferNote = ui.el('p', { class: 'mrb-narr-status' });
  deferNote.textContent = tr(
    'narrator.deferNote',
    'Detection of running screen readers is best-effort; when one seems active, narration volume drops sharply instead of competing with it.',
    '偵測螢幕閱讀器屬最佳努力；偵測到時旁白會大幅調低音量，唔會同佢鬥大聲。'
  );

  const quietRow = ui.el('div', { class: 'mrb-field mrb-field--row mrb-narr-quiet' });
  const mkTime = (key, labelText) => {
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'mrb-field__input';
    input.value = String(getSetting(key, ''));
    const id = `mrb-${key.replace(/\./g, '-')}`;
    input.id = id;
    const lab = ui.el('label', { for: id });
    lab.textContent = labelText;
    input.addEventListener('change', () => setSetting(key, input.value));
    const holder = ui.el('div', { class: 'mrb-field' });
    holder.append(lab, input);
    return holder;
  };
  quietRow.append(
    mkTime('narrator.quietStart', tr('narrator.quietStart', 'Quiet hours start')),
    mkTime('narrator.quietEnd', tr('narrator.quietEnd', 'Quiet hours end'))
  );
  const quietNote = ui.el('p', { class: 'mrb-narr-status' });
  quietNote.textContent = tr(
    'narrator.quietNote',
    'During quiet hours everything except genuine errors stays silent. Cross-midnight windows are supported.',
    '靜音時段內除咗真正錯誤之外全部收聲，支援跨午夜時段。'
  );

  const pickers = ui.el('div', { class: 'mrb-narr-pickers' });
  pickers.append(buildVoicePicker(pickers, 'en'), buildVoicePicker(pickers, 'yue'));

  el.append(intro, enableWrap, deferWrap, deferNote, quietRow, quietNote, pickers);
}

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/delight.css', import.meta.url).href);
  } catch {
    /* styling degrades */
  }

  const loads = await Promise.allSettled([
    import('./settings.js'),
    import('./router.js'),
    import('./palette.js'),
  ]);
  settingsMod = loads[0].status === 'fulfilled' ? loads[0].value : null;
  routerMod = loads[1].status === 'fulfilled' ? loads[1].value : null;
  paletteMod = loads[2].status === 'fulfilled' ? loads[2].value : null;

  if (!synth()) {
    console.warn('[narrator] speechSynthesis unavailable; the feature stays present but silent.');
  }

  // Settings group registration (core switches live here; rich voice control
  // lives on the Narration tab registered below).
  if (settingsMod && settingsMod.settings && typeof settingsMod.settings.register === 'function') {
    try {
      settingsMod.settings.register([
        {
          key: 'narrator.enabled',
          type: 'toggle',
          def: false,
          group: 'Narration',
          label: { en: 'Enable the narrator', yue: '開啟旁白' },
          explain: {
            en: 'Speaks app events aloud. Off until you switch it on; full voice, rate, pitch and quiet-hours controls are on the Narration tab.',
            yue: '讀出應用程式事件，預設關閉；聲音、速度、音調同靜音時段全部喺「旁白」分頁。',
          },
        },
        {
          key: 'narrator.deferToScreenReader',
          type: 'toggle',
          def: true,
          group: 'Narration',
          label: { en: 'Duck under screen readers', yue: '讓位畀螢幕閱讀器' },
          explain: {
            en: 'Best-effort: when a screen reader appears to be running, narration drops to a whisper instead of competing.',
            yue: '最佳努力：偵測到螢幕閱讀器時，旁白會細聲好多，唔會同佢搶。',
          },
        },
        {
          key: 'narrator.quietStart',
          type: 'text',
          def: '',
          group: 'Narration',
          label: { en: 'Quiet hours start (HH:MM)', yue: '靜音開始（HH:MM）' },
          explain: {
            en: 'Everything except genuine errors goes silent between start and end. Leave empty to disable.',
            yue: '時段內除咗真正錯誤外全部收聲；留空即係唔用。',
          },
        },
        {
          key: 'narrator.quietEnd',
          type: 'text',
          def: '',
          group: 'Narration',
          label: { en: 'Quiet hours end (HH:MM)', yue: '靜音結束（HH:MM）' },
          explain: {
            en: 'End of the quiet-hours window; supports windows that cross midnight.',
            yue: '靜音時段結束時間，支援跨午夜。',
          },
        },
      ]);
    } catch {
      /* settings surface unavailable; the tab below still works */
    }
  }

  if (routerMod && routerMod.router && typeof routerMod.router.registerTab === 'function') {
    try {
      routerMod.router.registerTab({
        id: 'narration',
        title: tr('narrator.tabTitle', 'Narration', '旁白'),
        icon: '🗣️',
        closable: false,
        render: (el) => renderTab(el),
      });
    } catch {
      /* router unavailable: settings toggles remain the entry point */
    }
  }

  if (paletteMod && paletteMod.palette && typeof paletteMod.palette.register === 'function') {
    try {
      paletteMod.palette.register({
        id: 'narration.open',
        title: tr('narrator.paletteTitle', 'Open Narration settings', '開啟旁白設定'),
        keywords: 'voice speech narrator tts talk',
        action: () => {
          if (routerMod && routerMod.router) routerMod.router.navigate('narration');
        },
      });
    } catch {
      /* palette unavailable */
    }
  }

  installToastHook();
  bindToastNarration();
}
