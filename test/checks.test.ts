import { describe, it, expect } from 'vitest';
import { runChecks, toCheckRun, CHECK_CATALOG_IDS, type CheckResult } from '../src/checks.js';

describe('runChecks (Layer B — journal-selected checks)', () => {
  const project = {
    authors: [
      { name: 'A', orcid: '0000-0002-1825-0097', roles: ['software'] },
      { name: 'B' },
    ],
    abstract: 'an abstract',
    keywords: ['k'],
  };

  it('runs per-author checks, one result per author', () => {
    const res = runChecks(project, [{ id: 'authors-have-orcid' }]);
    expect(res).toHaveLength(2);
    expect(res[0]!.status).toBe('pass');
    expect(res[1]!.status).toBe('fail');
  });

  it('flags exactly the incomplete author across the catalog (B lacks orcid + roles)', () => {
    const res = runChecks(project, CHECK_CATALOG_IDS.map((id) => ({ id })));
    expect(res.filter((r) => r.status === 'fail')).toHaveLength(2);
  });

  it('detects an abstract myst moved into parts.abstract (real loadProject shape)', () => {
    // myst normalizes a frontmatter `abstract:` into parts.abstract and drops the top-level
    // field; the check must still pass. Regression for the e2e false-negative.
    const withPart = { authors: [{ name: 'A' }], parts: { abstract: ['ref#project.parts.abstract'] } };
    const res = runChecks(withPart, [{ id: 'abstract-exists' }]);
    expect(res[0]!.status).toBe('pass');
    const noPart = { authors: [{ name: 'A' }], parts: {} };
    expect(runChecks(noPart, [{ id: 'abstract-exists' }])[0]!.status).toBe('fail');
  });

  it('surfaces an unknown check id as an error result (journal misconfig)', () => {
    const res = runChecks(project, [{ id: 'not-a-check' }]);
    expect(res[0]!.status).toBe('error');
  });

  it('stamps optional on an optional check', () => {
    const res = runChecks({ authors: [] }, [{ id: 'authors-exist', optional: true }]);
    expect(res[0]!.optional).toBe(true);
    expect(res[0]!.status).toBe('fail');
  });
});

describe('toCheckRun (reporting option 2 — GitHub Check Run)', () => {
  it('fails the conclusion on a non-optional failure', () => {
    expect(toCheckRun([{ id: 'x', status: 'fail', message: 'bad' }]).conclusion).toBe('failure');
  });

  it('optional failures annotate but do not gate merge', () => {
    const r = toCheckRun([
      { id: 'x', status: 'fail', optional: true },
      { id: 'y', status: 'pass' },
    ]);
    expect(r.conclusion).toBe('success');
  });

  it('emits inline annotations from file+position, capped at 50', () => {
    const results: CheckResult[] = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`,
      status: 'fail',
      message: 'm',
      file: 'index.md',
      position: { line: i + 1 },
    }));
    const r = toCheckRun(results);
    expect(r.annotations).toHaveLength(50);
    expect(r.annotations[0]).toMatchObject({ path: 'index.md', start_line: 1, annotation_level: 'failure' });
  });

  it('renders a markdown summary table', () => {
    const r = toCheckRun([{ id: 'abstract-exists', status: 'pass' }]);
    expect(r.summary).toContain('| Check | Status | Detail |');
    expect(r.summary).toContain('abstract-exists');
  });
});
