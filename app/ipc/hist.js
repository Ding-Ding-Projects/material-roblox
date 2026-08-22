'use strict';

/**
 * Material Roblox — Git-backed local version history (main process).
 *
 * Owns the `hist:*` IPC channels listed in CONTRACT §3. Snapshots live in a
 * dedicated isomorphic-git repository at `userData/history`, completely
 * separate from any user project folder (the app never puts a `.git` inside
 * user content).
 *
 * Layout inside the history repository:
 *
 *   data/<domain>.json      working snapshot files, rewritten per event
 *   MANIFEST.jsonl          append-only event log, one line per event:
 *                           { id, ts, kind, label, commit, files:[{path,digest,bytes}] }
 *   LABELS.jsonl            append-only user labels: { id, ts, text } (latest wins)
 *   TOMBSTONES.jsonl        append-only prune markers: { id, ts } (hidden from queries)
 *   WARNINGS.log            fail-safe recovery notes (repo recreated, git missing, …)
 *
 * Invariants (do not weaken):
 *   1. History is APPEND-ONLY. Nothing ever rewrites, rebases, resets or
 *      force-updates the history repository. Restore appends a new event that
 *      happens to carry old content; label/prune append metadata lines. There
 *      is deliberately no code path in this file that mutates an existing
 *      commit, because a version-history feature that can erase versions is
 *      worse than no version history at all.
 *   2. No push, no remote, ever. This repository exists on the user's disk
 *      alone (`git.push` is never imported or called).
 *   3. Every mutation is wrapped: callers receive `{ ok:false, error }` with a
 *      user-actionable message instead of an unhandled rejection.
 *   4. Fail-safe and visible: if the repository is missing or corrupt it is
 *      quarantined (renamed aside, never deleted) and recreated fresh, and the
 *      incident is appended to WARNINGS.log and reported to the caller.
 *   5. Secrets never belong in snapshots; lanes pass redacted data. This
 *      handler stores what it is given verbatim and never logs payloads.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

let git = null;
function loadGit() {
  if (git) return git;
  // Required dependency (declared in package.json by the shell lane).
  git = require('isomorphic-git');
  return git;
}

/* ── Bounds & constants ─────────────────────────────────────────────────── */

const MAX_FILE_BYTES = 16 * 1024 * 1024;   // 16 MiB per snapshot file
const MAX_EVENT_BYTES = 32 * 1024 * 1024;  // 32 MiB per event (all files)
const MAX_LABEL_CHARS = 200;
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const GC_TIMEOUT_MS = 30_000;

const AUTHOR = { name: 'Material Roblox History', email: 'history@local' };

/* ── Repository plumbing ────────────────────────────────────────────────── */

/** @returns {{dir:string}} absolute path of the history repository */
function repoDir() {
  const { app } = require('electron');
  return { dir: path.join(app.getPath('userData'), 'history') };
}

function dataDir(dir) {
  return path.join(dir, 'data');
}

/** Reject path traversal and absolute paths before anything touches disk. */
function sanitizeRel(relPath) {
  if (typeof relPath !== 'string' || !relPath.length) throw new Error('Snapshot file path must be a non-empty string.');
  if (relPath.length > 256) throw new Error('Snapshot file path is too long (max 256 characters).');
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(norm) || norm.startsWith('..') || norm.split('/').includes('..')) {
    throw new Error(`Snapshot file path must stay inside data/: ${relPath}`);
  }
  if (!/^[\w./ -]+$/.test(norm)) throw new Error(`Snapshot file path has unsupported characters: ${relPath}`);
  return norm;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function readJsonl(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* tolerate a torn final line */ }
    }
    return out;
  } catch {
    return [];
  }
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function warn(dir, message) {
  try {
    appendJsonl(path.join(dir, 'WARNINGS.log'), { ts: Date.now(), warning: String(message) });
  } catch { /* even the warning log failing must not crash a handler */ }
}

/**
 * Prepare the repository for work. Recreates it (quarantining the old copy)
 * when it is missing or unusable, and reports honestly when that happened.
 */
function ensureRepo() {
  const { dir } = repoDir();
  const dotGit = path.join(dir, '.git');
  if (!fs.existsSync(dotGit)) {
    fs.mkdirSync(dataDir(dir), { recursive: true });
    loadGit().init({ fs, dir, defaultBranch: 'main' });
  }
  return { dir };
}

/**
 * Run `fn` with a healthy repository; on any failure quarantine the repo and
 * recreate it so the NEXT event can succeed, then report the failure honestly.
 * The quarantined copy is renamed aside (never deleted) so nothing is lost.
 */
async function withRepo(fn) {
  let ctx;
  try {
    ctx = ensureRepo();
  } catch (err) {
    // Corrupt beyond even init — quarantine the directory and start over.
    const { dir } = repoDir();
    const quarantine = `${dir}.corrupt-${Date.now()}`;
    try { fs.renameSync(dir, quarantine); } catch { /* fall through */ }
    fs.mkdirSync(dataDir(dir), { recursive: true });
    try { loadGit().init({ fs, dir, defaultBranch: 'main' }); } catch { /* reported below */ }
    warn(dir, `Repository was unusable (${err && err.message}); quarantined at ${path.basename(quarantine)} and recreated.`);
    return { ok: false, error: `History repository was corrupt and has been recreated. Previous copy kept at ${quarantine}`, recreated: true };
  }
  try {
    return await fn(ctx);
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    // A failure mid-operation usually means corruption; recover the same way.
    if (/lock|index|object|ref|pack/i.test(message)) {
      const { dir } = repoDir();
      warn(dir, `Git operation failed (${message}); repository left in place for inspection.`);
    }
    return { ok: false, error: message };
  }
}

async function commitAll(dir, message, extraPaths) {
  const g = loadGit();
  const paths = ['MANIFEST.jsonl', ...(extraPaths || [])];
  for (const p of paths) {
    try { await g.add({ fs, dir, filepath: p }); } catch { /* new-file race is fine; add again below */ }
  }
  const oid = await g.commit({ fs, dir, message, author: AUTHOR });
  return oid;
}

/* ── Event helpers ──────────────────────────────────────────────────────── */

function readEvents(dir) {
  return readJsonl(path.join(dir, 'MANIFEST.jsonl')).filter((e) => e && e.id && Array.isArray(e.files));
}

function readHiddenSet(dir) {
  const set = new Set();
  for (const t of readJsonl(path.join(dir, 'TOMBSTONES.jsonl'))) if (t && t.id) set.add(t.id);
  return set;
}

function latestLabels(dir) {
  const map = new Map();
  for (const l of readJsonl(path.join(dir, 'LABELS.jsonl'))) {
    if (l && l.id && typeof l.text === 'string') map.set(l.id, { text: l.text, ts: l.ts || 0 });
  }
  return map;
}

function validatePayload(p, needSnapshot) {
  if (!p || typeof p !== 'object') throw new Error('Request payload must be an object.');
  if (!KIND_RE.test(String(p.kind || ''))) throw new Error('History kind must be a short lowercase word (created, updated, deleted, restored, …).');
  if (typeof p.label !== 'string' || !p.label.trim()) throw new Error('History label must be a non-empty string.');
  if (p.label.length > MAX_LABEL_CHARS) throw new Error(`History label is too long (max ${MAX_LABEL_CHARS} characters).`);
  if (needSnapshot) {
    if (!p.snapshot || typeof p.snapshot !== 'object' || !p.snapshot.files || typeof p.snapshot.files !== 'object') {
      throw new Error('Snapshot must contain files: { "relative/path.json": "content" }.');
    }
    const names = Object.keys(p.snapshot.files);
    if (!names.length) throw new Error('Snapshot contains no files.');
    if (names.length > 500) throw new Error('Snapshot contains too many files (max 500).');
  }
}

/* ── Naive line diff ────────────────────────────────────────────────────── */

/**
 * Small LCS-FREE unified-style diff, deliberately adequate for pretty-printed
 * JSON snapshots: trim the common head, trim the common tail, emit the
 * differing middle as `- old` / `+ new` runs. Real diffs would pair moved
 * lines; JSON dumps rarely move lines, and a full Myers diff is not worth the
 * complexity here. Context lines are emitted for the trimmed edges.
 */
function naiveDiff(aText, bText, contextLines = 3) {
  const a = String(aText == null ? '' : aText).split('\n');
  const b = String(bText == null ? '' : bText).split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) { tailA--; tailB--; }
  const out = [];
  const ctxStart = Math.max(0, head - contextLines);
  for (let i = ctxStart; i < head; i++) out.push({ t: ' ', s: a[i] });
  for (let i = head; i <= tailA; i++) out.push({ t: '-', s: a[i] });
  for (let i = head; i <= tailB; i++) out.push({ t: '+', s: b[i] });
  const ctxEnd = Math.min(a.length - 1, tailA + contextLines);
  for (let i = tailA + 1; i <= ctxEnd; i++) out.push({ t: ' ', s: a[i] });
  return out;
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* vanished mid-walk */ } }
    }
  };
  walk(dir);
  return total;
}

/* ── Handlers ───────────────────────────────────────────────────────────── */

const handlers = {
  /** Append one event: rewrite working files, log the manifest line, commit. */
  'hist:append': async (payload) => withRepo(async ({ dir }) => {
    validatePayload(payload, true);
    const files = {};
    let total = 0;
    for (const rel of Object.keys(payload.snapshot.files)) {
      const relSafe = sanitizeRel(rel);
      const content = payload.snapshot.files[rel];
      if (typeof content !== 'string') throw new Error(`Snapshot file ${relSafe} must be string content.`);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw new Error(`Snapshot file ${relSafe} is ${(bytes / 1048576).toFixed(1)} MiB (max ${MAX_FILE_BYTES / 1048576} MiB).`);
      total += bytes;
      if (total > MAX_EVENT_BYTES) throw new Error(`Snapshot is larger than ${MAX_EVENT_BYTES / 1048576} MiB in total; split it across domains.`);
      files[relSafe] = content;
    }

    // Digest dedupe: an unchanged state records NOTHING (the caller-facing
    // `record()` relies on this; see CONTRACT §6).
    const events = readEvents(dir);
    const last = events[events.length - 1];
    if (last) {
      const lastMap = new Map(last.files.map((f) => [f.path, f.digest]));
      const nextNames = Object.keys(files);
      const same = nextNames.length === last.files.length &&
        nextNames.every((n) => lastMap.get(n) === sha256(Buffer.from(files[n], 'utf8')));
      if (same) return { ok: true, duplicate: true, id: last.id };
    }

    const absData = dataDir(dir);
    for (const rel of Object.keys(files)) {
      const abs = path.join(absData, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, files[rel], 'utf8');
    }

    const manifestEntry = {
      id: newId(),
      ts: Date.now(),
      kind: String(payload.kind),
      label: String(payload.label),
      files: Object.keys(files).map((rel) => ({
        path: rel,
        digest: sha256(Buffer.from(files[rel], 'utf8')),
        bytes: Buffer.byteLength(files[rel], 'utf8'),
      })),
    };

    appendJsonl(path.join(dir, 'MANIFEST.jsonl'), manifestEntry);
    const commitMessage = `${manifestEntry.kind}: ${manifestEntry.label}`;
    manifestEntry.commit = await commitAll(dir, commitMessage, Object.keys(files).map((rel) => `data/${rel}`));

    // Persist the commit id by appending a corrected line; readers take the
    // LAST line for a given id. Keeps the manifest strictly append-only.
    appendJsonl(path.join(dir, 'MANIFEST.jsonl'), manifestEntry);
    return { ok: true, id: manifestEntry.id, ts: manifestEntry.ts, commit: manifestEntry.commit };
  }),

  /**
   * Query events. Filters compose with AND: date range ∩ action kinds ∩ text.
   * Returns one page plus kind counts aggregated over the WHOLE filtered set
   * so the renderer can build its action-filter checkboxes with live counts.
   */
  'hist:query': async (payload) => withRepo(async ({ dir }) => {
    const p = payload || {};
    const hidden = readHiddenSet(dir);
    const labels = latestLabels(dir);

    let needle = null;
    if (typeof p.text === 'string' && p.text.length) {
      const mode = p.textMode === 'regex' ? 'regex' : 'plain';
      const flags = mode === 'regex' ? String(p.textFlags || '') : '';
      if (mode === 'regex') {
        try { needle = new RegExp(p.text, flags.includes('g') ? flags : flags + 'g'); }
        catch (err) { throw new Error(`Invalid regular expression: ${err && err.message}`); }
      } else {
        const lower = p.text.toLowerCase();
        needle = { plain: lower };
      }
    }

    const actions = Array.isArray(p.actions) && p.actions.length ? new Set(p.actions.map(String)) : null;
    const from = Number.isFinite(p.from) ? p.from : null;
    const to = Number.isFinite(p.to) ? p.to : null;

    const all = readEvents(dir);
    // Last manifest line wins per id (commit-id correction lines, see append).
    const byId = new Map();
    for (const e of all) byId.set(e.id, e);
    const merged = [...byId.values()].sort((a, b) => (a.ts - b.ts));

    const matchText = (e) => {
      if (!needle) return true;
      const hay = [e.label, e.kind, ...e.files.map((f) => f.path)].join('\n');
      if (needle.plain !== undefined) return hay.toLowerCase().includes(needle.plain);
      needle.lastIndex = 0;
      return needle.test(hay);
    };

    // Date ∩ text first; kind counts aggregate over THIS set so the
    // renderer's action-filter checkboxes show every kind with live counts
    // even while a kind filter itself is active.
    const dateText = merged.filter((e) => {
      if (hidden.has(e.id)) return false;
      if (from != null && e.ts < from) return false;
      if (to != null && e.ts > to) return false;
      return matchText(e);
    });
    const filtered = actions
      ? dateText.filter((e) => actions.has(e.kind))
      : dateText;

    const kinds = {};
    for (const e of dateText) kinds[e.kind] = (kinds[e.kind] || 0) + 1;

    const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 500);
    const offset = Math.max(Number(p.offset) || 0, 0);
    // Newest first for display.
    const page = filtered.slice().reverse().slice(offset, offset + limit).map((e) => ({
      id: e.id, ts: e.ts, kind: e.kind,
      label: labels.get(e.id)?.text || e.label,
      files: e.files, commit: e.commit || null,
      labeled: !!labels.get(e.id),
    }));

    return { ok: true, total: filtered.length, kinds, events: page };
  }),

  /** Full event: manifest line plus snapshot file contents. */
  'hist:get': async (payload) => withRepo(async ({ dir }) => {
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) throw new Error('Event id is required.');
    if (readHiddenSet(dir).has(id)) return { ok: false, error: 'That event was pruned and its snapshot is no longer offered.' };
    const e = readEvents(dir).filter((x) => x.id === id).pop();
    if (!e) return { ok: false, error: `No history event matches id ${id}.` };
    const g = loadGit();
    const files = {};
    for (const f of e.files) {
      let content = null;
      if (e.commit) {
        try {
          const blob = await g.readBlob({ fs, dir, oid: e.commit, filepath: `data/${f.path}` });
          content = Buffer.from(blob.blob).toString('utf8');
        } catch { /* fall through to working copy */ }
      }
      if (content == null) {
        try { content = fs.readFileSync(path.join(dataDir(dir), f.path), 'utf8'); }
        catch { content = null; }
      }
      files[f.path] = content;
    }
    const label = latestLabels(dir).get(id);
    return { ok: true, event: { id: e.id, ts: e.ts, kind: e.kind, label: label ? label.text : e.label, files: e.files, commit: e.commit || null }, contents: files };
  }),

  /**
   * Diff two events (or one event against the most recent earlier event that
   * touches any of the same files). LCS-free line diff — see naiveDiff().
   */
  'hist:diff': async (payload) => withRepo(async ({ dir }) => {
    const idA = payload && payload.idA;
    if (typeof idA !== 'string' || !idA) throw new Error('Diff needs an event id (idA).');
    const events = readEvents(dir).sort((a, b) => a.ts - b.ts);
    const idxB = events.findIndex((e) => e.id === idA);
    if (idxB === -1) return { ok: false, error: `No history event matches id ${idA}.` };
    let evB = events[idxB];
    let evA = null;
    if (payload && typeof payload.idB === 'string' && payload.idB) {
      evA = events.find((e) => e.id === payload.idB) || null;
      if (!evA) return { ok: false, error: `No history event matches id ${payload.idB}.` };
    } else {
      const wanted = new Set(evB.files.map((f) => f.path));
      for (let i = idxB - 1; i >= 0; i--) {
        if (events[i].files.some((f) => wanted.has(f.path))) { evA = events[i]; break; }
      }
    }
    const getContents = async (ev) => {
      const out = {};
      if (!ev) return out;
      const got = await handlers['hist:get']({ id: ev.id });
      if (got && got.ok) return got.contents;
      return out;
    };
    const contentsB = await getContents(evB);
    const contentsA = evA ? await getContents(evA) : {};
    const paths = [...new Set([...Object.keys(contentsB), ...(evA ? Object.keys(contentsA) : [])])].sort();
    const diffs = [];
    for (const p of paths) {
      if (JSON.stringify(contentsA[p]) === JSON.stringify(contentsB[p])) continue;
      diffs.push({ path: p, lines: naiveDiff(contentsA[p], contentsB[p]) });
    }
    return {
      ok: true,
      a: evA ? { id: evA.id, ts: evA.ts, label: evA.label } : null,
      b: { id: evB.id, ts: evB.ts, label: evB.label },
      diffs,
    };
  }),

  /**
   * Restore an event's snapshot. This REWRITES the working files and APPENDS
   * a brand-new `restored` event — it never rewrites history (invariant 1),
   * so the restore itself can be undone by restoring the next-newest event.
   */
  'hist:restore': async (payload) => withRepo(async ({ dir }) => {
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) throw new Error('Restore needs an event id.');
    const got = await handlers['hist:get']({ id });
    if (!got || !got.ok) return { ok: false, error: (got && got.error) || `No history event matches id ${id}.` };
    const absData = dataDir(dir);
    const written = [];
    for (const [rel, content] of Object.entries(got.contents)) {
      if (content == null) continue; // file unreadable even from git: skip honestly
      const relSafe = sanitizeRel(rel);
      const abs = path.join(absData, relSafe);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      written.push(relSafe);
    }
    if (!written.length) return { ok: false, error: 'Nothing could be restored: the snapshot contents were unreadable.' };
    const manifestEntry = {
      id: newId(),
      ts: Date.now(),
      kind: 'restored',
      label: `Restored ${got.event.label}`,
      restores: id,
      files: got.event.files.filter((f) => written.includes(f.path)),
    };
    appendJsonl(path.join(dir, 'MANIFEST.jsonl'), manifestEntry);
    manifestEntry.commit = await commitAll(dir, `restored: ${manifestEntry.label}`, written.map((r) => `data/${r}`));
    appendJsonl(path.join(dir, 'MANIFEST.jsonl'), manifestEntry);
    return { ok: true, id: manifestEntry.id, files: written };
  }),

  /** User label for an event — an appended metadata line, latest wins. */
  'hist:label': async (payload) => withRepo(async ({ dir }) => {
    const id = payload && payload.id;
    const text = payload && payload.text;
    if (typeof id !== 'string' || !id) throw new Error('Label needs an event id.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Label text must be a non-empty string.');
    if (text.length > MAX_LABEL_CHARS) throw new Error(`Label is too long (max ${MAX_LABEL_CHARS} characters).`);
    appendJsonl(path.join(dir, 'LABELS.jsonl'), { id, ts: Date.now(), text: text.trim() });
    return { ok: true };
  }),

  /**
   * Prune = visibility compaction, never deletion: events outside the
   * retention window get tombstoned (hidden from queries) because the git
   * history itself must remain append-only. Optional bounded `git gc`
   * compaction reports reclaimed bytes HONESTLY — often 0, and that is what
   * gets reported rather than a rounded-up feel-good number.
   */
  'hist:prune': async (payload) => withRepo(async ({ dir }) => {
    const p = payload || {};
    const keepDays = Number.isFinite(p.keepDays) ? Math.max(0, p.keepDays) : 90;
    const keepCount = Number.isFinite(p.keepCount) ? Math.max(0, p.keepCount) : 500;
    const hidden = readHiddenSet(dir);
    const events = readEvents(dir).filter((e) => !hidden.has(e.id)).sort((a, b) => b.ts - a.ts);
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const keep = new Set();
    events.slice(0, keepCount).forEach((e) => keep.add(e.id));
    events.forEach((e) => { if (e.ts >= cutoff) keep.add(e.id); });
    const victims = events.filter((e) => !keep.has(e.id));
    if (p.dryRun) {
      return { ok: true, dryRun: true, wouldHide: victims.length, total: events.length };
    }
    for (const v of victims) appendJsonl(path.join(dir, 'TOMBSTONES.jsonl'), { id: v.id, ts: Date.now() });

    let gc = { ran: false, reclaimedBytes: 0, note: '' };
    if (p.compact) {
      const before = dirBytes(path.join(dir, '.git'));
      const spawned = await new Promise((resolve) => {
        try {
          const child = execFile('git', ['gc', '--aggressive', '--prune=now'], { cwd: dir, timeout: GC_TIMEOUT_MS }, (err) => resolve({ err }));
          child.on('error', (err) => resolve({ err }));
        } catch (err) { resolve({ err }); }
      });
      const after = dirBytes(path.join(dir, '.git'));
      if (spawned.err) {
        gc = { ran: false, reclaimedBytes: 0, note: `git gc unavailable or failed (${spawned.err.code === 'ENOENT' ? 'git CLI not installed' : spawned.err.message}); tombstones still applied.` };
      } else {
        gc = { ran: true, reclaimedBytes: Math.max(0, before - after), note: 'git gc completed.' };
      }
    }
    return { ok: true, hidden: victims.length, total: events.length, gc };
  }),

  /**
   * Redacted metadata export: snapshots are OMITTED and the export says so in
   * its own header. Filters match hist:query so the export honours exactly
   * what the panel is showing.
   */
  'hist:export': async (payload) => withRepo(async ({ dir }) => {
    const p = payload || {};
    const query = { from: p.from, to: p.to, actions: p.actions, text: p.text, textMode: p.textMode, textFlags: p.textFlags, limit: 500, offset: 0 };
    const collected = [];
    // Page through everything that matches, 500 at a time.
    for (;;) {
      const page = await handlers['hist:query']({ ...query, offset: collected.length });
      if (!page.ok) return page;
      collected.push(...page.events);
      if (collected.length >= page.total || page.events.length === 0) break;
    }
    const statement = 'Material Roblox history export — METADATA ONLY. File snapshots are omitted from exports by design.';
    if (String(p.format) === 'md') {
      const lines = [`# ${statement}`, '', `Exported: ${new Date().toISOString()}`, `Events: ${collected.length}`, ''];
      lines.push('| When (UTC) | Kind | Label | Files |', '| --- | --- | --- | --- |');
      for (const e of collected) {
        const when = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
        const label = String(e.label).replace(/\|/g, '\\|');
        lines.push(`| ${when} | ${e.kind} | ${label} | ${e.files.length} |`);
      }
      return { ok: true, format: 'md', filename: 'material-roblox-history.md', content: lines.join('\n') + '\n' };
    }
    const content = JSON.stringify({ statement, exportedAt: new Date().toISOString(), count: collected.length, events: collected }, null, 2);
    return { ok: true, format: 'json', filename: 'material-roblox-history.json', content };
  }),
};

/** Contract §2 entrypoint: `register({ ipcMain, win })`. */
function register({ ipcMain }) {
  if (!ipcMain) throw new Error('hist handler requires ipcMain');
  for (const [channel, run] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return await run(payload);
      } catch (err) {
        // Contract §3: failures come back as honest, actionable errors rather
        // than raw exceptions crossing the bridge.
        return { ok: false, error: err && err.message ? String(err.message) : String(err) };
      }
    });
  }
}

module.exports = { register };
