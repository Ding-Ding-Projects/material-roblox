// Page content: Home, Features, Docs viewer, Changelog viewer, Download,
// Status, About. All data loads are relative; empty states are honest.

import { el, attachSearch, makeModeToggle, toast, copyText } from './ui.mjs';
import { store } from './store.mjs';
import { i18n } from './i18n.mjs';
import { renderMarkdown } from './markdown.mjs';

export const REPO = 'https://github.com/Ding-Ding-Projects/material-roblox';

const FEATURES = [
  ['users', 'User lookup', '用戶查詢', 'Profiles with avatar renders, created/updated dates, descriptions.', 'interface/tabs.md'],
  ['friends', 'Friends & followers', '朋友同粉絲', 'Lists with counts, bulk select, and one-click export.', 'interface/bulk-actions.md'],
  ['groups', 'Groups', '群組', 'Group info, roles, member counts, public shout walls.', 'api-coverage'],
  ['games', 'Games & universes', '遊戲', 'Place details, icons, visit/favourite stats, badges per game.', 'platform/status-reporting.md'],
  ['marketplace', 'Marketplace search', '市集搜尋', 'Catalog search with category/price/creator filters and limited info.', 'interface/search-and-regex-builder.md'],
  ['inventory', 'Inventories', '物品欄', 'Public inventories by asset type with pagination and bulk export.', 'interface/exports.md'],
  ['compare', 'Two-user compare', '對比', 'Side-by-side mutuals and badge/game overlaps.', 'interface/tabs.md'],
  ['session', 'Session manager', 'Session 管理', 'Optional .ROBLOSECURITY connection stored in the OS credential vault.', '../safety/session-cookie-handling.md'],
  ['tabs', 'Dockable tabs', '可泊分頁', 'Pin, group, search, bulk-close; persists across restarts.', 'interface/tabs.md'],
  ['palette', 'Command palette', '命令面板', 'Ctrl+Shift+F rich rows that teleport to any element.', 'interface/command-palette.md'],
  ['regex', 'Regex builder', 'Regex 建立器', 'Anchored full builder on every search field, dropdown, and menu.', 'interface/search-and-regex-builder.md'],
  ['notify', 'Notifications centre', '通知中心', 'Non-blocking toasts plus a reviewable, searchable history.', 'interface/notifications.md'],
  ['history', 'Local history', '本機歷史', 'Git-backed snapshots for every user-managed record; undoable restores.', 'interface/local-history.md'],
  ['exports', 'Exports', '匯出', 'JSON, JSONL, YAML, TOML, XML, CSV, TSV, Markdown, HTML, SQL, ZIP.', 'interface/exports.md'],
  ['appearance', 'Appearance editor', '外觀編輯器', 'M3 themes, density, accent seed, per-element editing everywhere.', '../appearance/theme-appearance-editor.md'],
  ['colorpicker', 'Infinite colour picker', '無限色彩選擇器', 'Continuous picker, translator across ten spaces, animated rainbow.', '../appearance/infinite-color-picker.md'],
  ['locks', 'Toy locks & ladder', '玩具鎖同梯子', 'Per-element locks with honest recovery and a budgeted unlock ladder.', '../safety/toy-locks.md'],
  ['authenticator', 'Authenticator', '驗證器', 'RFC 6238 codes with in-process QR pairing; secrets stay local.', '../safety/two-factor-authenticator.md'],
  ['languages', 'Language modes', '語言模式', 'English / playful Cantonese / bilingual with per-language funny levels.', '../personalization/language-modes-funny-levels.md'],
  ['school', 'School mode', '學習模式', 'One shared renamable switch suppressing every playful capability.', '../personalization/school-mode.md'],
  ['dimsum', 'Dim sum surprise', '點心驚喜', 'A 10% startup delight from the public photo catalog.', '../personalization/dim-sum-surprise.md'],
  ['adhd', 'ADHD modes', 'ADHD 模式', 'Five independent accommodations, off by default, never medical framing.', '../personalization/adhd-modes.md'],
  ['converter', 'File converter', '檔案轉換器', 'Categorized adapters, sandboxed offline conversion, resumable queue.', '../platform/file-converter.md'],
  ['ollama', 'Ollama suite manager', 'Ollama 管家', 'Exhaustive local catalog with evidence-backed hardware-fit verdicts.', '../platform/ollama-suite-manager.md'],
  ['updater', 'Auto-updater', '自動更新', 'Chrome-style updates over an unsigned feed with rollback.', '../platform/auto-updater.md'],
];

/* ================= HOME ================= */

export function renderHome(root) {
  root.replaceChildren();

  const hero = el('section', { class: 'hero' },
    el('h1', {}, i18n.node('hero.title')),
    el('p', { class: 'hero-sub' }, i18n.node('hero.sub')),
    el('div', { class: 'hero-actions' },
      el('a', { class: 'mrb-btn filled', href: '#download' }, i18n.node('hero.download'), ' ⬇'),
      el('a', { class: 'mrb-btn outlined', href: '#docs' }, i18n.node('hero.docs')),
    ),
  );
  const oneThingBox = el('div');
  root.append(hero, oneThingBox);

  const grid = el('div', { class: 'grid wide' });
  for (const [id, title, yue, desc] of FEATURES.slice(0, 8)) {
    grid.append(el('div', { class: 'card hover', tabindex: '0', role: 'link',
      onclick: () => location.hash = '#features',
      onkeydown: (e) => e.key === 'Enter' && (location.hash = '#features') },
      el('h3', {}, title), el('span', { class: 'yue-sec' }, yue),
      el('p', { class: 'applied-note' }, desc)));
  }
  root.append(el('div', { class: 'section-title' }, el('h2', {}, i18n.t('home.features'))), grid,
    el('p', { style: 'margin-top:12px' }, el('a', { href: '#features' }, `All ${FEATURES.length} feature areas →`)));

  // Screenshots: honest pending-captures placeholders. Never fake images.
  const shots = el('div', { class: 'grid' });
  for (const name of ['Home · dark theme', 'User lookup', 'Command palette open', 'Settings · bilingual', 'Colour picker (rainbow)', 'Authenticator pairing']) {
    shots.append(el('figure', { class: 'shot-placeholder', style: 'margin:0' },
      el('strong', {}, name),
      el('figcaption', { class: 'applied-note' }, i18n.t('shots.pending')),
    ));
  }
  root.append(el('div', { class: 'section-title' }, el('h2', {}, i18n.t('home.shots'))), shots,
    el('p', { class: 'applied-note', style: 'margin-top:10px' },
      'The ultra-speed delivery pass deliberately skipped screenshot evidence; captures are tracked as roadmap work rather than faked here.'));

  window.addEventListener('mrb-onething', (e) => {
    const on = e.detail.on;
    oneThingBox.replaceChildren();
    if (!on) return;
    const saved = store.get('onething', '');
    const input = el('input', { type: 'text', placeholder: 'The one thing you are doing next…', value: saved, 'aria-label': 'Current next action' });
    input.addEventListener('input', () => store.set('onething', input.value));
    oneThingBox.append(el('div', { class: 'one-thing-banner' },
      el('strong', {}, '🎯 One thing:'), input,
      el('button', { class: 'mrb-btn text', onclick: () => { store.set('onething', ''); input.value = ''; } }, 'Clear')));
  }, { once: false });
}

/* ================= FEATURES ================= */

export function renderFeatures(root) {
  root.replaceChildren(
    el('h1', {}, i18n.t('nav.features')),
    (() => {
      const g = el('div', { class: 'grid wide' });
      for (const [id, title, yue, desc, docPath] of FEATURES) {
        const docHref = docPath.startsWith('../') ? `./docs/features/${docPath.slice(3)}` : `./docs/features/${docPath}`;
        g.append(el('div', { class: 'card hover', tabindex: '0', role: 'link',
          onclick: () => window.dispatchEvent(new CustomEvent('mrb-open-doc', { detail: docHref })),
          onkeydown: (e) => e.key === 'Enter' && window.dispatchEvent(new CustomEvent('mrb-open-doc', { detail: docHref })),
          dataset: { featureId: id } },
          el('h3', {}, title), el('span', { class: 'yue-sec' }, yue),
          el('p', { class: 'applied-note' }, desc),
          el('span', { class: 'badge' }, 'docs →')));
      }
      return g;
    })(),
  );
}

/* ================= DOCS ================= */

let docsIndexCache = null;

export async function renderDocs(root, openTarget) {
  root.replaceChildren(el('h1', {}, i18n.t('docs.title')));
  if (!docsIndexCache) {
    try {
      docsIndexCache = await (await fetch('./docs-index.json')).json();
    } catch {
      root.append(el('div', { class: 'status-empty' }, 'Article index not deployed yet — it is generated by the Pages workflow.'));
      return;
    }
  }
  const search = el('input', { type: 'search', 'aria-label': i18n.t('docs.search') });
  const modeToggle = makeModeToggle(search);
  attachSearch(search, { onQuery: () => renderList(), placeholder: i18n.t('docs.search') });

  const articleView = el('div', { hidden: true });
  const listView = el('div');

  root.append(el('div', { class: 'search-row' }, search, modeToggle), listView, articleView);

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const useRe = search._mrbState?.mode === 'regex' && search._mrbState.pattern;
    let re = null;
    if (useRe) { try { re = new RegExp(search._mrbState.pattern, search._mrbState.flags.replace('g', '')); } catch { re = null; } }

    const cats = (docsIndexCache.categories || []).map((c) => ({
      ...c,
      articles: c.articles.filter((a) => !q
        || (re ? re.test(a.title) || re.test(a.summary || '') : `${a.title} ${a.summary}`.toLowerCase().includes(q))),
    })).filter((c) => c.articles.length);

    if (!cats.length) {
      listView.replaceChildren(el('div', { class: 'status-empty' }, i18n.t('docs.empty')));
      return;
    }
    listView.replaceChildren(...cats.map((c) => el('section', { style: 'margin-bottom:24px' },
      el('h2', {}, c.name),
      el('ul', { style: 'list-style:none;padding:0;display:grid;gap:6px' },
        c.articles.map((a) => el('li', {},
          el('button', { class: 'menu-item', onclick: () => openDoc(`./docs/${a.path}`) },
            el('span', {}, a.title, a.kind === 'index' ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'index') : null),
            el('kbd', {}, c.name)))))),
    ));
  }
  renderList();

  async function openDoc(path) {
    listView.hidden = true;
    articleView.hidden = false;
    articleView.replaceChildren(el('p', { class: 'applied-note' }, 'Loading…'));
    let md;
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(String(res.status));
      md = await res.text();
    } catch {
      articleView.replaceChildren(el('div', { class: 'status-empty' }, i18n.t('docs.loadfail')),
        el('button', { class: 'mrb-btn tonal', onclick: backToList }, '← Back to all articles'));
      return;
    }
    const meta = findMeta(path);
    const suggested = suggestedFor(meta);
    articleView.replaceChildren(
      el('button', { class: 'mrb-btn text', onclick: backToList }, '← All articles'),
      el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, 'Docs / ', meta?.category ?? '…'),
      el('article', { class: 'doc-body' }),
      suggested.length ? el('aside', { class: 'suggested' },
        el('h2', {}, 'Suggested articles'),
        el('ul', {}, suggested.map((s) => el('li', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openDoc(`./docs/${s.path}`); } }, s.title))))) : null,
    );
    const bodyEl = articleView.querySelector('.doc-body');
    bodyEl.innerHTML = renderMarkdown(md);
    // Intercept internal article links so navigation stays inside the viewer.
    bodyEl.querySelectorAll('a[href$=".md"]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const resolved = new URL(a.getAttribute('href').replace(/^\.\.\//, './docs/features/').replace(/^\.\/features\//, './docs/features/'), location.href).pathname.split('/material-roblox')[1];
      openDoc(resolved || path);
    }));
    bodyEl.querySelectorAll('a[target="_blank"]').forEach((a) => a.rel = 'noopener noreferrer');
    articleView.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function backToList() { articleView.hidden = true; listView.hidden = false; }

  function findMeta(path) {
    const rel = path.replace('./docs/', '').split('?')[0];
    for (const c of docsIndexCache.categories || []) {
      const hit = c.articles.find((a) => a.path === rel);
      if (hit) return { ...hit, category: c.name };
    }
    return null;
  }
  function suggestedFor(meta) {
    if (!meta) return [];
    const cat = docsIndexCache.categories.find((c) => c.name === meta.category);
    return (cat?.articles || []).filter((a) => a.path !== meta.path).slice(0, 4);
  }

  if (openTarget) openDoc(openTarget);
}

/* ================= CHANGELOG ================= */

export async function renderChangelog(root) {
  root.replaceChildren(el('h1', {}, i18n.t('cl.title')));
  let data;
  try {
    data = await (await fetch('./changelog.json')).json();
  } catch {
    root.append(el('div', { class: 'status-empty' }, 'Changelog data not deployed yet.'));
    return;
  }
  if (!data.versions?.length) {
    root.append(el('div', { class: 'status-empty' }, i18n.t('cl.empty')));
    return;
  }

  const state = { from: null, to: null };
  const search = el('input', { type: 'search', 'aria-label': i18n.t('cl.search') });
  const calBtn = el('button', { class: 'mrb-btn tonal', onclick: (e) => openCalendar(e.currentTarget) }, '📅 Dates');
  attachSearch(search, { onQuery: () => renderVersions(), placeholder: i18n.t('cl.search') });

  const listWrap = el('div');
  root.append(
    el('div', { class: 'search-row' }, search, makeModeToggle(search), calBtn,
      el('button', { class: 'mrb-btn text', onclick: exportFiltered }, i18n.t('cl.export'))),
    listWrap,
  );

  function matches(v) {
    if (state.from && new Date(v.date) < state.from) return false;
    if (state.to && new Date(v.date) > new Date(state.to.getTime() + 86_400_000)) return false;
    const text = JSON.stringify(v);
    if (!search.value.trim()) return true;
    if (search._mrbState?.mode === 'regex' && search._mrbState.pattern) {
      try { return new RegExp(search._mrbState.pattern, 'i').test(text); } catch { return true; }
    }
    return text.toLowerCase().includes(search.value.trim().toLowerCase());
  }

  function renderVersions() {
    const versions = data.versions.filter(matches);
    if (!versions.length) { listWrap.replaceChildren(el('div', { class: 'status-empty' }, 'No releases match the current filter.')); return; }
    listWrap.replaceChildren(...versions.map((v) => el('section', { class: 'card', style: 'margin-bottom:16px' },
      el('h2', {}, v.version, ' ', el('span', { class: 'applied-note' }, v.date?.slice(0, 10))),
      v.dish ? el('p', {}, el('span', { class: 'badge' }, i18n.t('cl.dish')), ' ', v.dish) : null,
      el('ul', { style: 'list-style:none;padding:0;display:grid;gap:4px' },
        (v.commits || []).slice(0, 40).map((c) => el('li', {},
          el('code', {}, el('a', { href: `${REPO}/commit/${c.sha}`, target: '_blank', rel: 'noopener noreferrer' }, c.sha.slice(0, 7))), ' ', c.subject))),
      (v.commits?.length ?? 0) > 40 ? el('p', { class: 'applied-note' }, `+ ${v.commits.length - 40} more commits`) : null,
    )));
  }

  function exportFiltered() {
    const versions = data.versions.filter(matches);
    const md = ['# Material Roblox changelog (filtered export)', '', `Exported range: ${state.from?.toISOString().slice(0, 10) ?? 'beginning'} → ${state.to?.toISOString().slice(0, 10) ?? 'latest'} at ${new Date().toISOString()}`, '',
      ...versions.map((v) => [`## ${v.version} — ${v.date?.slice(0, 10)}`,
        v.dish ? `Code name: ${v.dish}` : null,
        ...(v.commits || []).map((c) => `- ${c.subject} (${REPO}/commit/${c.sha})`)].filter(Boolean).join('\n'))].join('\n\n');
    copyText(md);
    toast({ title: 'Filtered changelog copied', body: 'Markdown on your clipboard.', tone: 'ok' });
  }

  /* --- advanced calendar: month/year jump, range, presets, typed ISO --- */
  function openCalendar(anchor) {
    import('./ui.mjs').then(({ anchored }) => {
      let viewYear = (state.to ?? new Date()).getFullYear();
      let viewMonth = (state.to ?? new Date()).getMonth();
      const panel = el('div');
      const typed = el('input', { type: 'text', placeholder: 'YYYY-MM-DD', 'aria-label': 'Type a date (ISO or locale)' });
      const msg = el('span', { class: 'applied-note', role: 'status' });

      function drawCal() {
        const first = new Date(viewYear, viewMonth, 1);
        const days = new Date(viewYear, viewMonth + 1, 0).getDate();
        const head = el('div', { class: 'cal-head' },
          el('button', { class: 'mrb-btn tonal', 'aria-label': 'Previous month', onclick: () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } drawCal(); } }, '‹'),
          el('select', { 'aria-label': 'Month', onchange: (e) => { viewMonth = Number(e.target.value); drawCal(); } },
            [...Array(12).keys()].map((mo) => el('option', { value: mo, selected: mo === viewMonth ? true : null }, new Date(2000, mo).toLocaleString(undefined, { month: 'long' })))),
          el('input', { type: 'number', value: viewYear, min: 2020, max: 2100, style: 'width:5.5em', 'aria-label': 'Year', onchange: (e) => { viewYear = Number(e.target.value); drawCal(); } }),
          el('button', { class: 'mrb-btn tonal', 'aria-label': 'Next month', onclick: () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } drawCal(); } }, '›'),
        );
        const grid = el('div', { class: 'cal-grid' },
          ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => el('span', { class: 'dow' }, d)));
        for (let pad = 0; pad < first.getDay(); pad++) grid.append(el('span'));
        for (let d = 1; d <= days; d++) {
          const date = new Date(viewYear, viewMonth, d);
          const iso = date.toISOString().slice(0, 10);
          const selFrom = state.from?.toDateString() === date.toDateString();
          const selTo = state.to?.toDateString() === date.toDateString();
          grid.append(el('button', {
            class: `cal-day${selFrom || selTo ? ' sel' : ''}${inRange(date) ? ' inrange' : ''}${date.toDateString() === new Date().toDateString() ? ' today' : ''}`,
            onclick: () => pickDate(date),
          }, String(d)));
        }
        panel.replaceChildren(head, grid,
          presetsRow(),
          el('div', { class: 'field', style: 'margin-top:8px' }, el('label', {}, 'Or type a date'), typed, msg),
          el('div', { class: 'dialog-actions' },
            el('button', { class: 'mrb-btn text', onclick: () => { state.from = state.to = null; renderVersions(); closePanel(); } }, 'Clear'),
            el('button', { class: 'mrb-btn filled', onclick: () => closePanel() }, 'Done')),
        );
      }
      const inRange = (d) => state.from && state.to && d > state.from && d < state.to;

      function pickDate(date) {
        if (!state.from || (state.from && state.to)) { state.from = date; state.to = null; msg.textContent = 'Range start set — pick an end.'; }
        else if (date < state.from) { state.to = state.from; state.from = date; }
        else state.to = date;
        renderVersions();
        drawCal();
      }
      typed.addEventListener('change', () => {
        const parsed = new Date(typed.value);
        if (Number.isNaN(parsed.getTime())) { msg.textContent = 'That does not parse as a date — the text stays so you can fix it.'; return; }
        msg.textContent = '';
        pickDate(parsed);
      });

      function presetsRow() {
        const mk = (label, daysAgo) => el('button', { class: 'chip clickable', onclick: () => {
          state.to = new Date(); state.from = new Date(Date.now() - daysAgo * 86_400_000); renderVersions(); drawCal();
        } }, label);
        return el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' },
          mk('7 days', 7), mk('30 days', 30), mk('90 days', 90), mk('Year to date', Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 86_400_000)), mk('All time', 3650));
      }

      const closePanel = anchored(anchor, panel, { width: 340 });
      drawCal();
    });
  }

  renderVersions();
}

/* ================= DOWNLOAD ================= */

export async function renderDownload(root) {
  const assetUrl = `${REPO}/releases/latest/download/MaterialRobloxSetup.exe`;
  root.replaceChildren(
    el('h1', {}, i18n.t('dl.title')),
    el('section', { class: 'card' },
      el('h2', {}, i18n.t('dl.requirements')), el('p', {}, i18n.t('dl.req.body')),
      el('h2', {}, i18n.t('dl.squirrel.h')), el('p', {}, i18n.t('dl.squirrel.b')),
    ),
    el('div', { class: 'callout warn' },
      el('h3', { style: 'margin-top:0' }, '⚠ ', i18n.t('dl.unsigned')),
      el('p', { style: 'margin-bottom:0' }, i18n.t('dl.unsigned.b')),
    ),
    el('div', { id: 'dl-state', role: 'status', 'aria-live': 'polite' }),
    el('p', { class: 'applied-note' }, i18n.t('dl.portable')),
  );

  const dlState = root.querySelector('#dl-state');
  const btn = el('a', {
    class: 'mrb-btn filled', href: assetUrl,
    'aria-disabled': 'true', style: 'pointer-events:none;opacity:.5;min-width:280px',
  }, i18n.t('hero.download'));
  const note = el('p', { class: 'applied-note' }, i18n.t('dl.checking'));
  const teaser = el('div');
  dlState.append(el('div', { class: 'hero-actions' }, btn), note, teaser);

  try {
    const res = await fetch('https://api.github.com/repos/Ding-Ding-Projects/material-roblox/releases/latest');
    if (res.status === 200) {
      const json = await res.json();
      btn.setAttribute('aria-disabled', 'false');
      btn.style.cssText = 'min-width:280px';
      note.textContent = `${i18n.t('dl.ready')} ${json.tag_name}`;
    } else if (res.status === 404) {
      note.textContent = i18n.t('dl.pending');
    } else {
      throw new Error(String(res.status));
    }
  } catch {
    note.textContent = i18n.t('dl.error');
  }

  try {
    const cl = await (await fetch('./changelog.json')).json();
    const latest = cl.versions?.[0];
    if (latest) {
      teaser.append(el('div', { class: 'section-title' }, el('h2', {}, i18n.t('dl.teaser'))),
        el('p', {}, el('strong', {}, latest.version), ' · ', latest.date?.slice(0, 10)),
        el('a', { href: '#changelog' }, 'Full changelog →'));
    }
  } catch { /* teaser is optional */ }
}

/* ================= STATUS ================= */

export async function renderStatus(root) {
  root.replaceChildren(el('h1', {}, i18n.t('st.title')));
  try {
    const status = await (await fetch('./status.json')).json();
    if (status.generatedAt) {
      root.append(el('p', { class: 'applied-note' }, `Last updated: ${new Date(status.generatedAt).toLocaleString()} (site deploy time)`));
    }
    if (!status.runs?.length) {
      root.append(
        el('div', { class: 'status-empty' }, i18n.t('st.empty')),
        el('p', {}, el('a', { class: 'mrb-btn tonal', href: `${REPO}/actions`, target: '_blank', rel: 'noopener noreferrer' }, i18n.t('st.actions'), ' ↗')),
      );
      return;
    }
    const rows = status.runs.map((r) => el('tr', {},
      el('td', {}, r.tag || r.runNumber), el('td', {}, r.conclusion || 'unknown'), el('td', {}, r.startedAt || ''),
    ));
    root.append(el('div', { class: 'table-scroll' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Run'), el('th', {}, 'Result'), el('th', {}, 'Started'))),
      el('tbody', {}, rows))));
  } catch {
    root.append(el('div', { class: 'status-empty' }, 'Status data could not be loaded right now — check the repository Actions tab directly instead of trusting a stale cache.'));
  }
}

/* ================= ABOUT ================= */

export function renderAbout(root) {
  root.replaceChildren(
    el('h1', {}, i18n.t('about.title')),
    el('section', { class: 'card' },
      el('img', { src: './social-preview.png', alt: 'Material Roblox logo and wordmark on a deep-red to coral gradient', style: 'border-radius:var(--mrb-shape-md);margin-bottom:12px' }),
      el('h2', {}, 'Material Roblox'),
      el('p', {}, 'Material Design 3 desktop explorer for Roblox platform APIs. Independent open-source project.'),
      el('p', {}, i18n.t('foot.disclaimer')),
      el('div', { class: 'dialog-actions', style: 'justify-content:flex-start' },
        el('a', { class: 'mrb-btn tonal', href: REPO, target: '_blank', rel: 'noopener noreferrer' }, i18n.t('foot.repo'), ' ↗'),
        el('a', { class: 'mrb-btn tonal', href: './LICENSE', target: '_blank', rel: 'noopener noreferrer' }, 'MIT License'),
        el('button', { class: 'mrb-btn tonal', onclick: () => import('./security.mjs').then((m) => m.openTicketsDesk()) }, 'Support Tickets…'),
      ),
    ),
    el('section', {},
      el('h2', {}, 'Help topics'),
      el('ul', { style: 'list-style:none;padding:0;display:grid;gap:6px' },
        ['../safety/toy-locks.md', '../safety/unlock-ladder.md', '../personalization/school-mode.md', '../platform/auto-updater.md'].map((p) =>
          el('li', {}, el('button', { class: 'menu-item', onclick: () => window.dispatchEvent(new CustomEvent('mrb-open-doc', { detail: p.startsWith('..') ? `./docs/features/${p.slice(3)}` : p })) }, '📖 ',
            decodeURIComponent(p.split('/').pop().replace('.md', '').replaceAll('-', ' ')))))),
    ),
    el('p', { class: 'applied-note' }, i18n.t('foot.license')),
  );
}
