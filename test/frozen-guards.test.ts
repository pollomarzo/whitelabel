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
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { readdirSync } from 'node:fs';

const SHIM = 'templates/paper';

/** The `run:` script of the step with this `id` (or `name`), from a frozen workflow or action. */
function stepScript(file: string, id: string | undefined, name?: string): string {
  const doc = parseDocument(readFileSync(join(SHIM, file), 'utf8')).toJS() as {
    runs?: { steps: Array<Record<string, string>> };
    jobs?: Record<string, { steps: Array<Record<string, string>> }>;
  };
  const steps = doc.runs
    ? doc.runs.steps
    : Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
  const step = steps.find((s) => (id ? s.id === id : s.name === name));
  if (!step?.run) throw new Error(`no step '${id ?? name}' with a run: in ${file}`);
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

describe('the engine action refuses a malformed ref before echoing it ([R155])', () => {
  const script = stepScript('.github/actions/engine/action.yml', 'ref');

  /** Run the ref step with `yq` stubbed to print `value` and a real GITHUB_OUTPUT file. */
  function refStep(value: string) {
    const dir = mkdtempSync(join(tmpdir(), 'oak-ref-'));
    const bin = mkdtempSync(join(tmpdir(), 'oak-bin-'));
    writeFileSync(join(dir, 'myst.yml'), 'project: {}');
    writeFileSync(join(bin, 'yq'), `#!/bin/sh\nprintf '%s' "$YQ_VALUE"\n`);
    chmodSync(join(bin, 'yq'), 0o755);
    const outFile = join(dir, 'gh_output');
    writeFileSync(outFile, '');
    const r = run(
      script,
      { PATH: `${bin}:${process.env.PATH}`, YQ_VALUE: value, GITHUB_OUTPUT: outFile },
      dir,
    );
    return { ...r, output: readFileSync(outFile, 'utf8') };
  }

  it('refuses a block-scalar version that injects a second $GITHUB_OUTPUT line', () => {
    const r = refStep('v0.0.3\ninjected=PWNED');
    expect(r.code).toBe(1);
    expect(r.output).not.toContain('injected=PWNED');
  });

  it('refuses a version carrying a shell metacharacter', () => {
    for (const v of ['v1;id', 'v1 2', 'v1$(id)', 'v1`id`']) {
      expect(refStep(v).code).toBe(1);
    }
  });

  it('writes exactly one ref= line for the versions a paper actually pins', () => {
    for (const v of ['v1.2.3', 'v0.0.0-dev.35', 'refs/pull/7/merge', 'a'.repeat(40), 'main']) {
      const r = refStep(v);
      expect(r.code).toBe(0);
      expect(r.output.trim()).toBe(`ref=${v}`);
    }
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

describe('the Stage-1 artifact stays readable by the PREVIOUS Stage 2 ([R146])', () => {
  const script = stepScript('.github/workflows/check.yml', undefined, 'Record PR number');

  it('still writes head-sha, which an older check-post.yml cats', () => {
    // An upgrade PR runs new Stage 1 against old Stage 2, which still cats this field.
    expect(script).toContain('> head-sha');
  });
});

describe('the dispatch step takes args as data, not as script ([R153])', () => {
  const script = stepScript('.github/actions/engine/action.yml', 'dispatch');

  /** The runner resolves `${{ }}` by TEXT substitution before bash sees the script, so deliver
   *  the payload both ways: whichever shape the action ships, this is what would reach it. */
  function dispatch(args: string) {
    const dir = mkdtempSync(join(tmpdir(), 'oak-dispatch-'));
    mkdirSync(join(dir, '.engine/ci'), { recursive: true });
    const stub = join(dir, '.engine/ci/run.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > argv\n');
    chmodSync(stub, 0o755);
    const r = run(script.replaceAll('${{ inputs.args }}', args), { ARGS: args }, dir);
    const f = join(dir, 'argv');
    return {
      ...r,
      dir,
      argv: existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [],
    };
  }

  it('does not run a command substitution carried in a tag name', () => {
    // A v* tag reaches the token-bearing publish job; $IFS avoids the space git forbids.
    const d = dispatch('release --tag v1.0.0$(touch${IFS}pwned)');
    expect(existsSync(join(d.dir, 'pwned'))).toBe(false);
    expect(d.argv).toEqual(['release', '--tag', 'v1.0.0$(touch${IFS}pwned)']);
  });

  it('does not run a backquoted command either', () => {
    const d = dispatch('release --tag v1.0.0`touch${IFS}pwned`');
    expect(existsSync(join(d.dir, 'pwned'))).toBe(false);
  });

  it('does not let a metacharacter start a second command', () => {
    const d = dispatch('release --tag v1;touch pwned');
    expect(existsSync(join(d.dir, 'pwned'))).toBe(false);
  });

  it('still word-splits the verb and its flags, which the shim depends on', () => {
    expect(dispatch('check-post --report journal-checks/report.json --repo o/r').argv).toEqual([
      'check-post',
      '--report',
      'journal-checks/report.json',
      '--repo',
      'o/r',
    ]);
  });

  it('splits without globbing: a word is one argument even if it matches a file', () => {
    const d = dispatch('release --tag v*');
    writeFileSync(join(d.dir, 'v-decoy'), '');
    expect(dispatch('release --tag v*').argv).toEqual(['release', '--tag', 'v*']);
  });
});

describe('no frozen run: script interpolates an expression ([R153])', () => {
  /** Every `run:` in the frozen surface, with the file and step that carries it. */
  function runScripts(): Array<{ where: string; script: string }> {
    const files = [
      ...readdirSync(join(SHIM, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      '.github/actions/engine/action.yml',
    ];
    const out: Array<{ where: string; script: string }> = [];
    for (const file of files) {
      const doc = parseDocument(readFileSync(join(SHIM, file), 'utf8')).toJS() as {
        runs?: { steps: Array<Record<string, string>> };
        jobs?: Record<string, { steps: Array<Record<string, string>> }>;
      };
      const steps = doc.runs
        ? doc.runs.steps
        : Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
      for (const s of steps)
        if (s.run) out.push({ where: `${file}: ${s.id ?? s.name ?? '(unnamed)'}`, script: s.run });
    }
    return out;
  }

  it('every value a script reads arrives through env:, so none can be spliced', () => {
    const spliced = runScripts().filter((s) => s.script.includes('${{'));
    expect(spliced.map((s) => s.where)).toEqual([]);
  });

  it('finds the scripts it claims to check', () => {
    expect(runScripts().length).toBeGreaterThan(5);
  });
});
