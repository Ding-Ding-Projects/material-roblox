// Settings tab: every site preference as a searchable, explainable,
// provenance-labelled setting. Search carries the anchored regex builder.

import { el, attachSearch, superConfirm, toast, openContextMenu } from './ui.mjs';
import { store } from './store.mjs';
import { i18n } from './i18n.mjs';
import { applyAppearance, FONT_STACKS, getRules, setRules, RAINBOW_LEVELS } from './theme.mjs';
import { createPicker } from './colorpicker.mjs';

export const DEFS = [
  // Appearance
  { key: 'appearance.theme', group: 'Appearance', type: 'select', label: { en: 'Theme', yue: '主題' },
    explain: { en: 'Light, dark, or follow your system setting.', yue: '淺色、深色，或者跟系統。' },
    options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] },
  { key: 'appearance.accent', group: 'Appearance', type: 'color', label: { en: 'Accent seed colour', yue: '重點色' },
    explain: { en: 'Drives every accent role. The rainbow option animates the hue globally; reduced motion settles on one deliberate hue.', yue: '控制晒所有重點色。彩虹選項會全站轉色相；減少動態時會停喺一個固定色。' } },
  { key: 'appearance.rainbowSpeed', group: 'Appearance', type: 'slider', min: 1, max: 5, step: 1, label: { en: 'Rainbow speed', yue: '彩虹速度' },
    explain: { en: 'One global duration for every rainbow surface: ' + Object.entries(RAINBOW_LEVELS).map(([k, v]) => `${k}=${v}`).join(', '), yue: '全站共用一個時長：' + Object.values(RAINBOW_LEVELS).join(' / ') } },
  { key: 'appearance.density', group: 'Appearance', type: 'select', label: { en: 'Density', yue: '密度' },
    explain: { en: 'Compact shrinks spacing; comfortable expands it.', yue: '緊湊縮窄間距；寬鬆放大。' },
    options: [['compact', 'Compact'], ['cozy', 'Cosy'], ['comfortable', 'Comfortable']] },
  { key: 'appearance.fontStack', group: 'Appearance', type: 'font', label: { en: 'UI font family', yue: '介面字體' },
    explain: { en: 'System stacks only — the site loads zero remote fonts. Optional vendoring exists via scripts/fetch-fonts.mjs.', yue: '只用系統字體——本站唔載任何網上字體。' } },
  { key: 'appearance.fontScale', group: 'Appearance', type: 'slider', min: 0.85, max: 1.4, step: 0.05, label: { en: 'Font size scale', yue: '字體大小' },
    explain: { en: 'Scales the whole interface from the 16px base.', yue: '以 16px 為基準縮放成個介面。' } },
  { key: 'appearance.fontWeight', group: 'Appearance', type: 'slider', min: 300, max: 700, step: 100, label: { en: 'Body weight', yue: '字重' },
    explain: { en: 'Base weight for body text.', yue: '內文基本字重。' } },

  // Interface
  { key: 'ui.dock', group: 'Interface', type: 'select', label: { en: 'Tab rail dock edge', yue: '分頁欄位置' },
    explain: { en: 'Left by default — a vertical rail fits more tabs legibly. Collapses to icons under 900px.', yue: '預設左邊——直欄睇得多分頁。900px 以下會縮做圖示。' },
    options: [['left', 'Left'], ['right', 'Right'], ['top', 'Top']] },
  { key: 'ui.emoji', group: 'Interface', type: 'toggle', label: { en: 'Show emojis in messages', yue: '訊息顯示 emoji' },
    explain: { en: 'Adds a relevant emoji decoration to dialogs and messages. Never appears in buttons or labels.', yue: '喺對話同訊息加返個相關 emoji。按鈕同標籤永遠唔會有。' } },

  // Language & voice
  { key: 'lang', group: 'Language & voice', type: 'lang', label: { en: 'Language mode', yue: '語言模式' },
    explain: { en: 'English, playful Hong Kong-style Cantonese, or both at once.', yue: '英文、搞笑港式廣東話，或者兩樣齊睇。' } },
  { key: 'funny.en', group: 'Language & voice', type: 'slider', min: 1, max: 5, step: 1, label: { en: 'English funny level', yue: '英文搞笑程度' },
    explain: { en: '1 = fully serious, 5 = maximum playfulness. Styles voice only; facts stay exact — including errors and warnings.', yue: '1 = 全正經，5 = 玩最大。只改語氣，事實照寫——錯誤訊息都一樣。' } },
  { key: 'funny.yue', group: 'Language & voice', type: 'slider', min: 1, max: 5, step: 1, label: { en: 'Cantonese funny level', yue: '廣東話搞笑程度' },
    explain: { en: 'Independent of the English slider. Respectful humour only.', yue: '同英文嗰條獨立。只會搞笑，唔會失禮人。' } },

  // Personalization
  { key: 'quietStudy', group: 'Personalization', type: 'toggle', label: { en: 'Quiet study mode (this site)', yue: '寧靜學習模式（本站）' },
    explain: { en: 'Site-local suppression of playful copy and the dim sum surprise, as if they were not installed. The desktop app shares one switch across all your apps; a website cannot read that record, so this one is honest about being local.', yue: '本站收起所有搞笑內容同點心驚喜，好似冇裝過一樣。桌面版係全機一掣；網站讀唔到嗰個共用記錄，所以老實講明只限本站。' } },
  { key: 'vocabulary', group: 'Personalization', type: 'vocabulary', label: { en: 'Personal vocabulary', yue: '個人詞彙表' },
    explain: { en: 'Upload a bounded JSON replacement list (≤256 KiB, ≤5000 entries). Local-only; exports and history omit it.', yue: '上載有上限嘅 JSON 替換表（≤256 KiB、≤5000 項）。只在本機處理。' } },
  { key: 'adhd', group: 'Personalization', type: 'adhd', label: { en: 'ADHD accommodations', yue: 'ADHD 輔助模式' },
    explain: { en: 'Five independent, off-by-default modes: focus spotlight, low stimulation, time awareness, one thing at a time, momentum.', yue: '五個獨立、預設關閉嘅模式：焦點聚光、低刺激、時間感知、一次一事、動力提示。' } },
  { key: 'schedule', group: 'Personalization', type: 'schedule', label: { en: 'Scheduled appearance rules', yue: '排程外觀規則' },
    explain: { en: 'Local-time windows with weekday sets; cross-midnight supported; the last matching rule wins.', yue: '本地時間時段加星期幾；支援跨午夜；最後一條符合嘅規則優先。' } },

  // Tools
  { key: 'converter', group: 'Tools', type: 'converter', label: { en: 'File converter (mini)', yue: '檔案轉換器（迷你版）' },
    explain: { en: 'Client-side conversions: JSON/YAML/CSV/Markdown/HTML and images. The desktop app ships the full sandboxed catalog.', yue: '喺瀏覽器做 JSON/YAML/CSV/Markdown/HTML 同圖片轉換。完整版喺桌面 app。' } },
  { key: 'authenticator', group: 'Tools', type: 'authenticator', label: { en: 'Authenticator', yue: '兩步驗證器' },
    explain: { en: 'Local RFC 6238 codes with QR pairing. Site storage is browser-grade — keep real secrets in the desktop app vault.', yue: '本機 RFC 6238 碼加 QR 配對。瀏覽器儲存有限——真嘅秘密請放桌面 app。' } },

  // Maintenance
  { key: 'reset.all', group: 'Maintenance', type: 'button', label: { en: 'Reset all site preferences', yue: '重設全部網站偏好' },
    explain: { en: 'Clears this site’s browser storage: appearance, locks, authenticator entries, tickets, history. The same action recovers any forgotten toy lock.', yue: '清空本站瀏覽器儲存：外觀、鎖、驗證器、工單、記錄。忘記玩具鎖密碼都用同一招解決。' } },
];

export function renderSettings(container) {
  const search = el('input', { type: 'search', 'aria-label': i18n.t('set.search') });
  attachSearch(search, { onQuery: () => renderList(), placeholder: i18n.t('set.search') });
  const mode = el('div', { class: 'search-row' }, search);
  container.append(el('h1', {}, i18n.t('set.title')), mode);
  const list = el('div');
  container.append(list);

  function renderList() {
    const q = search.value.trim();
    const groups = new Map();
    for (const def of DEFS) {
      if (q) {
        if (search._mrbState?.mode === 'regex' && search._mrbState.pattern) {
          try {
            const re = new RegExp(search._mrbState.pattern, search._mrbState.flags.replace('g', ''));
            if (!re.test(def.label.en) && !re.test(def.label.yue || '')) continue;
          } catch { /* invalid pattern: fall back to plain */ }
        } else {
          const hay = `${def.label.en} ${def.label.yue || ''} ${def.explain.en}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) continue;
        }
      }
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group).push(def);
    }
    list.replaceChildren(
      el('div', { role: 'status', 'aria-live': 'polite', class: 'applied-note' },
        q ? `${[...groups.values()].flat().length} matching settings` : ''),
      ...[...groups.entries()].map(([group, defs]) => el('section', { class: 'settings-group' },
        el('h2', {}, group),
        ...defs.map((d) => renderDef(d)),
      )),
    );
  }
  renderList();
}

function renderDef(def) {
  const control = buildControl(def);
  return el('div', { class: 'setting-row' },
    el('div', { class: 's-text' },
      el('div', { class: 's-label' }, def.label.en, def.label.yue ? el('span', { class: 'yue-sec' }, def.label.yue) : null),
      el('details', { class: 's-details' },
        el('summary', {}, 'What this does'),
        el('p', { class: 's-explain' }, def.explain.en, def.explain.yue ? el('span', { class: 'yue-sec' }, def.explain.yue) : null)),
      el('div', { class: 's-prov' }, provenance(def)),
    ),
    el('div', { class: 's-control' }, control,
      el('button', { class: 'mrb-btn text', title: 'More actions', 'aria-label': `Actions for ${def.label.en}`, onclick: (e) => defMenu(e, def) }, '⋮')),
  );
}

function provenance(def) {
  const userSet = store.get(def.key, undefined) !== undefined || store.get('appearance', {})[def.key.split('.')[1]] !== undefined;
  return userSet ? 'Value you set (persisted in this browser)' : `Shipped default: ${defaultText(def)}`;
}
function defaultText(def) {
  switch (def.key) {
    case 'appearance.theme': return 'system';
    case 'appearance.accent': return '#e05a47';
    case 'appearance.density': return 'cozy';
    case 'lang': return 'en';
    case 'funny.en': case 'funny.yue': return '5';
    default: return 'off / neutral';
  }
}

function buildControl(def) {
  const get = () => readPref(def.key);
  const set = (v) => writePref(def.key, v);
  switch (def.type) {
    case 'toggle': {
      const c = el('input', { type: 'checkbox' });
      c.checked = !!get();
      c.addEventListener('change', () => { set(c.checked); applyAll(); });
      return switchWrap(c);
    }
    case 'slider': {
      const s = el('input', { type: 'range', class: 'slider', min: def.min, max: def.max, step: def.step, 'aria-label': def.label.en });
      s.value = String(get() ?? def.min);
      const out = el('span', { class: 'applied-note', style: 'min-width:3em;text-align:end' }, s.value);
      s.addEventListener('input', () => { out.textContent = s.value; set(Number(s.value)); applyAll(); });
      return el('div', { style: 'display:flex;align-items:center;gap:10px;min-width:220px' }, s, out);
    }
    case 'select': {
      const sel = el('select', { 'aria-label': def.label.en }, def.options.map(([v, l]) => el('option', { value: v, selected: get() === v ? true : null }, l)));
      sel.addEventListener('change', () => { set(sel.value); applyAll(); });
      return sel;
    }
    case 'font': {
      const sel = el('select', { 'aria-label': def.label.en },
        Object.entries(FONT_STACKS).map(([id, f]) => el('option', { value: id, selected: get() === id ? true : null }, f.label)));
      sel.addEventListener('change', () => { set(sel.value); applyAll(); });
      return sel;
    }
    case 'color': {
      const picker = createPicker({ value: get() || '#e05a47', onInput: (s) => {
        if (s.rainbow) set({ rainbow: true }); else set(s.hex);
        applyAll();
      } });
      return el('details', {}, el('summary', { class: 'mrb-btn tonal', style: 'list-style:none;cursor:pointer' }, 'Open colour picker'), picker);
    }
    case 'lang': {
      const sel = el('select', { 'aria-label': def.label.en },
        [['en', 'English'], ['yue', '廣東話 (playful)'], ['bi', 'Bilingual']].map(([v, l]) => el('option', { value: v, selected: i18n.lang() === v ? true : null }, l)));
      sel.addEventListener('change', () => { i18n.setLang(sel.value); i18n.applyToDom(); });
      return sel;
    }
    case 'vocabulary': return vocabControl();
    case 'adhd': return adhdControl();
    case 'schedule': return scheduleControl();
    case 'converter': return el('button', { class: 'mrb-btn tonal', onclick: () => window.dispatchEvent(new CustomEvent('mrb-open-converter')) }, 'Open converter');
    case 'authenticator': return el('button', { class: 'mrb-btn tonal', onclick: () => window.dispatchEvent(new CustomEvent('mrb-open-auth')) }, 'Open authenticator');
    case 'button': return el('button', { class: 'mrb-btn danger', onclick: () => {
      superConfirm({
        title: 'Reset all site preferences',
        detailHtml: 'This clears <strong>everything</strong> this site keeps in your browser: appearance, tab state, notification history, toy locks and their credentials, authenticator entries, support tickets, and local history. Nothing is sent anywhere — the data simply stops existing.',
        confirmLabel: 'Clear all site storage',
        onConfirm: () => {
          Object.keys(localStorage).filter((k) => k.startsWith('mrb:')).forEach((k) => localStorage.removeItem(k));
          location.reload();
        },
      });
    } }, 'Reset…');
    default: return el('span', { class: 'applied-note' }, '—');
  }
}

function switchWrap(input) {
  const w = el('label', { class: 'switch' }, input, el('span', { class: 'track' }), el('span', { class: 'thumb' }));
  return w;
}

/* -------- preference plumbing -------- */

export function readPref(key) {
  if (key === 'lang') return i18n.lang();
  if (key.startsWith('funny.')) return i18n.funny(key.split('.')[1]);
  if (key === 'quietStudy') return store.get('quietStudy', false);
  const [group, leaf] = key.split('.');
  if (group === 'appearance') return store.get('appearance', {})[leaf];
  if (group === 'ui') return store.get('ui', {})[leaf];
  return store.get(key);
}

export function writePref(key, value) {
  if (key === 'lang') { i18n.setLang(value); return; }
  if (key.startsWith('funny.')) { i18n.setFunny(key.split('.')[1], value); return; }
  if (key === 'quietStudy') { store.set('quietStudy', !!value); i18n.setQuietStudy(!!value); return; }
  const [group, leaf] = key.split('.');
  if (group === 'appearance') { const a = store.get('appearance', {}); a[leaf] = value; store.set('appearance', a); }
  else if (group === 'ui') { const u = store.get('ui', {}); u[leaf] = value; store.set('ui', u); }
  else store.set(key, value);
}

export function applyAll() {
  const a = store.get('appearance', {});
  applyAppearance(a);
  i18n.setQuietStudy(store.get('quietStudy', false));
  i18n.applyToDom(document);
  window.dispatchEvent(new CustomEvent('mrb-appearance-changed'));
}

function defMenu(e, def) {
  const r = e.currentTarget.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 4, {
    list: [
      { label: 'Reset this setting', action: () => {
        if (def.key.startsWith('appearance.')) { const a = store.get('appearance', {}); delete a[def.key.split('.')[1]]; store.set('appearance', a); }
        else store.remove(def.key);
        applyAll(); toast({ title: 'Setting reset to shipped default', tone: 'ok' });
      } },
      { label: 'Copy setting key', action: () => navigator.clipboard?.writeText(def.key) },
    ],
  });
}

/* -------- vocabulary control -------- */

function vocabControl() {
  const input = el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Personal vocabulary JSON file' });
  const status = el('span', { class: 'applied-note', role: 'status' });
  const apply = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const res = await i18n.loadVocabularyFile(f);
    status.textContent = res.ok ? `Loaded — ${res.count} replacements applied to site copy.` : `Rejected: ${res.error}`;
    toast({ title: res.ok ? 'Vocabulary loaded' : 'Vocabulary rejected', body: res.ok ? `${res.count} entries` : res.error, tone: res.ok ? 'ok' : 'warn' });
  };
  input.addEventListener('change', apply);
  const clear = el('button', { class: 'mrb-btn text', onclick: () => { i18n.clearVocabulary(); status.textContent = 'Cleared — shipped wording restored.'; } }, 'Clear');
  return el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, input, clear, status);
}

/* -------- ADHD control -------- */

function adhdControl() {
  const modes = [
    ['adhd.focus', 'Focus spotlight', 'Dims sibling cards so the hovered one leads. Nothing is hidden — one obvious action restores everything.'],
    ['adhd.lowstim', 'Low stimulation', 'Fewer moving things: animations off, shadows off, quieter images. Composes with your OS reduced-motion setting.'],
    ['adhd.time', 'Time awareness', 'A quiet chip shows how long this page has been open. Stating a number is the whole feature — no nagging.'],
    ['adhd.onething', 'One thing at a time', 'A single current next action you write yourself, kept at the top of Home until you clear it.'],
    ['adhd.momentum', 'Momentum', 'If nothing has changed for 25 minutes, one gentle prompt appears — dismissible, with a real snooze.'],
  ];
  return el('div', { style: 'display:grid;gap:6px' }, modes.map(([key, label, why]) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = store.get(key, false);
    c.addEventListener('change', () => { store.set(key, c.checked); applyAll(); window.dispatchEvent(new CustomEvent('mrb-adhd')); });
    return el('label', { title: why, style: 'display:flex;gap:10px;align-items:center;min-height:40px' }, switchWrap(c), el('span', {}, label));
  }));
}

/* -------- schedule control -------- */

function scheduleControl() {
  const wrap = el('div', { style: 'display:grid;gap:8px' });
  const render = () => {
    const rules = getRules();
    wrap.replaceChildren(
      rules.length ? rules.map((r) => el('div', { class: 'chip', style: 'justify-content:space-between;width:100%' },
        `${r.type}=${r.value} · ${fmtT(r.start)}–${fmtT(r.end)} · ${r.days?.length ? r.days.join(',') : 'every day'}`,
        el('button', { class: 'mrb-btn text', 'aria-label': `Delete rule ${r.label || r.id}`, onclick: () => { setRules(rules.filter((x) => x.id !== r.id)); render(); } }, '✕'),
      )) : [el('span', { class: 'applied-note' }, 'No rules yet — appearance follows your manual choices.')],
      el('button', { class: 'mrb-btn text', onclick: addRule }, '+ Add rule'),
    );
  };
  const fmtT = (t) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
  function addRule() {
    const typeSel = el('select', {}, ['theme', 'accent', 'density', 'lang'].map((t) => el('option', { value: t }, t)));
    const valIn = el('input', { type: 'text', placeholder: 'value (dark / #e05a47 / cozy / en)' });
    const start = el('input', { type: 'time', value: '22:00' });
    const end = el('input', { type: 'time', value: '06:00' });
    const dayChecks = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => {
      const c = el('input', { type: 'checkbox', id: `d${i}` });
      return el('label', { for: `d${i}`, style: 'display:inline-flex;gap:4px;align-items:center' }, c, d);
    });
    const dlg = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'What'), typeSel),
      el('div', { class: 'field' }, el('label', {}, 'Value'), valIn),
      el('div', { style: 'display:flex;gap:8px' },
        el('div', { class: 'field' }, el('label', {}, 'Start'), start),
        el('div', { class: 'field' }, el('label', {}, 'End (cross-midnight OK)'), end)),
      el('div', { class: 'field' }, el('label', {}, 'Days (none = every day)'), el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, dayChecks)),
    );
    import('./ui.mjs').then(({ modal }) => modal({
      title: 'New scheduled rule',
      build: (body, close) => { body.append(dlg); },
      actions: [
        { label: 'Cancel' },
        { label: 'Save rule', kind: 'filled', action: () => {
          const toM = (v) => { const [h, m] = v.split(':').map(Number); return { h, m }; };
          const days = dayChecks.map((l, i) => (l.querySelector('input').checked ? i : null)).filter((x) => x !== null);
          const rules = getRules();
          rules.push({ id: `r${Date.now()}`, type: typeSel.value, value: valIn.value.trim(), start: toM(start.value || '00:00'), end: toM(end.value || '00:00'), days, enabled: true });
          setRules(rules);
          render();
          toast({ title: 'Rule saved', body: 'Applies within 30 seconds; the last matching rule wins.', tone: 'ok' });
        } },
      ],
    }));
  }
  render();
  return wrap;
}
