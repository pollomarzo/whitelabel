import { describe, it, expect } from 'vitest';
import {
  toCheckRun,
  checksComment,
  cmdCheckPost,
  STICKY_CHECKS,
  CheckStatus,
  type EngineCheckResult,
  type CheckRun,
  type ChecksReport,
  type CheckPostDeps,
} from '../src/checks.js';

// The editorial checks themselves come from @curvenote/check-implementations and read the myst
// store, so they can only run against a real (bundled) session — covered end-to-end in
// validate.integration.test.ts. What stays unit-testable here is our pure Check-Run REPORTER.

describe('toCheckRun (reporting — GitHub Check Run, ours)', () => {
  it('fails the conclusion on a non-optional failure', () => {
    expect(
      toCheckRun([{ id: 'x', status: CheckStatus.fail, message: 'bad' }]).conclusion,
    ).toBe('failure');
  });

  it('an error status also gates (failure conclusion)', () => {
    expect(toCheckRun([{ id: 'x', status: CheckStatus.error }]).conclusion).toBe('failure');
  });

  it('optional failures annotate but do not gate merge', () => {
    const r = toCheckRun([
      { id: 'x', status: CheckStatus.fail, optional: true },
      { id: 'y', status: CheckStatus.pass },
    ]);
    expect(r.conclusion).toBe('success');
  });

  it('emits inline annotations from file+position (unist), capped at 50', () => {
    const results: EngineCheckResult[] = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`,
      status: CheckStatus.fail,
      message: 'm',
      file: 'index.md',
      position: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 1 } },
    }));
    const r = toCheckRun(results);
    expect(r.annotations).toHaveLength(50);
    expect(r.annotations[0]).toMatchObject({ path: 'index.md', start_line: 1, annotation_level: 'failure' });
  });

  it('relativizes an absolute annotation path against pathBase, leaves a relative one alone', () => {
    // curvenote emits absolute (selectCurrentProjectFile) OR relative (loadProjectFromDisk) paths;
    // GitHub only resolves repo-relative ones. pathBase = the checkout root.
    const r = toCheckRun(
      [
        {
          id: 'abs',
          status: CheckStatus.fail,
          message: 'm',
          file: '/home/runner/work/repo/repo/papers/foo/myst.yml',
          position: { start: { line: 3, column: 1 }, end: { line: 3, column: 1 } },
        },
        {
          id: 'rel',
          status: CheckStatus.fail,
          message: 'm',
          file: 'index.md',
          position: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
        },
      ],
      '/home/runner/work/repo/repo',
    );
    expect(r.annotations[0]?.path).toBe('papers/foo/myst.yml');
    expect(r.annotations[1]?.path).toBe('index.md');
  });

  it('never annotates a finding anchored to the DERIVED config ([R82])', () => {
    // Since validate reads myst.oak.yml, curvenote's config-anchored results name a generated,
    // gitignored file. GitHub cannot resolve that path (and a batch of unresolvable ones 422s
    // the POST); rewriting it to myst.yml would pin a confident annotation on a line number
    // that is not the author's. So the finding stays in the summary, the inline pin goes.
    const r = toCheckRun(
      [
        {
          id: 'derived',
          status: CheckStatus.fail,
          message: 'no keywords',
          file: '/paper/myst.oak.yml',
          position: { start: { line: 12, column: 1 }, end: { line: 12, column: 1 } },
        },
        {
          id: 'authored',
          status: CheckStatus.fail,
          message: 'bad abstract',
          file: '/paper/index.md',
          position: { start: { line: 4, column: 1 }, end: { line: 4, column: 1 } },
        },
      ],
      '/paper',
    );
    expect(r.annotations.map((a) => a.path)).toEqual(['index.md']);
    // Dropped from the annotations, NOT from the report — it still gates and still shows.
    expect(r.conclusion).toBe('failure');
    expect(r.summary).toMatch(/no keywords/);
  });

  it('without a pathBase, paths pass through unchanged (pure default)', () => {
    const r = toCheckRun([
      {
        id: 'abs',
        status: CheckStatus.fail,
        message: 'm',
        file: '/abs/myst.yml',
        position: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
    expect(r.annotations[0]?.path).toBe('/abs/myst.yml');
  });

  it('an optional finding annotates as a warning, not a failure', () => {
    const r = toCheckRun([
      {
        id: 'c',
        status: CheckStatus.fail,
        message: 'm',
        file: 'index.md',
        position: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } },
        optional: true,
      },
    ]);
    expect(r.annotations[0]?.annotation_level).toBe('warning');
  });

  it('renders a markdown summary table keyed by check id', () => {
    const r = toCheckRun([{ id: 'abstract-exists', status: CheckStatus.pass }]);
    expect(r.summary).toContain('| Check | Status | Detail |');
    expect(r.summary).toContain('abstract-exists');
  });
});

/* --------------------------------------------------------------------------
 * Stage-2 write-back — the sticky comment renderer + check-post orchestration.
 * ------------------------------------------------------------------------ */

const report = (over: Partial<CheckRun> = {}): ChecksReport => ({
  status: over.conclusion === 'failure' ? 'error' : 'ok',
  checkRun: toCheckRun([
    { id: 'abstract-exists', status: CheckStatus.pass },
    ...(over.conclusion === 'failure'
      ? [{ id: 'authors-have-orcid', status: CheckStatus.fail, message: 'no ORCID' } as EngineCheckResult]
      : []),
  ]),
});

describe('checksComment (sticky PR-comment renderer)', () => {
  it('renders a success body: sticky marker, ✅ headline, counts, table', () => {
    const body = checksComment(report());
    expect(body.startsWith(`<!-- oak-sticky: ${STICKY_CHECKS} -->`)).toBe(true);
    expect(body).toContain('✅');
    expect(body).toContain('1 passed, 0 failed');
    expect(body).toContain('| Check | Status | Detail |');
    expect(body).toContain('abstract-exists');
  });

  it('renders a failure body: ❌ headline, failure counts, the failing check in the table', () => {
    const body = checksComment(report({ conclusion: 'failure' }));
    expect(body).toContain('❌');
    expect(body).toContain('1 passed, 1 failed');
    expect(body).toContain('authors-have-orcid');
  });
});

function fakePost(over: Partial<CheckPostDeps> = {}): {
  deps: CheckPostDeps;
  runs: Array<{ repo: string; sha: string; name: string; run: CheckRun }>;
  stickies: Array<{ pr: string; header: string; body: string }>;
} {
  const runs: Array<{ repo: string; sha: string; name: string; run: CheckRun }> = [];
  const stickies: Array<{ pr: string; header: string; body: string }> = [];
  const deps: CheckPostDeps = {
    checkRun: { create: (repo, sha, name, run) => void runs.push({ repo, sha, name, run }) },
    sticky: (_root, pr, header, body) => void stickies.push({ pr, header, body }),
    ...over,
  };
  return { deps, runs, stickies };
}

describe('cmdCheckPost (Stage-2 orchestration, fake seams)', () => {
  it('posts the Check Run and upserts the sticky comment when a PR is given', () => {
    const { deps, runs, stickies } = fakePost();
    const out = cmdCheckPost({ report: report(), repo: 'o/r', sha: 'abc', pr: '7' }, deps);
    expect(out.checkRunPosted).toBe(true);
    expect(out.commentPosted).toBe(true);
    expect(runs).toEqual([{ repo: 'o/r', sha: 'abc', name: 'Journal checks', run: report().checkRun }]);
    expect(stickies).toHaveLength(1);
    expect(stickies[0]).toMatchObject({ pr: '7', header: STICKY_CHECKS });
    expect(stickies[0]!.body).toContain('| Check | Status | Detail |');
  });

  it('without --pr posts the Check Run but no comment', () => {
    const { deps, runs, stickies } = fakePost();
    const out = cmdCheckPost({ report: report(), repo: 'o/r', sha: 'abc' }, deps);
    expect(runs).toHaveLength(1);
    expect(stickies).toHaveLength(0);
    expect(out.checkRunPosted).toBe(true);
    expect(out.commentPosted).toBe(false);
  });

  it('a throwing Check-Run seam degrades to a warning, still upserts the comment', () => {
    const { deps, stickies } = fakePost({
      checkRun: { create: () => { throw new Error('403 read-only'); } },
    });
    const out = cmdCheckPost({ report: report(), repo: 'o/r', sha: 'abc', pr: '7' }, deps);
    expect(out.checkRunPosted).toBe(false);
    expect(out.commentPosted).toBe(true);
    expect(stickies).toHaveLength(1);
    expect(out.warnings.join(' ')).toContain('Check Run not posted');
  });

  it('a throwing sticky seam degrades to a warning (no crash)', () => {
    const { deps, runs } = fakePost({
      sticky: () => { throw new Error('boom'); },
    });
    const out = cmdCheckPost({ report: report(), repo: 'o/r', sha: 'abc', pr: '7' }, deps);
    expect(out.checkRunPosted).toBe(true);
    expect(out.commentPosted).toBe(false);
    expect(runs).toHaveLength(1);
    expect(out.warnings.join(' ')).toContain('comment not posted');
  });
});
