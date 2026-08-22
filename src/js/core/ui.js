/**
 * UI toolkit: hyperscript builder, non-blocking toasts, viewport-aware
 * anchored panels, blocking modals, and the destructive-action confirmation
 * gate (two independent hold-to-confirm keys plus a full-range slider, an
 * always-visible emergency exit, and reduced-motion-safe animations).
 */

/* ------------------------------ Small helpers ----------------------------- */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms) {
  let timer = null;
  function wrapped(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function fmtBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[unitIndex];
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = String(text);
      area.setAttribute('readonly', '');
      area.className = 'mrb-visually-hidden';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ------------------------------ Hyperscript ------------------------------- */

export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') {
        node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      } else if (name === 'style' && typeof value === 'object') {
        Object.assign(node.style, value);
      } else if (name === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (name.startsWith('on') && typeof value === 'function') {
        node.addEventListener(name.slice(2).toLowerCase(), value);
      } else if (name === 'text') {
        node.textContent = String(value);
      } else if (name === 'html') {
        // Trusted internal markup only; callers must never pass user data here.
        node.innerHTML = String(value);
      } else if (value === true) {
        node.setAttribute(name, '');
      } else {
        node.setAttribute(name, String(value));
      }
    }
  }
  appendKids(node, kids);
  return node;
}

function appendKids(node, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) {
      appendKids(node, kid);
    } else if (kid instanceof Node) {
      node.appendChild(kid);
    } else {
      node.appendChild(document.createTextNode(String(kid)));
    }
  }
}

/** Deduplicated stylesheet injection for feature-owned css files. */
export function injectCss(url) {
  const existing = document.head.querySelector('link[rel="stylesheet"][href="' + url + '"]');
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  document.head.appendChild(link);
  return link;
}

/* -------------------------------- Announce -------------------------------- */

let liveRegion = null;

/** Polite screen-reader announcement through the shared live region. */
export function announce(text) {
  try {
    if (!liveRegion) liveRegion = document.getElementById('mrb-live-region');
    if (!liveRegion) return;
    liveRegion.textContent = '';
    window.setTimeout(() => {
      if (liveRegion) liveRegion.textContent = String(text);
    }, 30);
  } catch {
    /* announcements are best-effort */
  }
}

/* --------------------------------- Toasts --------------------------------- */

const TONE_ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3L2.5 20h19L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
};

const MAX_VISIBLE_TOASTS = 5;
const DEFAULT_TOAST_MS = 6000;

let toastSeq = 0;
const toastTimers = new Map();

function toastStack() {
  return document.getElementById('mrb-toast-stack');
}

export function toast(options = {}) {
  const stack = toastStack();
  if (!stack) return null;
  const id = 'mrb-toast-' + ++toastSeq;
  const tones = ['info', 'ok', 'warn', 'error'];
  const tone = tones.includes(options.tone) ? options.tone : 'info';

  const card = el('div', {
    class: ['mrb-toast', 'tone-' + tone],
    role: tone === 'error' ? 'alert' : 'status',
    'data-toast-id': id,
  });

  card.appendChild(
    el('span', { class: 'mrb-toast-icon', 'aria-hidden': 'true', html: TONE_ICONS[tone] })
  );

  const bodyCol = el('div', { class: 'mrb-toast-body' });
  if (options.title !== undefined && options.title !== null) {
    bodyCol.appendChild(el('div', { class: 'mrb-toast-title', text: options.title }));
  }
  if (options.body) {
    bodyCol.appendChild(el('div', { class: 'mrb-toast-text', text: options.body }));
  }

  if (Array.isArray(options.actions) && options.actions.length > 0) {
    const row = el('div', { class: 'mrb-toast-actions' });
    for (const action of options.actions) {
      if (!action || typeof action.label !== 'string') continue;
      row.appendChild(
        el('button', {
          type: 'button',
          class: 'mrb-toast-action',
          text: action.label,
          onclick: () => {
            try {
              if (typeof action.onAction === 'function') action.onAction();
            } finally {
              if (action.closeAfter !== false) dismissToast(id);
            }
          },
        })
      );
    }
    bodyCol.appendChild(row);
  }
  card.appendChild(bodyCol);

  card.appendChild(
    el('button', {
      type: 'button',
      class: 'mrb-toast-dismiss',
      'aria-label': 'Dismiss notification',
      text: '×',
      onclick: () => dismissToast(id),
    })
  );

  const sticky = options.sticky === true || tone === 'error';
  const durationMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1500, options.timeoutMs)
    : DEFAULT_TOAST_MS;
  if (!sticky) {
    const life = el('span', {
      class: 'mrb-toast-life',
      style: { '--mrb-toast-duration': durationMs + 'ms' },
    });
    life.setAttribute('aria-hidden', 'true');
    card.appendChild(life);
  }

  stack.appendChild(card);

  // Keep at most five cards on screen; older ones yield their spot.
  while (stack.children.length > MAX_VISIBLE_TOASTS) {
    const oldest = stack.firstElementChild;
    if (!oldest) break;
    removeToastCard(oldest.getAttribute('data-toast-id'));
  }

  if (!sticky) {
    toastTimers.set(
      id,
      window.setTimeout(() => dismissToast(id), durationMs)
    );
  }

  // Every toast is announced to peer surfaces (notification centre lane).
  window.dispatchEvent(
    new CustomEvent('mrb-toast-shown', {
      detail: { id, title: options.title ?? '', body: options.body ?? '', tone, at: Date.now() },
    })
  );
  announce(options.title ? String(options.title) : '');

  return id;
}

function removeToastCard(id) {
  const stack = toastStack();
  if (!stack || !id) return;
  const card = stack.querySelector('[data-toast-id="' + id + '"]');
  if (!card) return;
  const timer = toastTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
  card.remove();
  window.dispatchEvent(new CustomEvent('mrb-toast-dismissed', { detail: { id } }));
}

export function dismissToast(id) {
  removeToastCard(id);
}

/* ----------------------------- Anchored panels ---------------------------- */

/**
 * Anchor a panel to an element: paints its own surface/border/elevation,
 * flips to fit the viewport, shifts to stay inside it, scrolls internally,
 * never covers its anchor, closes on Escape/outside click, traps Tab lightly,
 * and returns focus to the anchor on close. Returns a close() function.
 */
export function anchored(anchorEl, panelEl, options = {}) {
  const root = document.getElementById('mrb-overlay-root');
  if (!root || !anchorEl || !panelEl) return () => {};
  if (anchorEl instanceof Node === false || panelEl instanceof Node === false) return () => {};

  panelEl.classList.add('mrb-anchor-panel');
  const host = document.createElement('div');
  host.className = 'mrb-anchor-host';
  host.appendChild(panelEl);
  root.appendChild(host);

  let closed = false;
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const margin = 8;
  const gap = 6;

  function position() {
    if (closed) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    panelEl.classList.remove('place-top', 'place-bottom', 'place-left', 'place-right');
    // Measure natural size first (offscreen placement keeps layout intact).
    host.style.left = '-9999px';
    host.style.top = '-9999px';
    panelEl.classList.add('place-bottom');
    const naturalWidth = panelEl.offsetWidth;
    const naturalHeight = panelEl.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const needHeight = Math.min(naturalHeight, viewportHeight * 0.7);
    const needWidth = Math.min(naturalWidth, viewportWidth * 0.9);

    const roomBelow = viewportHeight - anchorRect.bottom;
    const roomAbove = anchorRect.top;
    const roomRight = viewportWidth - anchorRect.right;
    const roomLeft = anchorRect.left;

    let place = 'bottom';
    if (roomBelow >= needHeight + gap + margin) place = 'bottom';
    else if (roomAbove >= needHeight + gap + margin) place = 'top';
    else if (roomRight >= needWidth + gap + margin) place = 'right';
    else if (roomLeft >= needWidth + gap + margin) place = 'left';
    else place = roomBelow >= roomAbove ? 'bottom' : 'top';

    panelEl.classList.remove('place-top', 'place-bottom', 'place-left', 'place-right');
    panelEl.classList.add('place-' + place);

    let left;
    let top;
    if (place === 'bottom') {
      left = anchorRect.left;
      top = anchorRect.bottom + gap;
    } else if (place === 'top') {
      left = anchorRect.left;
      top = anchorRect.top - naturalHeight - gap;
    } else if (place === 'right') {
      left = anchorRect.right + gap;
      top = anchorRect.top;
    } else {
      left = anchorRect.left - naturalWidth - gap;
      top = anchorRect.top;
    }

    // Shift fully inside the viewport.
    left = Math.min(Math.max(margin, left), viewportWidth - margin - naturalWidth);
    top = Math.min(Math.max(margin, top), viewportHeight - margin - Math.min(naturalHeight, viewportHeight * 0.7));

    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const focusables = panelEl.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function onPointerDown(event) {
    const target = event.target;
    if (target instanceof Node && !host.contains(target) && !anchorEl.contains(target)) {
      close();
    }
  }

  function onReposition() {
    position();
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', onReposition);
    window.removeEventListener('scroll', onReposition, true);
    host.remove();
    if (previouslyFocused && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    } else if (anchorEl && anchorEl.isConnected) {
      anchorEl.focus({ preventScroll: true });
    }
    if (typeof options.onClose === 'function') options.onClose();
  }

  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', onReposition);
  window.addEventListener('scroll', onReposition, true);

  requestAnimationFrame(position);

  if (options.autoFocus !== false) {
    const target = panelEl.querySelector(FOCUSABLE_SELECTOR);
    if (target instanceof HTMLElement) {
      target.focus({ preventScroll: true });
    } else if (panelEl instanceof HTMLElement) {
      panelEl.setAttribute('tabindex', '-1');
      panelEl.focus({ preventScroll: true });
    }
  }

  return close;
}

/* --------------------------------- Modal ---------------------------------- */

/**
 * Blocking modal for genuine decisions only. Escape activates the action
 * flagged cancel (or simply closes). Returns a close() function.
 */
export function modal({ title, build, actions }) {
  const root = document.getElementById('mrb-overlay-root');
  if (!root) return () => {};
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const scrim = el('div', { class: 'mrb-modal-scrim' });
  const dialog = el('div', {
    class: 'mrb-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': typeof title === 'string' ? title : undefined,
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    scrim.remove();
    if (previouslyFocused && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }

  if (title) dialog.appendChild(el('h2', { class: 'mrb-dialog-title', text: title }));

  const body = el('div', { class: 'mrb-dialog-body' });
  if (typeof build === 'function') {
    try {
      build(body);
    } catch (err) {
      console.error('[ui] modal build failed:', err);
      body.textContent = 'This dialog failed to build its content.';
    }
  }
  dialog.appendChild(body);

  const actionRow = el('div', { class: 'mrb-dialog-actions' });
  let cancelHandler = null;
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || typeof action.label !== 'string') continue;
    const button = el('button', {
      type: 'button',
      class: ['mrb-btn', action.tone === 'danger' ? 'danger' : action.tone === 'filled' ? 'filled' : 'text'],
      text: action.label,
      onclick: () => {
        if (action.cancel) cancelHandler = null;
        try {
          if (typeof action.onClick === 'function') action.onClick(close);
        } finally {
          if (action.autoClose !== false) close();
        }
      },
    });
    if (action.cancel) cancelHandler = () => button.click();
    actionRow.appendChild(button);
  }
  if (actionRow.childElementCount > 0) dialog.appendChild(actionRow);

  scrim.appendChild(dialog);
  root.appendChild(scrim);

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (cancelHandler) cancelHandler();
      else close();
      return;
    }
    if (event.key === 'Tab') {
      const focusables = dialog.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  document.addEventListener('keydown', onKeydown, true);

  const initialFocus =
    dialog.querySelector('[data-autofocus]') ||
    dialog.querySelector(FOCUSABLE_SELECTOR) ||
    dialog;
  if (initialFocus instanceof HTMLElement) initialFocus.focus({ preventScroll: true });

  return close;
}

/* ---------------------------- Super confirmation --------------------------- */

const HOLD_DURATION_MS = 900;
// A jump larger than this many steps is treated as a programmatic scrub and
// refused, so the slider must genuinely travel its whole range.
const MAX_STEP_JUMP = 4;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Build one hold-to-confirm key. Arms after HOLD_DURATION_MS of continuous
 * press (pointer or keyboard); releasing early resets it.
 */
function buildHoldKey(labelText, onArmed) {
  const label = el('span', { class: 'mrb-super-key-label', text: labelText });
  const button = el('button', {
    type: 'button',
    class: 'mrb-super-key',
    'aria-label': labelText,
  });
  button.appendChild(label);

  let holding = false;
  let rafId = null;
  let startedAt = 0;
  let armed = false;

  function setProgress(percent) {
    button.style.setProperty('--mrb-hold', String(Math.round(percent)));
  }

  function reset() {
    holding = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    setProgress(0);
  }

  function complete() {
    reset();
    armed = true;
    button.disabled = true;
    button.classList.add('armed');
    setProgress(100);
    announce(labelText + ' armed');
    onArmed();
  }

  function tick() {
    if (!holding || armed) return;
    const elapsed = performance.now() - startedAt;
    const percent = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
    setProgress(percent);
    if (percent >= 100) {
      complete();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function begin(event) {
    if (armed || holding) return;
    if (event && event.cancelable) event.preventDefault();
    holding = true;
    startedAt = performance.now();
    if (prefersReducedMotion()) {
      // No sweep animation: jump straight to completion on press-and-hold end.
      rafId = requestAnimationFrame(() => {
        const elapsed = performance.now() - startedAt;
        if (holding && elapsed >= HOLD_DURATION_MS) complete();
        else if (holding) rafId = requestAnimationFrame(tick);
      });
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function end() {
    if (armed) return;
    reset();
  }

  button.addEventListener('pointerdown', begin);
  button.addEventListener('pointerup', end);
  button.addEventListener('pointerleave', end);
  button.addEventListener('pointercancel', end);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  button.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) begin(event);
  });
  button.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      const elapsed = performance.now() - startedAt;
      if (holding && elapsed >= HOLD_DURATION_MS) complete();
      else end();
    }
  });

  return {
    element: button,
    isArmed: () => armed,
  };
}

/**
 * Full destructive-action gate. The destructive callback fires only after two
 * INDEPENDENT hold keys have armed in sequence AND the slider has travelled
 * continuously to 100%. Emergency exit stays visible throughout; Escape and
 * the exit both cancel and return focus to the control that opened the gate.
 */
export function superConfirm({ title, detailHtml, confirmLabel, onConfirm }) {
  const opener = document.activeElement;
  let completed = false;

  const stageAnnouncer = el('p', {
    class: 'mrb-visually-hidden',
    role: 'status',
    'aria-live': 'polite',
  });

  const keyOne = buildHoldKey('Hold to arm key 1', () => {
    stageAnnouncer.textContent = 'Key 1 armed';
    keyTwo.element.disabled = false;
    keyTwo.element.focus();
  });
  const keyTwo = buildHoldKey('Hold to arm key 2', () => {
    stageAnnouncer.textContent = 'Both keys armed. Slide fully to the right to confirm.';
    slider.disabled = false;
    slider.focus();
  });
  keyTwo.element.disabled = true;

  const slider = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: '0',
    'aria-label': 'Slide fully to the right to confirm',
  });
  slider.disabled = true;

  const sweepBar = el('div', { class: 'mrb-super-sweep', 'aria-hidden': 'true' });
  let lastSliderValue = 0;

  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    if (value - lastSliderValue > MAX_STEP_JUMP) {
      slider.value = String(lastSliderValue);
      stageAnnouncer.textContent = 'Keep sliding continuously.';
      return;
    }
    lastSliderValue = value;
    if (!prefersReducedMotion()) {
      sweepBar.style.setProperty('--mrb-sweep', String(value));
    }
    if (value >= 100) finish();
  });
  slider.addEventListener('change', () => {
    if (Number(slider.value) >= 100) finish();
  });

  const reducedMotion = prefersReducedMotion();

  function finish() {
    if (completed) return;
    completed = true;
    stageAnnouncer.textContent =
      'Confirmed.' + (typeof confirmLabel === 'string' && confirmLabel ? ' ' + confirmLabel : '');
    slider.disabled = true;
    if (!reducedMotion) {
      dialogPanel.classList.add('mrb-super-complete');
    }
    window.setTimeout(() => {
      try {
        if (typeof onConfirm === 'function') onConfirm();
      } finally {
        close();
      }
    }, reducedMotion ? 0 : 380);
  }

  function cancel() {
    close();
  }

  const emergencyExit = el('button', {
    type: 'button',
    class: ['mrb-btn', 'outlined', 'mrb-super-exit'],
    'data-autofocus': '',
    text: 'Emergency exit',
    onclick: cancel,
  });

  const dialogPanel = el('div', { class: 'mrb-dialog mrb-super-dialog' });
  dialogPanel.appendChild(stageAnnouncer);
  if (title) dialogPanel.appendChild(el('h2', { class: 'mrb-dialog-title', text: title }));
  if (detailHtml) {
    const detail = el('div', { class: 'mrb-dialog-body' });
    // detailHtml is trusted caller markup (the destructive surface's own copy).
    detail.innerHTML = String(detailHtml);
    dialogPanel.appendChild(detail);
  }

  dialogPanel.appendChild(
    el('div', { class: 'mrb-super-stage' }, [
      el('div', { class: 'mrb-super-keys' }, [keyOne.element, keyTwo.element]),
      el('div', { class: 'mrb-super-slider' }, [
        sweepBar,
        slider,
        el('p', {
          class: 'mrb-field-support',
          text: reducedMotion
            ? 'Reduced motion: states change instantly.'
            : 'Hold both keys in order, then drag the slider all the way.',
        }),
      ]),
      emergencyExit,
    ])
  );

  const scrim = el('div', { class: 'mrb-modal-scrim' }, dialogPanel);
  const root = document.getElementById('mrb-overlay-root');
  if (!root) return;
  root.appendChild(scrim);

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancel();
    }
  }
  document.addEventListener('keydown', onKeydown, true);

  function close() {
    document.removeEventListener('keydown', onKeydown, true);
    scrim.remove();
    if (opener instanceof HTMLElement && opener.isConnected) {
      opener.focus({ preventScroll: true });
    }
  }

  emergencyExit.focus({ preventScroll: true });
  announce(title ? String(title) : 'Confirmation required.');
}

/* ---------------------------------- init ----------------------------------- */

export async function init() {
  /* The toolkit is ready as soon as its module loads; init marks the boot slot. */
}

/* ------------------------------ aggregate ---------------------------------- */

/**
 * Peer modules import `{ ui }` (contract §4). The named functions above stay
 * the primary API; this aggregate is the single object they all share so both
 * import styles always work.
 */
export const ui = {
  el,
  injectCss,
  toast,
  dismissToast,
  anchored,
  modal,
  superConfirm,
  copyText,
  fmtBytes,
  debounce,
  escapeHtml,
  announce,
};
