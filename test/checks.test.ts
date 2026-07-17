import { describe, it, expect } from 'vitest';
import { toCheckRun, CheckStatus, type EngineCheckResult } from '../src/checks.js';

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
