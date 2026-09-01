/**
 * The guard steps in the frozen shim, run as shell against the real YAML ([R99]).
 *
 * `template.test.ts` asserts which files are stamped; nothing asserted what any of them DOES,
 * which is how [R90] survived a month of green CI. These extract a step's `run:` script by id
 * and execute it, so the assertion is on the shipped bytes rather than on a copy.
 *
 * ⚑ This is bash, not a GitHub runner: `${{ }}` is already resolved by the time a real step runs,
 * `$GITHUB_OUTPUT` is a real file there, and the shell setup differs. So this covers the SCRIPT
 * logic and will not catch a workflow-level or expression-level fault. Treat a green run here as
 * necessary, not sufficient; the live conformance run is what exercises the real thing.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

const SHIM = 'templates/paper';

/** The `run:` script of the step with this `id`, from a frozen workflow or action. */
function stepScript(file: string, id: string): string {
  const doc = parseDocument(readFileSync(join(SHIM, file), 'utf8')).toJS() as {
    runs?: { steps: Array<Record<string, string>> };
    jobs?: Record<string, { steps: Array<Record<string, string>> }>;
  };
  const steps = doc.runs
    ? doc.runs.steps
    : Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
  const step = steps.find((s) => s.id === id);
  if (!step?.run) throw new Error(`no step '${id}' with a run: in ${file}`);
  return step.run;
}

function run(script: string, env: Record<string, string>, cwd?: string) {
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, GITHUB_OUTPUT: '/dev/null', ...env },
  });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('the engine action refuses an untrusted ref class ([R41])', () => {
  const script = stepScript('.github/actions/engine/action.yml', 'refclass');

  it('refuses an unmerged engine PR from a fork', () => {
    const r = run(script, { REF: 'refs/pull/7/merge', IS_FORK: 'true' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('unmerged pull request');
  });

  it('refuses a raw commit from a fork', () => {
    const r = run(script, { REF: 'a'.repeat(40), IS_FORK: 'true' });
    expect(r.code).toBe(1);
  });

  it('allows the refs a paper is supposed to pin', () => {
    for (const ref of ['v1.2.3', 'v0.0.0-dev.18', 'main']) {
      expect(run(script, { REF: ref, IS_FORK: 'true' }).code).toBe(0);
    }
  });

  it('leaves same-repo dogfooding alone', () => {
    expect(run(script, { REF: 'refs/pull/7/merge', IS_FORK: 'false' }).code).toBe(0);
  });
});

describe('preview-deploy refuses a PR number the artifact made up ([R136])', () => {
  const script = stepScript('.github/workflows/preview-deploy.yml', 'pr-owner');

  /** A site dir plus a `gh` on PATH that answers with `headSha`, so no network. */
  function fixture(prNumber: string | null, headSha: string) {
    const dir = mkdtempSync(join(tmpdir(), 'oak-guard-'));
    const bin = mkdtempSync(join(tmpdir(), 'oak-bin-'));
    if (prNumber !== null) {
      spawnSync('mkdir', ['-p', join(dir, 'site')]);
      writeFileSync(join(dir, 'site/.pr-number'), prNumber);
    }
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho ${headSha}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
  }

  it('refuses a value that is not a number', () => {
    const f = fixture('1/comments?x=', 'deadbeef');
    const r = run(script, { ...f.env, REPO: 'o/r', HEAD_SHA: 'deadbeef' }, f.dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('is not a number');
  });

  it('refuses a real PR that is not the one this run built', () => {
    const f = fixture('99', 'other-sha');
    const r = run(script, { ...f.env, REPO: 'o/r', HEAD_SHA: 'deadbeef' }, f.dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('refusing to comment');
  });

  it('accepts the PR this run actually built', () => {
    const f = fixture('99', 'deadbeef');
    expect(run(script, { ...f.env, REPO: 'o/r', HEAD_SHA: 'deadbeef' }, f.dir).code).toBe(0);
  });

  it('no-ops on a push build, which has no PR number', () => {
    const f = fixture(null, 'deadbeef');
    expect(run(script, { ...f.env, REPO: 'o/r', HEAD_SHA: 'deadbeef' }, f.dir).code).toBe(0);
  });
});
