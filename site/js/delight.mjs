// Delight + accommodation layer: the dim sum surprise (10% startup draw,
// public catalog with local cache, School/quiet-study suppressed) and the five
// ADHD accommodations (all off by default).

import { el, toast } from './ui.mjs';
import { store } from './store.mjs';
import { i18n } from './i18n.mjs';

const CATALOG_URL = 'https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json';

async function loadCatalog() {
  const cached = store.get('dimsum.catalog.full', null);
  if (cached?.at > Date.now() - 24 * 3600_000) return cached.items;
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) return cached?.items ?? [];
    const json = await res.json();
    const items = (json.dishes || json.items || json || [])
      .filter((d) => d?.name?.en && (d.photo?.url || d.image?.url || d.photoUrl || d.photos?.[0]?.url))
      .map((d) => ({
        en: d.name.en, zh: d.name.zhHant || d.name.zh || '',
        photo: d.photo?.url || d.image?.url || d.photoUrl || d.photos?.[0]?.url,
      }));
    if (items.length) store.set('dimsum.catalog.full', { at: Date.now(), items });
    return items;
  } catch {
    return cached?.items ?? []; // offline: skip silently — a delight never blocks
  }
}

export async function maybeDimSum() {
  if (store.get('quietStudy', false)) return;      // behaves as uninstalled
  if (!store.get('ui.emoji', true)) { /* emoji toggle styles messages, not this card's existence */ }
  if (Math.random() >= 0.1) return;                 // exactly the stated frequency

  const dishes = await loadCatalog();
  const dish = dishes[Math.floor(Math.random() * dishes.length)];
  if (!dish) return;

  const name = dish.zh ? `${dish.en} · ${dish.zh}` : dish.en;
  const card = el('div', { class: 'card dimsum-card', role: 'dialog', 'aria-label': `Dim sum surprise: ${name}` },
    el('img', { src: dish.photo, alt: name, loading: 'lazy', referrerpolicy: 'no-referrer' }),
    el('p', { style: 'margin:8px 0 0;font-weight:600' }, i18n.voice('info', `${i18n.t('nav.home') !== undefined ? '' : ''}Dim sum surprise`)),
    el('p', { class: 'applied-note', lang: dish.zh ? 'yue-Hant-HK' : undefined }, name),
    el('button', { class: 'mrb-btn text', onclick: () => card.remove(), 'aria-label': 'Dismiss' }, '✕'),
  );
  document.body.append(card);
  setTimeout(() => card.remove(), 9000);
  void toast;
}

/* ---------------- ADHD modes ---------------- */

export function initAdhd() {
  applyAdhd();
  window.addEventListener('mrb-adhd', applyAdhd);

  function applyAdhd() {
    document.body.classList.toggle('spotlight-active-parent', false);
    document.documentElement.classList.toggle('spotlight-active', store.get('adhd.focus', false));
    document.body.classList.toggle('low-stim', store.get('adhd.lowstim', false));
    renderTimeChip(store.get('adhd.time', false));
    renderOneThing(store.get('adhd.onething', false));
    armMomentum(store.get('adhd.momentum', false));
  }

  /* Focus spotlight: hovering one card dims siblings. Nothing is hidden. */
  let spotBound = false;
  function bindSpotlight() {
    if (spotBound) return;
    spotBound = true;
    document.addEventListener('pointerover', (e) => {
      if (!store.get('adhd.focus', false)) return;
      const grid = e.target.closest('.grid');
      document.querySelectorAll('.grid .card').forEach((c) => c.classList.remove('spot-keep'));
      const card = e.target.closest('.grid .card');
      if (card && grid) card.classList.add('spot-keep');
    }, true);
  }

  /* Time awareness chip */
  const startedAt = Date.now();
  let chip = null;
  function renderTimeChip(on) {
    const header = document.querySelector('.mrb-header');
    if (!header) return;
    if (on && !chip) {
      chip = el('span', { class: 'timechip', title: 'Time awareness: how long this page has been open. Just a number — no judgement.' });
      header.append(chip);
      setInterval(() => {
        const mins = Math.floor((Date.now() - startedAt) / 60000);
        chip.textContent = `open ${mins} min`;
        chip.setAttribute('aria-label', `Page open ${mins} minutes`);
      }, 30_000);
      chip.textContent = 'open 0 min';
    } else if (!on && chip) { chip.remove(); chip = null; }
  }

  /* One thing at a time banner on Home */
  function renderOneThing(on) {
    window.dispatchEvent(new CustomEvent('mrb-onething', { detail: { on } }));
  }

  /* Momentum: one gentle prompt after 25 idle minutes; snooze really waits. */
  let momentumTimer = null;
  function armMomentum(on) {
    clearTimeout(momentumTimer);
    if (!on) return;
    const arm = () => {
      momentumTimer = setTimeout(() => {
        if (document.hidden) { arm(); return; }
        const last = store.get('momentum.snoozeUntil', 0);
        if (Date.now() < last) { arm(); return; }
        toast({
          title: 'Still here?',
          body: 'Nothing has changed for 25 minutes. That is fine — this is just the only nudge you will get.',
          tone: 'info',
          actions: [
            { label: 'Thanks, done thinking', action: () => {} },
            { label: 'Snooze 15 min', action: () => store.set('momentum.snoozeUntil', Date.now() + 15 * 60_000) },
          ],
        });
        arm();
      }, 25 * 60_000);
    };
    bindSpotlight();
    arm();
  }
}
