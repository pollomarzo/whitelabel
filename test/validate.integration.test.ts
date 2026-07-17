/**
 * validate.integration.test.ts — the Layer-B editorial checks (Curvenote's MIT
 * @curvenote/check-implementations) run over the REAL fixture paper through the bundled CLI.
 *
 * Like integration.test.ts, this drives `node dist/cli.cjs` rather than importing myst-cli
 * in-process: the curvenote checks read the myst store (frontmatter + processed mdast), and
 * unbundled myst-cli crashes on Node 24 (the docx interop bug the esbuild bundle papers over,
 * [R51]). So this exercises the exact artifact CI runs. Skipped unless the bundle is present.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(engineDir, 'dist', 'cli.cjs');
const fixturePaper = join(engineDir, 'test', 'fixture-paper');
const fixtureInstance = join(engineDir, 'test', 'fixture-instance');
const repo = 'open-scholar-nexus/fixture-sample-paper';

/** Run `oak validate --json`, tolerating myst's progress logs on stdout: slice from the JSON. */
function runValidate(paper: string): { exitCode: number; out: any } {
  let raw = '';
  let exitCode = 0;
  try {
    raw = execFileSync(
      'node',
      [bundle, 'validate', '--paper', paper, '--instance', fixtureInstance, '--repo', repo, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (e: any) {
    raw = e.stdout?.toString() ?? '';
    exitCode = e.status ?? 1;
  }
  return { exitCode, out: JSON.parse(raw.slice(raw.indexOf('{'))) };
}

describe.skipIf(!existsSync(bundle))('oak validate — curvenote Layer-B checks (bundled)', () => {
  it('passes the well-formed fixture: the 5 journal-selected checks pass, exit 0, success', () => {
    const { exitCode, out } = runValidate(fixturePaper);
    expect(exitCode).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.checkRun.conclusion).toBe('success');
    const ids = new Set(out.checks.map((c: any) => c.id));
    for (const id of ['authors-exist', 'authors-have-orcid', 'authors-have-credit-roles', 'abstract-exists', 'keywords-defined']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(out.checks.every((c: any) => c.status === 'pass')).toBe(true);
  }, 60_000);

  it('fails a bogus CRediT role + missing abstract: exit 1, failure (taxonomy depth from curvenote)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-val-'));
    copyFileSync(join(fixturePaper, 'bib.bib'), join(tmp, 'bib.bib'));
    // index.md WITHOUT the abstract part
    writeFileSync(join(tmp, 'index.md'), '# A Fixture Paper\n\n## Introduction\n\nNo abstract part here.\n');
    // myst.yml with the project-level abstract removed and a bogus CRediT role
    const myst = readFileSync(join(fixturePaper, 'myst.yml'), 'utf8')
      .replace(/ {2}abstract: .*\n/, '')
      .replace('    - conceptualization\n', '    - not-a-real-credit-role\n');
    writeFileSync(join(tmp, 'myst.yml'), myst);

    const { exitCode, out } = runValidate(tmp);
    expect(exitCode).toBe(1);
    expect(out.checkRun.conclusion).toBe('failure');
    const credit = out.checks.filter((c: any) => c.id === 'authors-have-credit-roles');
    expect(credit.some((c: any) => c.status === 'fail' && /invalid CRediT role/i.test(c.message))).toBe(true);
    const abstract = out.checks.find((c: any) => c.id === 'abstract-exists');
    expect(abstract.status).toBe('fail');
  }, 60_000);
});
