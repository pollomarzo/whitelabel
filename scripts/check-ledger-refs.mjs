#!/usr/bin/env node
/**
 * Every `[R#]` and `design §N` cited in src/, test/, templates/ and docs/design/ must resolve
 * under `docs/design/`: an `[R#]` to a `(r#)=` target, a `design §N` to a `(design-N)=` one.
 * `[R#]` is the only decision-pointer format; `design §N` locates prose and retires with the
 * brief.
 *
 * An id's target moves as the squish proceeds: it starts on `docs/design/record.md` and lands on
 * the feature page that absorbs it. This script does not care which page holds it, only that
 * exactly one does. Superseded by the Layer-3 test, which asserts the same thing against the
 * built `myst.xref.json` and so also catches an anchor that fails to render.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CITE = /\[R(\d+)\]/g;
/** `design.md §N` was a live spelling once, so it is matched too rather than slipping past. */
const SECTION = /design(?:\.md)? §(\d+[a-z]?)/g;

const DESIGN_DIR = join(ROOT, 'docs/design');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|yml|yaml|sh|md)$/.test(e)) out.push(p);
  }
  return out;
}

/** A defined id carries an explicit `(r#)=` target. A mention in prose does not define it. */
const defined = new Map();
const sections = new Set();
const dupes = [];
for (const file of walk(DESIGN_DIR)) {
  if (!file.endsWith('.md')) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/^\(r(\d+)\)=$/gm)) {
    const prev = defined.get(m[1]);
    if (prev)
      dupes.push(`[R${m[1]}]  ${prev.slice(ROOT.length + 1)}  and  ${file.slice(ROOT.length + 1)}`);
    else defined.set(m[1], file);
  }
  for (const m of text.matchAll(/^\(design-([0-9]+[a-z]?)\)=$/gm)) sections.add(m[1]);
}

if (dupes.length) {
  console.error(`check-ledger-refs: ${dupes.length} id(s) defined on more than one page:`);
  for (const d of dupes) console.error(`  ${d}`);
  process.exit(1);
}

const bad = [];
for (const file of [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'test')),
  ...walk(join(ROOT, 'templates')),
  ...walk(DESIGN_DIR),
]) {
  if (file.includes(`${sep}_build${sep}`) || file.includes(`${sep}node_modules${sep}`)) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const at = (i) => text.slice(0, i).split('\n').length;
  const note = (i, what) =>
    bad.push(`${file.slice(ROOT.length + 1)}:${at(i)}  ${what}  ${lines[at(i) - 1].trim()}`);
  for (const m of text.matchAll(CITE)) if (!defined.has(m[1])) note(m.index, `[R${m[1]}]`);
  for (const m of text.matchAll(SECTION)) if (!sections.has(m[1])) note(m.index, `design §${m[1]}`);
}

if (bad.length) {
  console.error(`check-ledger-refs: ${bad.length} citation(s) do not resolve under docs/design/:`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(
  `check-ledger-refs: every citation resolves (${defined.size} ids, ${sections.size} sections)`,
);
