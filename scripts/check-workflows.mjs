#!/usr/bin/env node
/**
 * Parses every GitHub Actions workflow under .github/workflows/ as strict
 * YAML before anything can push one that the runner would reject at 0 s.
 * A workflow file that cannot be parsed here must fail this check loudly:
 * a pipeline that never starts produces no release and no signal at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
let files = [];
try {
  files = readdirSync(dir).filter((f) => /\.(yml|yaml)$/.test(f));
} catch {
  console.log('check-workflows: no workflows directory - nothing to check.');
  process.exit(0);
}

let errors = 0;
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  try {
    const doc = yaml.parse(text);
    if (!doc || typeof doc !== 'object' || !doc.jobs) {
      throw new Error('parsed but missing a jobs mapping');
    }
    // A job whose steps reference an id that another step reads via steps.<id>
    // is fine; we only assert structural sanity here, not semantics.
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) {
        throw new Error(`job "${jobName}" has no steps array`);
      }
    }
    console.log(`ok: ${f} (${Object.keys(doc.jobs).length} job(s))`);
  } catch (err) {
    errors += 1;
    console.error(`FAIL: ${f}: ${String(err.message || err)}`);
  }
}
process.exit(errors ? 1 : 0);
