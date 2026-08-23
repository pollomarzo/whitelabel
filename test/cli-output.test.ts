/**
 * cli-output.test.ts — the CLI's OUTPUT contract, driven through the real bundle: what a
 * human sees by default, what a machine sees under `--json`, and what an unrecognized word
 * gets told. These are the assertable halves of the UX-test output pass; the rest (plan
 * wording) is asserted where the plans are built, in bootstrap.test.ts.
 *
 * Skipped unless `dist/cli.cjs` is present (bundle-state.ts), like the other bundle suites.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleState, assertBundleNotStale, bundlePath } from './bundle-state.js';
import { labelChildOutput } from '../src/gh.js';

const engineDir = fileURLToPath(new URL('..', import.meta.url));
const fixturePaper = join(engineDir, 'test', 'fixture-paper');
const fixtureInstance = join(engineDir, 'test', 'fixture-instance');
/** The repo the fixture paper is registered to (id-uniqueness passes only under it). */
const fixtureRepo = 'open-scholar-nexus/fixture-sample-paper';

/**
 * Run the bundle as a TENANT's terminal sees it. `CI`/`GITHUB_ACTIONS` are cleared deliberately:
 * they switch the output to GitHub annotations, and this suite is the contract for the human
 * side — inheriting them would make these assertions pass locally and fail in our own CI.
 */
function oak(args: string[]): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  const r = spawnSync('node', [bundlePath, ...args], { encoding: 'utf8', env });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(bundleState() === 'absent')('an unrecognized command is an ERROR, not a manual', () => {
  beforeAll(assertBundleNotStale);

  it('names the word it did not understand and suggests the near miss', () => {
    // The UX-test complaint: a typo printed the usage block with no message, so it looked
    // exactly like a bare `oak` and read as "ran, did nothing".
    const { code, stderr } = oak(['bootstrp']);
    expect(code).toBe(2);
    expect(stderr).toContain("oak: unknown command 'bootstrp'");
    expect(stderr).toContain("did you mean 'bootstrap'");
  });

  it('says nothing about near misses when nothing is near', () => {
    const { code, stderr } = oak(['zzzzzzzz']);
    expect(code).toBe(2);
    expect(stderr).toContain("oak: unknown command 'zzzzzzzz'");
    expect(stderr).not.toContain('did you mean');
  });

  it('a BARE oak is not an error message — just the usage', () => {
    const { code, stderr } = oak([]);
    expect(code).toBe(2);
    expect(stderr).not.toContain('unknown command');
  });
});

describe.skipIf(bundleState() === 'absent')('usage opens with what oak is and where to start', () => {
  beforeAll(assertBundleNotStale);

  it('leads with a description and the first command a newcomer runs', () => {
    const { stderr } = oak([]);
    const head = stderr.split('\n').slice(0, 8).join('\n');
    expect(head).toMatch(/^oak: a mystmd-based toolkit for running a small journal/);
    expect(head).toContain('oak bootstrap journal');
    // ...and the verb list still comes after, not instead.
    expect(stderr).toContain('oak validate');
  });

  it('explains --external and --co-located in plain words', () => {
    const { stderr } = oak([]);
    expect(stderr).toMatch(/--external\s+the journal gets its own public repo/);
    expect(stderr).toMatch(/--co-located\s+one repo holds the journal and its single paper/);
  });

  it('documents the two cross-cutting flags this pass introduced', () => {
    const { stderr } = oak([]);
    expect(stderr).toContain('--json');
    expect(stderr).toContain('--verbose');
  });
});

describe.skipIf(bundleState() === 'absent')('--json gates the machine envelope', () => {
  beforeAll(assertBundleNotStale);

  /** The fixture paper, alone in a temp dir (no journal.yml beside it). */
  function paperOnly(): string {
    const dir = mkdtempSync(join(tmpdir(), 'oak-cliout-'));
    for (const f of ['bib.bib', 'index.md', 'myst.yml']) copyFileSync(join(fixturePaper, f), join(dir, f));
    return dir;
  }

  it('oak validate: stdout is EMPTY without --json, and the verdict is prose on stderr', () => {
    const { code, stdout, stderr } = oak(['validate', '--paper', fixturePaper, '--instance', fixtureInstance, '--repo', fixtureRepo]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toMatch(/oak validate: PASS/);
  }, 60_000);

  it('oak validate: --json still puts the full envelope, checkRun included, on stdout', () => {
    const { stdout } = oak(['validate', '--paper', fixturePaper, '--instance', fixtureInstance, '--repo', fixtureRepo, '--json']);
    const out = JSON.parse(stdout);
    expect(out.status).toBe('ok');
    expect(out.checkRun.conclusion).toBe('success');
  }, 60_000);

  it('the human summary lists the findings rather than dropping them', () => {
    // A shorter summary that hid findings would be a different verdict.
    const { stderr } = oak(['validate', '--paper', paperOnly(), '--no-instance']);
    expect(stderr).toMatch(/oak validate: (PASS|FAIL)/);
    // The fixture has no thumbnail; uncomposed runs also carry a note. Either way, whatever
    // the envelope holds is on screen — assert one representative warning reaches it.
    expect(stderr).toMatch(/[✗!→]/);
  }, 60_000);

  it('a refusal prints the sentence, not a JSON record', () => {
    // `oak upgrade --paper <dir>` against a directory that is not a paper repo: a pure local
    // refusal (no network), and the shape every error result now takes without --json.
    const { code, stdout, stderr } = oak(['upgrade', '--paper', mkdtempSync(join(tmpdir(), 'oak-notapaper-'))]);
    expect(code).toBe(2);
    expect(stdout.trim()).toBe('');
    expect(stderr).not.toContain('"status"');
    expect(stderr).toContain('pins.yml');
  });
});

describe.skipIf(bundleState() === 'absent')('a broken paper gets a sentence, never a stack', () => {
  beforeAll(assertBundleNotStale);

  /** A journal repo: journal.yml + a myst.yml that is the WEBSITE (no engine coordinate). */
  function journalRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'oak-journal-'));
    writeFileSync(join(dir, 'journal.yml'), 'name: A Journal\nid_pattern: ".*"\n');
    writeFileSync(join(dir, 'myst.yml'), 'version: 1\nproject:\n  title: A Journal\nsite:\n  template: book-theme\n');
    return dir;
  }

  it('oak build in the JOURNAL repo says so instead of dying on the engine coordinate', () => {
    // The UX-test crash, exactly: `oak build` in the journal clone. The co-located rung read
    // its journal.yml as "the settings are here", so the run reached the paper-only config read.
    const dir = journalRepo();
    const { code, stderr } = oak(['build', '--paper', dir]);
    expect(code).toBe(2);
    expect(stderr).toContain('is the journal repo, not a paper');
    expect(stderr).toContain('--paper');
    // No stack, and no GitHub annotation syntax outside CI.
    expect(stderr).not.toContain('::error::');
    expect(stderr).not.toMatch(/\bat \w+ \(/);
    expect(stderr).not.toContain('cli.cjs:');
  });

  it('oak validate in the JOURNAL repo refuses the same way', () => {
    const { code, stderr } = oak(['validate', '--paper', journalRepo()]);
    expect(code).toBe(2);
    expect(stderr).toContain('is the journal repo, not a paper');
    expect(stderr).not.toContain('::error::');
  });

  it('a paper whose myst.yml lost its engine version names the file and the fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oak-nocoord-'));
    for (const f of ['bib.bib', 'index.md', 'myst.yml']) copyFileSync(join(fixturePaper, f), join(dir, f));
    const authorPath = join(dir, 'myst.yml');
    writeFileSync(authorPath, readFileSync(authorPath, 'utf8').replace(/\n\s*version: .*/, ''));

    const { code, stderr } = oak(['build', '--paper', dir, '--no-instance']);
    expect(code).toBe(2);
    expect(stderr).toContain(authorPath);
    expect(stderr).toContain('project.options.oaktree-sapling');
    expect(stderr).not.toContain('::error::');
    expect(stderr).not.toContain('cli.cjs:');
  }, 60_000);

  it('usage lists oak start next to oak build', () => {
    const { stderr } = oak([]);
    expect(stderr).toMatch(/oak start/);
    expect(stderr).toContain("mystmd's live preview");
  });
});

describe('subprocess output carries its provenance', () => {
  it('labels every line with the tool that produced it', () => {
    const out = labelChildOutput('git', "Cloning into '/tmp/oak-seed-x'...\n\nwarning: empty repository\n");
    expect(out.split('\n')).toEqual([
      "  [git] Cloning into '/tmp/oak-seed-x'...",
      '  [git] warning: empty repository',
    ]);
  });

  it('an empty capture prints nothing at all', () => {
    expect(labelChildOutput('gh', '')).toBe('');
    expect(labelChildOutput('gh', undefined)).toBe('');
  });
});
