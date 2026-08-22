'use strict';

/**
 * The unlock ladder — something to DO while a toy-lockout wait runs.
 *
 * Rungs, in escalation order:
 *   dish (one dim-sum pick, four choices) → sums (after five wrong dishes;
 *   ten small sums, ALL must be right) → whack-a-mole (after ONE wrong sum;
 *   one 20-second round) → clock (fall-through terminal: the ladder is NOT
 *   offered again for that lockout).
 *
 * Hard safety properties (asserted where they are enforced):
 *  - SERVER(main)-GRADED: every challenge is issued and graded through
 *    ladder:* IPC nonces. This renderer NEVER receives an answer for any
 *    challenge — see the assert comment beside each answer submission.
 *  - Winning clears THE WAIT ONLY. It never signs anyone in, never mints a
 *    session or cookie, never refunds the attempt budget, and never touches
 *    the credential. The footer says exactly that in every rung.
 *  - Escalation is untouched: underlying lockout timers keep running however
 *    well the games go.
 *  - Budget: at most three cleared waits per rolling hour, tracked main-side.
 *    Exhausted, everyone serves the clock.
 *  - School mode: the starting-rung decider below is the single source of
 *    truth — under School mode the dish rung is ABSENT (not skipped-with-a-
 *    message; nothing may reference it), so the ladder simply starts at sums.
 */

import { i18n } from './i18n.js';
import { ui } from './ui.js';
import { getDishPool } from './dimsum.js';

function ipc(channel, payload) {
  try {
    if (window.mrb && typeof window.mrb.invoke === 'function') {
      return window.mrb.invoke(channel, payload);
    }
  } catch {
    /* bridge missing */
  }
  return Promise.reject(new Error('The app bridge is unavailable.'));
}

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

/**
 * Single source of truth for the entry rung. School mode suppresses the
 * dim-sum rung ENTIRELY — the function returns the sums rung and no message
 * anywhere mentions what was suppressed.
 * @param {boolean} schoolActive
 */
export function startRung(schoolActive) {
  return schoolActive ? 'sums' : 'dish';
}

const RUNG_ORDER = ['dish', 'sums', 'mole', 'clock'];

/** Exposed for documentation surfaces; the clock is terminal. */
export function rungOrder() {
  return RUNG_ORDER.slice();
}

// ---------------------------------------------------------------------------

function honestyFooter() {
  const p = ui.el('p', { class: 'mrb-ladder-footer' });
  p.textContent = tr(
    'ladder.footer',
    'Clearing this just ends the wait — your password still applies.',
    '過咗呢關都只係完咗場等待——密碼照舊有效。'
  );
  return p;
}

/**
 * Run the ladder to its conclusion.
 * @param {{anchorEl?:Element|null, schoolActive?:boolean, waitMsRemaining?:number}} opts
 * @returns {Promise<boolean>} true only when a rung was CLEARED (wait ends early)
 */
export async function runLadder(opts = {}) {
  const schoolActive = !!opts.schoolActive;

  // Budget gate first: exhausted means the clock rung for everyone.
  let leftOf3 = 0;
  try {
    const budget = await ipc('ladder:budget', {});
    leftOf3 = budget && Number.isFinite(budget.leftOf3) ? budget.leftOf3 : 0;
  } catch {
    leftOf3 = 0; // grader unavailable → conservative: serve the wait
  }

  let rung = leftOf3 > 0 ? startRung(schoolActive) : 'clock';
  let wrongDishes = 0;
  let nonce = null;

  return new Promise((resolve) => {
    let panelClose = () => {};
    let roundTimer = null;

    const finish = (cleared) => {
      if (roundTimer) clearTimeout(roundTimer);
      panelClose();
      resolve(cleared);
    };

    /** Consume one budgeted skip, then clear the wait. */
    const win = () => {
      // ASSERT: this path clears the WAIT only — no session, no cookie, no
      // credential touch, no attempt refund exists anywhere downstream.
      ipc('ladder:consume', {})
        .catch(() => {})
        .then(() => finish(true));
    };

    const body = ui.el('div', { class: 'mrb-ladder' });

    const mount = () => {
      if (opts.anchorEl instanceof Element) {
        panelClose = ui.anchored(opts.anchorEl, body, {});
        body.appendChild(honestyFooter());
      } else {
        panelClose = ui.modal({
          title: tr('ladder.title', 'A quick game while you wait', '等陣順手玩個小遊戲'),
          build: (bodyEl) => {
            bodyEl.appendChild(body);
            bodyEl.appendChild(honestyFooter());
          },
          actions: [],
        });
      }
    };

    const swapBody = (contentEl, headingText) => {
      body.textContent = '';
      const h = ui.el('h4', {});
      h.textContent = headingText;
      body.append(h, contentEl, honestyFooter());
    };

    // --- Rung: clock -------------------------------------------------------
    const renderClock = () => {
      const wrap = ui.el('div', { class: 'mrb-ladder-clock' });
      const note = ui.el('p', {});
      const secs = Math.max(1, Math.ceil((opts.waitMsRemaining || 0) / 1000));
      note.textContent =
        leftOf3 <= 0
          ? tr(
              'ladder.clockBudget',
              `The quick-game skips are used up for this hour (${secs}s left on the clock).`,
              `呢個鐘頭嘅跳過配額用晒（時鐘仲有 ${secs} 秒）。`
            )
          : tr(
              'ladder.clockTerminal',
              'The ladder had its chance this time — the remaining wait runs out on its own.',
              '今次梯級玩完喇——剩返嘅等待會自己走完。'
            );
      const doneBtn = ui.el('button', {
        class: 'mrb-btn mrb-btn--tonal',
        type: 'button',
        onclick: () => finish(false),
      });
      doneBtn.textContent = tr('ladder.backToWaiting', 'Back to waiting', '返去等先');
      wrap.append(note, doneBtn);
      swapBody(wrap, tr('ladder.clockTitle', '⏱ The clock', '⏱ 時鐘'));
    };

    // --- Rung: dish --------------------------------------------------------
    const renderDish = async () => {
      const pool = getDishPool();
      if (!Array.isArray(pool) || pool.length < 4) {
        // No pool available: escalate straight to sums, stating why once here.
        console.info('[ladder] dish pool unavailable; starting at sums');
        rung = 'sums';
        renderSums();
        return;
      }
      let res;
      try {
        res = await ipc('ladder:start', { rung: 'dish', dishPool: pool });
      } catch {
        rung = 'clock';
        renderClock();
        return;
      }
      const challenge = res.challenge || {};
      if (challenge.kind !== 'dish') {
        // Main fell back (e.g., pool shrank); follow whatever it issued.
        if (challenge.kind === 'sums') {
          nonce = res.nonce;
          renderSumsFromChallenge(challenge);
        } else {
          rung = 'clock';
          renderClock();
        }
        return;
      }
      nonce = res.nonce;
      const wrap = ui.el('div', { class: 'mrb-ladder-dish' });
      const prompt = ui.el('p', {});
      prompt.textContent = tr(
        'ladder.dishPrompt',
        'Which of these is a dim sum dish?',
        '邊個係點心？'
      );
      const optionsRow = ui.el('div', { class: 'mrb-ladder-options', role: 'group' });
      challenge.options.forEach((name, index) => {
        const btn = ui.el('button', {
          class: 'mrb-btn mrb-btn--outlined mrb-ladder-option',
          type: 'button',
          onclick: async () => {
            // ASSERT (server-graded): the correct index lives in MAIN only.
            try {
              const verdict = await ipc('ladder:answer', { nonce, answers: index });
              if (verdict && verdict.passed) win();
              else {
                wrongDishes += 1;
                if (wrongDishes >= 5) {
                  rung = 'sums';
                  renderSums();
                } else {
                  renderDish(); // fresh dish challenge, fresh nonce
                }
              }
            } catch {
              finish(false);
            }
          },
        });
        btn.textContent = name;
        optionsRow.appendChild(btn);
      });
      wrap.append(prompt, optionsRow);
      swapBody(wrap, tr('ladder.dishTitle', '🥟 First rung: spot the dim sum', '🥟 第一關：認點心'));
    };

    // --- Rung: sums --------------------------------------------------------
    const renderSums = async () => {
      try {
        const res = await ipc('ladder:start', { rung: 'sums' });
        nonce = res.nonce;
        renderSumsFromChallenge(res.challenge || {});
      } catch {
        rung = 'clock';
        renderClock();
      }
    };

    const renderSumsFromChallenge = (challenge) => {
      const questions = Array.isArray(challenge.questions) ? challenge.questions : [];
      const wrap = ui.el('div', { class: 'mrb-ladder-sums' });
      const dots = ui.el('div', { class: 'mrb-ladder-dots', role: 'status' });
      const grid = ui.el('div', { class: 'mrb-ladders-grid' });
      /** @type {HTMLInputElement[]} */
      const inputs = [];
      questions.forEach((q, index) => {
        const cell = ui.el('label', { class: 'mrb-ladder-sumcell' });
        const span = ui.el('span', { class: 'mrb-ladder-sumprompt' });
        span.textContent = q.prompt;
        const input = document.createElement('input');
        input.type = 'number';
        input.inputMode = 'numeric';
        input.className = 'mrb-field__input mrb-ladder-suminput';
        input.setAttribute('aria-label', `${q.prompt}`);
        input.addEventListener('input', () => paintDots());
        inputs.push(input);
        cell.append(span, input);
        grid.appendChild(cell);
      });
      const paintDots = () => {
        dots.textContent = '';
        inputs.forEach((inp) => {
          const dot = ui.el('span', {
            class: inp.value.trim() === '' ? 'mrb-ladder-dot mrb-ladder-dot--empty' : 'mrb-ladder-dot mrb-ladder-dot--filled',
          });
          dots.appendChild(dot);
        });
      };
      paintDots();
      const errBox = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
      const submitBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
      submitBtn.textContent = tr('ladder.checkAnswers', 'Check all ten', '核對全部十題');
      submitBtn.addEventListener('click', async () => {
        const answers = inputs.map((inp) => Number(inp.value));
        if (answers.some((a) => !Number.isFinite(a))) {
          errBox.textContent = tr('ladder.answerAll', 'Fill every box first.', '請填晒所有格。');
          return;
        }
        // ASSERT (server-graded): answers[] are compared inside MAIN; the ten
        // correct values were never sent to this renderer.
        try {
          const verdict = await ipc('ladder:answer', { nonce, answers });
          if (verdict && verdict.passed) win();
          else {
            rung = 'mole';
            renderMole();
          }
        } catch {
          finish(false);
        }
      });
      wrap.append(dots, grid, errBox, submitBtn);
      swapBody(wrap, tr('ladder.sumsTitle', '➗ Second rung: ten little sums', '➗ 第二關：十條小學數'));
    };

    // --- Rung: whack-a-mole --------------------------------------------------
    const renderMole = async () => {
      let res;
      try {
        res = await ipc('ladder:start', { rung: 'mole' });
      } catch {
        rung = 'clock';
        renderClock();
        return;
      }
      nonce = res.nonce;
      const ch = res.challenge || {};
      const schedule = Array.isArray(ch.schedule) ? ch.schedule : [];
      const ROUND_MS = Number(ch.roundMs) || 20000;
      const wrap = ui.el('div', { class: 'mrb-ladder-molewrap' });
      const scoreLine = ui.el('p', { class: 'mrb-vocab-status', 'aria-live': 'polite' });
      const gridEl = ui.el('div', { class: 'mrb-ladder-molegrid', role: 'grid', 'aria-label': tr('ladder.moleGridLabel', 'Mole grid, three by three', '地鼠格仔，三乘三') });

      const reduceMotion = (() => {
        try {
          return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
          return false;
        }
      })();
      if (reduceMotion) gridEl.classList.add('mrb-ladder-molegrid--reduced');

      /** @type {HTMLElement[]} */
      const cells = [];
      for (let i = 0; i < 9; i++) {
        const cellBtn = ui.el('button', {
          class: 'mrb-ladder-molecell',
          type: 'button',
          role: 'gridcell',
          tabindex: i === 0 ? '0' : '-1',
          'aria-label': tr('ladder.cellLabel', `Cell ${i + 1}`, `第 ${i + 1} 格`),
        });
        cells.push(cellBtn);
        gridEl.appendChild(cellBtn);
      }
      // Keyboard: arrows move between cells, Enter whacks.
      gridEl.addEventListener('keydown', (event) => {
        const current = cells.findIndex((c) => c.getAttribute('tabindex') === '0');
        let next = current;
        if (event.key === 'ArrowRight') next = Math.min(8, current + 1);
        else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
        else if (event.key === 'ArrowDown') next = Math.min(8, current + 3);
        else if (event.key === 'ArrowUp') next = Math.max(0, current - 3);
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          cells[current].click();
          return;
        } else return;
        event.preventDefault();
        cells[current].setAttribute('tabindex', '-1');
        cells[next].setAttribute('tabindex', '0');
        cells[next].focus();
      });

      const startedAt = performance.now();
      /** @type {Array<{cell:number,tMs:number}>} */
      const hits = [];
      const hitCells = new Set();

      const whack = (index, cellBtn) => {
        if (hitCells.has(index)) return; // each cell counts ONCE client-side too
        hitCells.add(index);
        const tMs = Math.round(performance.now() - startedAt);
        hits.push({ cell: index, tMs });
        cellBtn.classList.add('is-hit');
        setTimeout(() => cellBtn.classList.remove('is-hit'), reduceMotion ? 120 : 260);
        const politeScore = tr('ladder.score', `${hits.length} moles so far`, `暫時中咗 ${hits.length} 隻`);
        scoreLine.textContent = politeScore;
      };
      cells.forEach((cellBtn, index) => {
        cellBtn.addEventListener('click', () => whack(index, cellBtn));
      });

      const endRound = () => {
        if (roundTimer) clearTimeout(roundTimer);
        // ASSERT (server-graded): visibility windows live in MAIN; hits are
        // validated against them server-side, including the too-fast guard.
        ipc('ladder:answer', { nonce, moleHits: hits })
          .then((verdict) => {
            if (verdict && verdict.passed) win();
            else {
              rung = 'clock';
              renderClock();
            }
          })
          .catch(() => finish(false));
      };
      roundTimer = setTimeout(endRound, ROUND_MS);

      // Renderer draws ONLY the visibility windows the schedule describes.
      schedule.forEach((mole) => {
        setTimeout(() => {
          cells[mole.cell].classList.add('has-mole');
        }, Math.max(0, mole.startOffsetMs));
        setTimeout(() => {
          cells[mole.cell].classList.remove('has-mole');
        }, Math.max(0, mole.startOffsetMs + mole.lifeMs));
      });

      const hint = ui.el('p', {});
      hint.textContent = tr(
        'ladder.moleHint',
        'Hit as many moles as you can before the round ends.',
        '限時之內盡量打中多啲地鼠。'
      );
      wrap.append(scoreLine, hint, gridEl);
      swapBody(wrap, tr('ladder.moleTitle', '🔨 Third rung: whack-a-mole', '🔨 第三關：打地鼠'));
      cells[0].focus();
    };

    mount();
    if (rung === 'dish') renderDish();
    else if (rung === 'sums') renderSums();
    else renderClock();
  });
}
