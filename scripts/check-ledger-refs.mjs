#!/usr/bin/env node
/**
 * Every `[R#]` cited in src/ and templates/ must resolve to a ratified entry in the ledger.
 *
 * The ledger is not in this repo yet (it lives in the private docs repo), so this SKIPS when it
 * cannot find one: a checkout without it is not a failure. Phase A moves the ledger to
 * `docs/design/` and this becomes a hard gate with no skip path.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CITE = /\[R(\d+)\]/g;

/** Where the ledger may be, nearest first. `OAK_LEDGER` overrides for a checkout elsewhere. */
const CANDIDATES = [
  process.env.OAK_LEDGER,
  join(ROOT, 'docs/design/implementation.md'),
  join(ROOT, '../implementation.md'),
].filter(Boolean);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|yml|yaml|sh|md)$/.test(e)) out.push(p);
  }
  return out;
}

const ledgerPath = CANDIDATES.find((p) => existsSync(p));
if (!ledgerPath) {
  console.log('check-ledger-refs: no ledger reachable, skipping (see the header)');
  process.exit(0);
}

/** A ratified id, i.e. one the ledger DEFINES (`**[R#] ...`), not merely mentions. */
const ledger = readFileSync(ledgerPath, 'utf8');
const defined = new Set();
for (const m of ledger.matchAll(/\*\*\[R(\d+)\]/g)) defined.add(m[1]);

const bad = [];
for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'templates'))]) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const m of text.matchAll(CITE)) {
    if (defined.has(m[1])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    bad.push(`${file.slice(ROOT.length + 1)}:${line}  [R${m[1]}]  ${lines[line - 1].trim()}`);
  }
}

if (bad.length) {
  console.error(`check-ledger-refs: ${bad.length} citation(s) do not resolve in ${ledgerPath}:`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`check-ledger-refs: every citation resolves (${defined.size} ratified ids)`);
