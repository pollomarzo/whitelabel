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
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
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

const runnable = existsSync(bundle) && existsSync(template) && typstPresent();

describe.skipIf(!runnable)('fixture build through the bundled CLI', () => {
  it('renders a real PDF with articles preserved and the engine template', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-int-'));
    for (const f of ['myst.yml', 'index.md', 'bib.bib']) {
      copyFileSync(join(engineDir, 'test', 'fixture-paper', f), join(tmp, f));
    }

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

    // a real PDF, named from the article (index.md → index.pdf, proving articles took effect)
    const pdf = join(tmp, '_build', 'exports', 'myst_typst', 'index.pdf');
    expect(existsSync(pdf)).toBe(true);

    // the two-pass wrote the complete typst entry (articles + engine template) to own config
    const doc = parseDocument(readFileSync(join(tmp, 'myst.yml'), 'utf8'));
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe(template);
    expect(doc.getIn(['project', 'exports', 0, 'articles', 0, 'file'])).toBe('index.md');
    // the author's sibling option survived the whole pipeline (finding 3)
    expect(doc.getIn(['project', 'options', 'youtube'])).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
  }, 60_000);
});
