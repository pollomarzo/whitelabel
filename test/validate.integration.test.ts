/**
 * validate.integration.test.ts: the Layer-B editorial checks (Curvenote's MIT
 * @curvenote/check-implementations) run over the REAL fixture paper through the bundled CLI.
 *
 * Like integration.test.ts, this drives `node dist/cli.cjs` rather than importing myst-cli
 * in-process: the curvenote checks read the myst store (frontmatter + processed mdast), and
 * unbundled myst-cli crashes on Node 24 (the docx interop bug the esbuild bundle papers over,
 * [R51]). So this exercises the exact artifact CI runs. Skipped unless the bundle is present.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleState, assertBundleNotStale } from './bundle-state.js';

const engineDir = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(engineDir, 'dist', 'cli.cjs');
const fixturePaper = join(engineDir, 'test', 'fixture-paper');
const fixtureInstance = join(engineDir, 'test', 'fixture-instance');
const repo = 'open-scholar-nexus/fixture-sample-paper';

/** Spawn `oak validate --json`, capturing stdout + stderr separately. */
function spawnValidate(paper: string): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(
    'node',
    [bundle, 'validate', '--paper', paper, '--instance', fixtureInstance, '--repo', repo, '--json'],
    { encoding: 'utf8' },
  );
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run and parse the JSON payload. stdout must be PURE JSON, myst's progress logs are routed to
 *  stderr (cmdValidate), so we parse it directly with no slicing; a stray stdout write would throw. */
function runValidate(paper: string): { exitCode: number; out: any } {
  const { exitCode, stdout } = spawnValidate(paper);
  return { exitCode, out: JSON.parse(stdout) };
}

describe.skipIf(bundleState() === 'absent')('oak validate, curvenote Layer-B checks (bundled)', () => {
  beforeAll(assertBundleNotStale);
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

  it('--json stdout is pure parseable JSON; myst progress logs go to stderr', () => {
    const { stdout, stderr } = spawnValidate(fixturePaper);
    // The whole point of the contract: stdout parses as-is, with nothing before the JSON.
    expect(stdout.trimStart().startsWith('{')).toBe(true);
    expect(() => JSON.parse(stdout)).not.toThrow();
    // myst's chatter (the raw `new Session()` console.debug + the `📖/📚 Built` logger lines)
    // must be diverted off stdout: it belongs on stderr.
    expect(stdout).not.toMatch(/building myst-cli session|📖 Built|📚 Built/);
    expect(stderr).toMatch(/building myst-cli session with API URL/);
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

  it('--report writes the full JSON envelope (with checkRun) for Stage-2 check-post', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-report-'));
    const reportPath = join(tmp, 'report.json');
    const r = spawnSync(
      'node',
      [bundle, 'validate', '--paper', fixturePaper, '--instance', fixtureInstance, '--repo', repo, '--report', reportPath],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(existsSync(reportPath)).toBe(true);
    const written = JSON.parse(readFileSync(reportPath, 'utf8'));
    // The report always carries the full envelope, checkRun included, regardless of --json.
    expect(written.checkRun.conclusion).toBe('success');
    expect(Array.isArray(written.checks)).toBe(true);
    expect(written.status).toBe('ok');
  }, 60_000);
});

describe.skipIf(bundleState() === 'absent')('the COMPOSED view reaches the checks ([R82])', () => {
  beforeAll(assertBundleNotStale);

  it('the thumbnail check FIRES in validate: it could not before ([R81])', () => {
    // The whole point of [R82]. `paper-base.yml` pins `project.thumbnail`, which exists only
    // post-`extends`; on the author's own config validate saw nothing and passed silently. The
    // fixture paper genuinely ships no `thumbnails/`, so a composed run must now say so.
    const { out } = runValidate(fixturePaper);
    const thumb = out.warnings.find((w: any) => w.check === 'thumbnail');
    expect(thumb).toBeDefined();
    expect(thumb.message).toMatch(/thumbnails\/thumbnail\.png/);
    // A warn, not an error: it must not gate a paper that is otherwise fine ([R81]).
    expect(out.status).toBe('ok');
  }, 60_000);

  it('and does NOT fire once the file is there, no false positive', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-val-thumb-'));
    copyFileSync(join(fixturePaper, 'bib.bib'), join(tmp, 'bib.bib'));
    copyFileSync(join(fixturePaper, 'index.md'), join(tmp, 'index.md'));
    copyFileSync(join(fixturePaper, 'myst.yml'), join(tmp, 'myst.yml'));
    mkdirSync(join(tmp, 'thumbnails'), { recursive: true });
    writeFileSync(join(tmp, 'thumbnails', 'thumbnail.png'), 'not a real png, but a real file');

    const { out } = runValidate(tmp);
    expect(out.warnings.some((w: any) => w.check === 'thumbnail')).toBe(false);
  }, 60_000);

  it('reports no template-override for a paper that declares no template of its own', () => {
    // Compose STAMPS a template onto the composed export, so this is the regression that
    // proves the author value is raw-lifted rather than read back off the composed project.
    const { out } = runValidate(fixturePaper);
    expect(out.warnings.some((w: any) => w.check === 'template-override')).toBe(false);
    expect(out.errors.some((e: any) => e.check === 'template-override')).toBe(false);
  }, 60_000);
});

/* --------------------------------------------------------------------------
 * Instance resolution + the "engine crash" failure mode (UX-test bug hunt).
 *
 * Two defects from the same live run: the CI shim leaves `instance_repo: .` to "the CLI's
 * root resolution" (the [R38] co-located rung), which did not exist, and when the resulting
 * usage error fired, `oak validate` exited 2 having written NOTHING, so Stage 1 could only
 * say "produced no valid report (engine crash)".
 * ------------------------------------------------------------------------ */
describe.skipIf(bundleState() === 'absent')('oak validate, instance resolution + crash reporting', () => {
  beforeAll(assertBundleNotStale);

  /** A copy of the fixture paper, alone (no journal.yml beside it). */
  function paperOnly(): string {
    const dir = mkdtempSync(join(tmpdir(), 'oak-val-noinst-'));
    for (const f of ['bib.bib', 'index.md', 'myst.yml']) copyFileSync(join(fixturePaper, f), join(dir, f));
    return dir;
  }

  it('writes a FAILING report instead of nothing when no instance resolves', () => {
    // The Stage-1 guard is `jq -e '.checkRun.conclusion' report.json`. Before the fix that
    // file did not exist and the author was told "engine crash" and nothing else.
    const dir = paperOnly();
    const report = join(dir, 'report.json');
    const r = spawnSync('node', [bundle, 'validate', '--paper', dir, '--report', report], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(existsSync(report)).toBe(true);
    const written = JSON.parse(readFileSync(report, 'utf8'));
    expect(written.checkRun.conclusion).toBe('failure');
    // The report must carry the REASON, since it is what Stage 2 posts on the PR.
    expect(written.checkRun.summary).toContain('pins.yml');
    expect(String(written.errors[0])).toContain('no instance-config resolved');
  }, 60_000);

  it('the error names pins.yml and the co-located rule, not just the flag', () => {
    const r = spawnSync('node', [bundle, 'validate', '--paper', paperOnly()], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('instance_repo');
    expect(r.stderr).toContain('--no-instance');
  }, 60_000);

  it('resolves the CO-LOCATED instance from a journal.yml beside the paper ([R38])', () => {
    // What `instance_repo: .` means, and what the CI shim assumes the CLI does.
    const dir = mkdtempSync(join(tmpdir(), 'oak-val-colo-'));
    for (const f of ['bib.bib', 'index.md', 'myst.yml']) copyFileSync(join(fixturePaper, f), join(dir, f));
    cpSync(fixtureInstance, dir, { recursive: true });
    const report = join(dir, 'report.json');
    const r = spawnSync(
      'node',
      [bundle, 'validate', '--paper', dir, '--repo', repo, '--report', report, '--json'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.checkRun.conclusion).toBe('success');
    // Composed against the co-located journal.yml: its five selected checks actually ran.
    const ids = new Set(out.checks.map((c: any) => c.id));
    expect(ids.has('abstract-exists')).toBe(true);
    // ...and it did NOT silently degrade to the author's own config.
    expect((out.notes ?? []).join(' ')).not.toMatch(/uncomposed/i);
  }, 60_000);

  it('--no-instance is still the explicit bare-check opt-out', () => {
    const r = spawnSync('node', [bundle, 'validate', '--paper', paperOnly(), '--no-instance', '--json'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).checkRun.conclusion).toBe('success');
  }, 60_000);
});
