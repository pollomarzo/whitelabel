#!/usr/bin/env node
/**
 * build-fixture.mjs — one-command local build of the fixture paper through the real
 * bundled CLI, using the in-engine typst template (engine/templates/typst) offline.
 *
 *   npm run build:fixture              # PDF via the engine's local template
 *   npm run build:fixture -- --keep    # print + keep the temp dir
 *
 * Copies the fixture to a temp dir first so the committed fixture is never mutated by
 * the two-pass working-tree injection. This is the "test with a local template" path:
 * no release zip, no network for the PDF — the engine template is used by path.
 */
import { mkdtempSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(engineDir, 'dist', 'cli.cjs');
if (!existsSync(bundle)) {
  console.error('dist/cli.cjs missing — run `npm run bundle` first.');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'oak-fixture-'));
for (const f of ['myst.yml', 'index.md', 'bib.bib']) {
  copyFileSync(join(engineDir, 'test', 'fixture-paper', f), join(tmp, f));
}

console.error(`Building fixture in ${tmp} (engine template: templates/typst)\n`);
execFileSync(
  'node',
  [
    bundle,
    'build',
    '--paper',
    tmp,
    '--instance',
    join(engineDir, 'test', 'fixture-instance'),
    '--exports-only', // offline PDF canary via the in-engine template (HTML needs a network theme zip)
  ],
  { stdio: 'inherit' },
);

// Glob rather than hardcode: myst derives the export subdir from the CONFIG FILENAME, so it
// moved when the build switched to the derived config (`myst.yml` → `myst.oak.yml` gave
// `myst_typst` → `myst-oak_typst`, [R71]). `findExportedPdf` in cli.ts already globs, which is
// why the deposit path was unaffected; this canary was the only thing pinned to the old name.
const exportsDir = join(tmp, '_build', 'exports');
const pdf = existsSync(exportsDir)
  ? readdirSync(exportsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => join(exportsDir, f))[0]
  : undefined;
console.error(`\nPDF: ${pdf && existsSync(pdf) ? pdf : '(not produced)'}`);
if (!process.argv.includes('--keep')) {
  console.error('(pass --keep to retain the temp dir)');
}
