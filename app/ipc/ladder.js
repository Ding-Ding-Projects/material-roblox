'use strict';

/**
 * Unlock-ladder challenge grading — SERVER(main)-side only.
 *
 * Security properties implemented here (the renderer feature depends on them):
 *  - Single-use nonce: every challenge is consumed BEFORE grading, so a wrong
 *    answer cannot be retried against the same question and a right answer
 *    cannot be replayed.
 *  - Answers are generated here and NEVER sent to the renderer. The dish rung
 *    sends option labels + nothing else; sums send prompts only; the mole rung
 *    sends the visibility schedule only (that schedule is what renders).
 *  - A timed game cannot be won faster than it lasts: mole submissions that
 *    arrive before the round duration has actually elapsed are rejected.
 *  - Each mole cell is graded at most once; duplicate hits on a cell are
 *    ignored rather than counted again.
 *  - After a fail the response never names the correct answers.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const NONCE_TTL_MS = 90000;
const SUM_COUNT = 10;
const ROUND_MS = 20000;
const MOLE_COUNT = 12;
// Pass threshold for the mole round: enough distinct genuinely-visible moles.
const MOLE_PASS_RATIO = 0.75;
const GRID_CELLS = 9;
const BUDGET_LIMIT = 3;
const BUDGET_WINDOW_MS = 3600000; // rolling hour

/** @type {Map<string, {kind:string, issuedAt:number, expiresAt:number, consumed:boolean,
 *   answer?:number, sumAnswers?:number[], schedule?:Array<{cell:number,startOffsetMs:number,lifeMs:number}>,
 *   requiredHits?:number}>} */
const challenges = new Map();

function randInt(minInclusive, maxInclusive) {
  return minInclusive + crypto.randomInt(maxInclusive - minInclusive + 1);
}

function pickDistinct(pool, count) {
  const copy = pool.slice();
  const out = [];
  while (out.length < count && copy.length > 0) {
    out.push(copy.splice(crypto.randomInt(copy.length), 1)[0]);
  }
  return out;
}

function makeNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function pruneChallenges() {
  const now = Date.now();
  for (const [nonce, ch] of challenges) {
    if (ch.expiresAt < now - 60000) challenges.delete(nonce);
  }
  // Hard cap so a misbehaving renderer cannot grow the map without bound.
  if (challenges.size > 500) {
    const oldest = [...challenges.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt);
    for (let i = 0; i < oldest.length - 500; i++) challenges.delete(oldest[i][0]);
  }
}

// ---------------------------------------------------------------------------
// Challenge builders (answers stay in this file)
// ---------------------------------------------------------------------------

function buildDishChallenge(dishPool) {
  const names = (Array.isArray(dishPool) ? dishPool : [])
    .filter((n) => typeof n === 'string' && n.trim().length > 0 && n.length <= 120)
    .map((n) => n.trim());
  if (names.length < 4) return null; // caller falls back to the sums rung
  const options = pickDistinct(names, 4);
  const correctIndex = randInt(0, 3);
  return { kind: 'dish', options, answer: correctIndex };
}

function buildSumsChallenge() {
  const questions = [];
  const answers = [];
  const ops = ['+', '-', 'x'];
  while (questions.length < SUM_COUNT) {
    const op = ops[randInt(0, ops.length - 1)];
    let a;
    let b;
    let result;
    if (op === '+') {
      a = randInt(2, 99);
      b = randInt(2, 99);
      result = a + b;
    } else if (op === '-') {
      a = randInt(12, 99);
      b = randInt(2, a - 1); // never negative
      result = a - b;
    } else {
      a = randInt(2, 12); // small products only
      b = randInt(2, 12);
      result = a * b;
    }
    questions.push({ prompt: `${a} ${op} ${b}`, a, b, op });
    answers.push(result);
  }
  return { kind: 'sums', questions, answers };
}

function buildMoleChallenge() {
  const schedule = [];
  const takenWindows = []; // per-cell busy intervals to avoid same-cell overlap
  let guard = 0;
  while (schedule.length < MOLE_COUNT && guard < 400) {
    guard++;
    const cell = randInt(0, GRID_CELLS - 1);
    const startOffsetMs = randInt(700, ROUND_MS - 2300);
    const lifeMs = randInt(650, 1350);
    const end = startOffsetMs + lifeMs;
    const overlaps = takenWindows.some((w) => w.cell === cell && startOffsetMs < w.end && w.start < end);
    if (overlaps) continue;
    takenWindows.push({ cell, start: startOffsetMs, end });
    schedule.push({ cell, startOffsetMs, lifeMs });
  }
  schedule.sort((x, y) => x.startOffsetMs - y.startOffsetMs);
  const requiredHits = Math.max(1, Math.ceil(schedule.length * MOLE_PASS_RATIO));
  return { kind: 'mole', roundMs: ROUND_MS, grid: 3, schedule, requiredHits };
}

/**
 * Decide the starting rung. Caller-supplied rung wins; School mode handling
 * lives with the caller's decider too — this side just clamps to known kinds
 * and falls back when a dish rung has no usable pool.
 */
function decideRung(requested, dishPool) {
  const valid = new Set(['dish', 'sums', 'mole', 'clock']);
  let rung = valid.has(requested) ? requested : null;
  if (!rung) rung = 'dish'; // default ladder entry point
  if (rung === 'dish' && !buildDishChallenge(dishPool)) {
    return { rung: 'sums', reason: 'dish-pool-unavailable' };
  }
  return { rung };
}

// ---------------------------------------------------------------------------
// Rolling-hour budget (persisted; contains timestamps only, no secrets)
// ---------------------------------------------------------------------------

let budgetCache = null;

function budgetFile() {
  return path.join(app.getPath('userData'), 'ladder-budget.json');
}

function loadBudget() {
  if (budgetCache) return budgetCache;
  budgetCache = { skips: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(budgetFile(), 'utf8'));
    if (parsed && Array.isArray(parsed.skips)) {
      budgetCache.skips = parsed.skips.filter((t) => Number.isFinite(t)).map(Number);
    }
  } catch {
    /* first run or unreadable file starts empty */
  }
  return budgetCache;
}

function persistBudget() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const tmp = `${budgetFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(budgetCache), 'utf8');
    fs.renameSync(tmp, budgetFile());
  } catch {
    // Budget persistence is best-effort: losing it only widens the cap until
    // the next successful save, which fails safe in the user's favor.
  }
}

function pruneBudget() {
  const cutoff = Date.now() - BUDGET_WINDOW_MS;
  loadBudget().skips = loadBudget().skips.filter((t) => t >= cutoff);
}

function budgetCounts() {
  pruneBudget();
  const used = loadBudget().skips.length;
  return { skipsThisHour: used, leftOf3: Math.max(0, BUDGET_LIMIT - used) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * @param {{ipcMain: Electron.IpcMain, win?: Electron.BrowserWindow, getWin?: () => Electron.BrowserWindow|null}} deps
 */
function register(deps) {
  const { ipcMain } = deps;
  void (typeof deps.getWin === 'function' ? deps.getWin : () => deps.win || null);

  ipcMain.handle('ladder:start', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    pruneChallenges();
    const decided = decideRung(p.rung, p.dishPool);

    if (decided.rung === 'clock') {
      // Terminal rung: no challenge exists, the caller serves the wait.
      return { ok: true, nonce: null, challenge: { kind: 'clock' }, reason: decided.reason || null };
    }

    let built;
    if (decided.rung === 'dish') built = buildDishChallenge(p.dishPool);
    else if (decided.rung === 'sums') built = buildSumsChallenge();
    else built = buildMoleChallenge();

    const nonce = makeNonce();
    const issuedAt = Date.now();
    challenges.set(nonce, {
      kind: built.kind,
      issuedAt,
      expiresAt: issuedAt + NONCE_TTL_MS,
      consumed: false,
      answer: built.answer,
      sumAnswers: built.answers,
      schedule: built.schedule,
      requiredHits: built.requiredHits,
    });

    // Payload sent to the renderer deliberately EXCLUDES every answer field.
    /** @type {Record<string, unknown>} */
    let publicShape;
    if (built.kind === 'dish') {
      publicShape = { kind: 'dish', options: built.options };
    } else if (built.kind === 'sums') {
      publicShape = { kind: 'sums', questions: built.questions };
    } else {
      publicShape = { kind: 'mole', roundMs: built.roundMs, grid: built.grid, schedule: built.schedule };
    }
    return { ok: true, nonce, challenge: publicShape, reason: decided.reason || null };
  });

  ipcMain.handle('ladder:answer', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const nonce = typeof p.nonce === 'string' ? p.nonce : '';
    const ch = challenges.get(nonce);
    if (!ch) return { ok: true, passed: false, reason: 'unknown-challenge' };
    if (ch.consumed) return { ok: true, passed: false, reason: 'already-graded' };

    // Consume BEFORE grading: exactly one grade attempt per nonce.
    ch.consumed = true;
    challenges.delete(nonce); // single use means it leaves the map immediately

    if (Date.now() > ch.expiresAt) return { ok: true, passed: false, reason: 'expired' };

    if (ch.kind === 'mole') {
      // A timed game cannot be won faster than it lasts.
      if (Date.now() - ch.issuedAt < ROUND_MS) {
        return { ok: true, passed: false, reason: 'too-fast' };
      }
      const hits = Array.isArray(p.moleHits) ? p.moleHits : [];
      const seenCells = new Set();
      let accepted = 0;
      for (const hit of hits.slice(0, 200)) {
        if (!hit || typeof hit !== 'object') continue;
        const cell = Number(hit.cell);
        const tMs = Number(hit.tMs);
        if (!Number.isInteger(cell) || cell < 0 || cell >= GRID_CELLS) continue;
        if (!Number.isFinite(tMs) || tMs < 0 || tMs > ROUND_MS + 2000) continue;
        if (seenCells.has(cell)) continue; // each cell graded ONCE
        seenCells.add(cell);
        const visible = (ch.schedule || []).some(
          (m) => m.cell === cell && tMs >= m.startOffsetMs && tMs < m.startOffsetMs + m.lifeMs
        );
        if (visible) accepted++;
      }
      const required = ch.requiredHits || Math.ceil(MOLE_COUNT * MOLE_PASS_RATIO);
      return { ok: true, passed: accepted >= required };
    }

    if (ch.kind === 'dish') {
      const ans = Number(p.answers);
      const passed = Number.isInteger(ans) && ans >= 0 && ans < 4 && ans === ch.answer;
      // No correct index is ever echoed back after a fail.
      return { ok: true, passed };
    }

    // sums: every question must be right.
    const given = Array.isArray(p.answers) ? p.answers : [];
    const expected = ch.sumAnswers || [];
    let passed = given.length === expected.length;
    if (passed) {
      for (let i = 0; i < expected.length; i++) {
        if (Number(given[i]) !== expected[i]) {
          passed = false;
          break;
        }
      }
    }
    return { ok: true, passed };
  });

  ipcMain.handle('ladder:budget', () => {
    const counts = budgetCounts();
    return { ok: true, ...counts, limit: BUDGET_LIMIT };
  });

  ipcMain.handle('ladder:consume', () => {
    pruneBudget();
    loadBudget().skips.push(Date.now());
    persistBudget();
    const counts = budgetCounts();
    return { ok: true, ...counts, limit: BUDGET_LIMIT };
  });
}

module.exports = { register };
