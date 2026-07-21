/**
 * integration.test.ts — the fixture build through the REAL bundled CLI (slice-0
 * release-safety canary, design §12 step 0). Drives `node dist/cli.cjs` rather than
 * importing myst-cli in-process, because unbundled myst-cli crashes on Node 24 (the
 * docx interop bug the esbuild bundle papers over — spike, [R51]). So this exercises
 * the exact artifact the shim runs.
 *
 * Skipped unless the bundle + typst + the in-engine template are all present (so the
 * default `npm test` stays portable). CI bundles first, then this gates the tag.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { DERIVED_CONFIG_FILE } from '../src/yaml-io.js';
import { bundleState, assertBundleNotStale } from './bundle-state.js';
import { readFileSync } from 'node:fs';

const engineDir = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(engineDir, 'dist', 'cli.cjs');
const template = join(engineDir, 'templates', 'typst');

function typstPresent(): boolean {
  try {
    execFileSync('typst', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// absent bundle → skip (portable); STALE bundle → hard fail in beforeAll, never a silent
// pass against old code (bundle-state.ts).
const runnable = bundleState() !== 'absent' && existsSync(template) && typstPresent();

describe.skipIf(!runnable)('fixture build through the bundled CLI', () => {
  beforeAll(assertBundleNotStale);
  it('renders a real PDF with articles preserved and the engine template', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-int-'));
    for (const f of ['myst.yml', 'index.md', 'bib.bib']) {
      copyFileSync(join(engineDir, 'test', 'fixture-paper', f), join(tmp, f));
    }

    const authorBefore = readFileSync(join(tmp, 'myst.yml')); // raw bytes, pre-build

    execFileSync(
      'node',
      [
        bundle,
        'build',
        '--paper',
        tmp,
        '--instance',
        join(engineDir, 'test', 'fixture-instance'),
        // Offline canary: PDF + compose only. The HTML site needs a network theme zip,
        // so it is validated by the live shim run in CI, not this portable unit test.
        '--exports-only',
      ],
      { stdio: 'pipe' },
    );

    // a real PDF, named from the article (index.md → index.pdf, proving articles took effect).
    // Globbed, not hardcoded: myst derives the export subdir from the CONFIG FILENAME, so it
    // is `myst-oak_typst` under the derived config ([R71]) — cli.ts's findExportedPdf globs
    // for the same reason, which is why the deposit path was unaffected by the switch.
    const exportsDir = join(tmp, '_build', 'exports');
    const pdfs = readdirSync(exportsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('index.pdf'));
    expect(pdfs).toHaveLength(1);

    // THE [R71] INVARIANT, through the real bundled CLI: the author's config is untouched.
    expect(readFileSync(join(tmp, 'myst.yml')).equals(authorBefore)).toBe(true);

    // the two-pass wrote the complete typst entry (articles + engine template) to the DERIVED
    // config — never the author's.
    const doc = parseDocument(readFileSync(join(tmp, DERIVED_CONFIG_FILE), 'utf8'));
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe(template);
    expect(doc.getIn(['project', 'exports', 0, 'articles', 0, 'file'])).toBe('index.md');
    // the author's sibling option survived the whole pipeline (finding 3)
    expect(doc.getIn(['project', 'options', 'youtube'])).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
  }, 60_000);
});
