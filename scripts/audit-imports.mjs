#!/usr/bin/env node
/**
 * Static import/export link auditor.
 *
 * Walks every ES module under src/ and app/ipc-adjacent renderer code,
 * extracts `import { a, b as c } from './x.js'` specifiers, and verifies each
 * imported name exists as an export in the target module. Catches at lint
 * time the class of defect that otherwise only appears as a link-time
 * SyntaxError in the running renderer (a missing aggregate or renamed peer
 * export), which no test suite here would see because this project ships
 * without one by policy.
 *
 * Scope: renderer sources only - .mjs files and ESM .js files under src/.
 * Main-process CommonJS files use require(), which Node resolves loudly.
 *
 * Exit codes: 0 = every named import resolves; 1 = at least one dangling.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const exportsCache = new Map();

function exportedNames(file) {
  if (exportsCache.has(file)) return exportsCache.get(file);
  const names = new Set();
  let source = '';
  try { source = readFileSync(file, 'utf8'); } catch { exportsCache.set(file, names); return names; }
  // export function|const|let|class|async function NAME
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }  (only when the brace list follows the keyword directly)
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      names.add(asMatch ? asMatch[2] : piece.split(/\s+/)[0]);
    }
  }
  exportsCache.set(file, names);
  return names;
}

// import { a, b as c } from './x.js'   (braces may span lines)
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g;

let errors = 0;
let checked = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(IMPORT_RE)) {
    const rawNames = m[1];
    const spec = m[2];
    const target = resolve(dirname(file), spec);
    let targetExports;
    try { targetExports = exportedNames(target); } catch { continue; }
    if (targetExports.size === 0 && !files.includes(target)) continue; // non-src target: skip
    for (const part of rawNames.split(',')) {
      const piece = part.trim();
      if (!piece || piece.startsWith('//')) continue;
      checked += 1;
      const asMatch = piece.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      const wanted = asMatch ? asMatch[1] : piece;
      if (!/^[\w$]+$/.test(wanted)) continue; // weird syntax: parser's job, not ours
      if (!targetExports.has(wanted)) {
        errors += 1;
        console.error(`DANGLING import: ${wanted} (from ${spec}) in ${file.replace(ROOT, '')}`);
        console.error(`           ${target.replace(ROOT, '')} exports: ${[...targetExports].sort().join(', ') || '(none)'}`);
      }
    }
  }
}

console.log(`audit-imports: ${files.length} files, ${checked} named imports checked, ${errors} dangling.`);
process.exit(errors ? 1 : 0);
