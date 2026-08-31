/**
 * upgrade.test.ts: `oak upgrade` drift + orchestration (slice 5), through FAKE seams (no
 * gh/git). Proves: computeDrift's 2-way reset-to-template semantics (clean / changed-template
 * / hand-edited-repo); --version-only writes only myst.yml; --files-only overwrites only the
 * drifted frozen files; --both; a clean repo opens no PR; the PR branch + paths are
 * `/.github/`-gated.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  renderCodeowners,
  codeownersColumns,
  renderPaperTemplate,
  type TemplateAnswers,
} from '../src/bootstrap.js';
import {
  computeDrift,
  readAnswers,
  cmdUpgrade,
  type UpgradePr,
  type UpgradeDeps,
  ownerFromCodeowners,
} from '../src/upgrade.js';

const TEMPLATE_ROOT = 'templates/paper';
const tmp = (p = 'oak-up-') => mkdtempSync(join(tmpdir(), p));

const answers: TemplateAnswers = {
  engineRepo: 'me/engine',
  instanceRepo: 'me/instance-config',
  owner: '@alice',
  version: 'v1.0.0',
  edition: 'ed-2026',
};

/** A paper repo on disk (frozen shim + starter content) at version v1.0.0. */
function makeRepo(): string {
  const dir = tmp('oak-repo-');
  renderPaperTemplate(TEMPLATE_ROOT, dir, answers);
  return dir;
}

/* --------------------------------------------------------------------------
 * computeDrift
 * ------------------------------------------------------------------------ */

describe('computeDrift', () => {
  it('no drift when the repo matches the target render', () => {
    const repo = makeRepo();
    expect(computeDrift(repo, TEMPLATE_ROOT, readAnswers(repo))).toEqual([]);
  });

  it('reports a frozen file that changed in the template', () => {
    const repo = makeRepo();
    const target = tmp('oak-tmpl-');
    cpSync(TEMPLATE_ROOT, target, { recursive: true });
    appendFileSync(join(target, '.github/workflows/ci.yml'), '\n# new template line\n');
    expect(computeDrift(repo, target, readAnswers(repo))).toEqual(['.github/workflows/ci.yml']);
  });

  it('keeps a second CODEOWNER the tenant added ([R126])', () => {
    const repo = makeRepo();
    const co = join(repo, 'CODEOWNERS');
    writeFileSync(co, readFileSync(co, 'utf8').replace(/@alice/g, '@org/editors @alice'));
    expect(computeDrift(repo, TEMPLATE_ROOT, readAnswers(repo))).toEqual([]);
  });

  it('keeps DIFFERENT owners on different paths ([R126])', () => {
    // The two halves of the fix mask each other when every path has the same owner, so this is
    // the case that pins the column being path-keyed: an owner added to one gated path must not
    // be spread onto the others, least of all onto CODEOWNERS itself.
    const repo = makeRepo();
    const co = join(repo, 'CODEOWNERS');
    writeFileSync(
      co,
      readFileSync(co, 'utf8').replace(
        '/.github/                @alice',
        '/.github/                @org/editors @alice',
      ),
    );
    expect(computeDrift(repo, TEMPLATE_ROOT, readAnswers(repo))).toEqual([]);
    const after = readFileSync(co, 'utf8');
    expect(after).toContain('/.github/                @org/editors @alice');
    expect(after).toMatch(/\/CODEOWNERS\s+@alice$/m);
  });

  it('uses the whole column as the fallback for a path the repo lacks ([R126])', () => {
    // Live case: every repo seeded before /paper-environment.yml joined the gate has a CODEOWNERS
    // without that line, so the template's line falls back to the derived owner.
    const repo = makeRepo();
    const co = join(repo, 'CODEOWNERS');
    const older = readFileSync(co, 'utf8')
      .split('\n')
      .filter((l) => !l.includes('paper-environment.yml'))
      .join('\n')
      .replace(/@alice/g, '@org/editors @alice');
    writeFileSync(co, older);
    const rendered = renderCodeowners(
      readFileSync(join(TEMPLATE_ROOT, 'CODEOWNERS'), 'utf8'),
      ownerFromCodeowners(older),
      codeownersColumns(older),
    );
    expect(rendered).toMatch(/paper-environment\.yml\s+@org\/editors @alice$/m);
  });

  it('a resync does not revert a second CODEOWNER on an unrelated drift ([R126])', async () => {
    const repo = makeRepo();
    const co = join(repo, 'CODEOWNERS');
    writeFileSync(co, readFileSync(co, 'utf8').replace(/@alice/g, '@org/editors @alice'));
    appendFileSync(join(repo, '.github/workflows/ci.yml'), '\n# hand edit\n');
    const { pr } = fakePr();
    await cmdUpgrade(
      { repoRoot: repo, mode: 'files-only' },
      deps(pr, 'v2.0.0', () => TEMPLATE_ROOT),
    );
    expect(readFileSync(co, 'utf8')).toContain('@org/editors @alice');
  });

  it('reports a hand-edited repo file (reset-to-template)', () => {
    const repo = makeRepo();
    appendFileSync(join(repo, '.github/workflows/publish.yml'), '\n# hand edit\n');
    expect(computeDrift(repo, TEMPLATE_ROOT, readAnswers(repo))).toEqual([
      '.github/workflows/publish.yml',
    ]);
  });
});

/* --------------------------------------------------------------------------
 * Fake PR seam + deps
 * ------------------------------------------------------------------------ */

function fakePr() {
  const opened: Array<{ branch: string; paths: string[] }> = [];
  const pr: UpgradePr = {
    open(_root, o) {
      opened.push({ branch: o.branch, paths: o.paths });
      return 'https://github.com/me/paper/pull/9';
    },
  };
  return { pr, opened };
}

function deps(pr: UpgradePr, target: string, materialize: () => string): UpgradeDeps {
  return {
    resolveTarget: () => target,
    materializeTemplate: materialize,
    pr,
    log: () => {},
    confirm: async () => true,
  };
}

/* --------------------------------------------------------------------------
 * cmdUpgrade
 * ------------------------------------------------------------------------ */

describe('cmdUpgrade', () => {
  it('--version-only writes only myst.yml and PRs just that path', async () => {
    const repo = makeRepo();
    const before = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
    const { pr, opened } = fakePr();
    const out = await cmdUpgrade(
      { repoRoot: repo, mode: 'version-only' },
      deps(pr, 'v2.0.0', () => TEMPLATE_ROOT),
    );
    expect(out.result.version_bumped).toBe(true);
    const myst = parseDocument(readFileSync(join(repo, 'myst.yml'), 'utf8'));
    expect(myst.getIn(['project', 'options', 'oaktree-sapling', 'version'])).toBe('v2.0.0');
    expect(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')).toBe(before); // shim untouched
    expect(opened[0]!.paths).toEqual(['myst.yml']);
    expect(opened[0]!.branch).toBe('oak/upgrade-v2.0.0');
  });

  it('--files-only overwrites only drifted frozen files, leaves myst.yml, PR is /.github/-gated', async () => {
    const repo = makeRepo();
    const mystBefore = readFileSync(join(repo, 'myst.yml'), 'utf8');
    const target = tmp('oak-tmpl-');
    cpSync(TEMPLATE_ROOT, target, { recursive: true });
    appendFileSync(join(target, '.github/workflows/ci.yml'), '\n# upgraded\n');

    const { pr, opened } = fakePr();
    const out = await cmdUpgrade(
      { repoRoot: repo, mode: 'files-only' },
      deps(pr, 'v2.0.0', () => target),
    );
    expect(out.result.version_bumped).toBe(false);
    expect(out.result.drift).toEqual(['.github/workflows/ci.yml']);
    expect(readFileSync(join(repo, 'myst.yml'), 'utf8')).toBe(mystBefore); // version NOT bumped
    expect(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')).toContain('# upgraded'); // resynced
    expect(opened[0]!.paths).toEqual(['.github/workflows/ci.yml']);
    expect(opened[0]!.paths.every((p) => p.startsWith('.github/') || p === 'CODEOWNERS')).toBe(
      true,
    );
  });

  it('--both bumps version and resyncs drifted files', async () => {
    const repo = makeRepo();
    const target = tmp('oak-tmpl-');
    cpSync(TEMPLATE_ROOT, target, { recursive: true });
    appendFileSync(join(target, '.github/workflows/ci.yml'), '\n# upgraded\n');

    const { pr, opened } = fakePr();
    const out = await cmdUpgrade(
      { repoRoot: repo, mode: 'both' },
      deps(pr, 'v3.0.0', () => target),
    );
    expect(out.result.version_bumped).toBe(true);
    expect(out.result.drift).toEqual(['.github/workflows/ci.yml']);
    expect(opened[0]!.paths).toContain('myst.yml');
    expect(opened[0]!.paths).toContain('.github/workflows/ci.yml');
  });

  it('a clean repo already at target opens no PR', async () => {
    const repo = makeRepo(); // version v1.0.0, shim matches template
    const { pr, opened } = fakePr();
    const out = await cmdUpgrade(
      { repoRoot: repo, mode: 'both' },
      deps(pr, 'v1.0.0', () => TEMPLATE_ROOT),
    );
    expect(out.result.up_to_date).toBe(true);
    expect(out.result.pr).toBeNull();
    expect(opened).toHaveLength(0);
  });
});
