/**
 * gh.ts shells out, so what these assert is the argument VECTOR: the secret that must not be in
 * argv, the stderr that must not be captured, the validation that must precede `git fetch`.
 * [R103], [R104], [R105].
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertIngestSource,
  changedFiles,
  labelChildOutput,
  openDoiPr,
  realConformanceGh,
  realGhPr,
  realPagesDeployer,
  realProvisioner,
} from '../src/gh.js';
import { UserError } from '../src/messages.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = (f: string) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8');

/** Comments explain the rule and so quote the thing it forbids. Lint the code, not the prose. */
const codeOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

describe('assertIngestSource', () => {
  it('accepts the shapes an editor actually pastes', () => {
    for (const url of [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo/',
      'git@github.com:owner/repo.git',
      'https://github.com/some-org/paper_2026.v2',
    ]) {
      expect(() => assertIngestSource(url, 'main')).not.toThrow();
    }
    for (const ref of ['main', 'v1.0.0', 'feature/thing', 'a1b2c3d4', 'release_2026']) {
      expect(() => assertIngestSource('https://github.com/o/r', ref)).not.toThrow();
    }
  });

  it('refuses a ref that git would read as an option', () => {
    expect(() =>
      assertIngestSource('https://github.com/o/r', '--upload-pack=touch /tmp/pwned'),
    ).toThrow(UserError);
    expect(() => assertIngestSource('https://github.com/o/r', '-o')).toThrow(UserError);
  });

  it('refuses ext:: and other transports that spell the same thing', () => {
    for (const url of [
      'ext::sh -c "touch /tmp/pwned"',
      'file:///tmp/evil',
      'ssh://evil.example/repo',
      'https://evil.example/owner/repo',
      '--upload-pack=id',
    ]) {
      expect(() => assertIngestSource(url, 'main')).toThrow(UserError);
    }
  });

  it('refuses a URL carrying credentials', () => {
    expect(() => assertIngestSource('https://user:tok@github.com/o/r', 'main')).toThrow(UserError);
  });

  it('refuses a ref that could climb out of the ref namespace', () => {
    expect(() => assertIngestSource('https://github.com/o/r', '../../etc/passwd')).toThrow(
      UserError,
    );
  });

  it('is a UserError, so it reaches the editor as a sentence and not a stack', () => {
    try {
      assertIngestSource('ext::sh -c id', 'main');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as Error).message).toContain('--from');
    }
  });
});

/** Source lints (the release-resolution.test.ts idiom): these paths need a live token to run. */
describe('gh.ts argument vectors', () => {
  it('never passes a secret value in argv', () => {
    const src = SRC('gh.ts');
    const setSecret = /setSecret\([^)]*\)\s*\{([\s\S]*?)\n  \},/.exec(src);
    expect(setSecret, 'setSecret not found; this lint needs updating').toBeTruthy();
    expect(codeOnly(setSecret![1])).not.toContain('--body');
    expect(codeOnly(setSecret![1])).toContain('input:');
  });

  it('does not put a captured child stderr into the preview comment', () => {
    const deploy = /deploy\(opts\)\s*\{([\s\S]*?)\n  \},/.exec(SRC('gh.ts'));
    expect(deploy, 'realPagesDeployer.deploy not found').toBeTruthy();
    expect(codeOnly(deploy![1])).toContain("stdio: ['ignore', 'pipe', 'inherit']");
  });

  it('validates the ingest source before git sees it', () => {
    const src = SRC('gh.ts');
    const fetchLine = src.indexOf("gitRaw(['fetch', opts.sourceUrl, opts.sourceRef]");
    const guardLine = src.indexOf('assertIngestSource(opts.sourceUrl, opts.sourceRef)');
    expect(guardLine).toBeGreaterThan(-1);
    expect(fetchLine).toBeGreaterThan(-1);
    expect(guardLine).toBeLessThan(fetchLine);
  });

  it('a versionTags API failure propagates instead of reading as "no tags"', () => {
    // [] would read as "never published" ([R108]).
    const vt = /versionTags\([^)]*\)\s*\{([\s\S]*?)\n  \},/.exec(SRC('gh.ts'));
    expect(vt, 'versionTags not found; this lint needs updating').toBeTruthy();
    expect(codeOnly(vt![1])).not.toMatch(/\bcatch\b/);
  });
});

describe('labelChildOutput', () => {
  it('names the tool on every line and drops blanks', () => {
    expect(labelChildOutput('git', 'a\n\nb')).toBe('  [git] a\n  [git] b');
  });
});

describe('ingest restores the editor-side .github ([R121])', () => {
  it('deletes before restoring, so an author-only path cannot survive', () => {
    // `git checkout <tree> -- .github` overwrites the paths that tree HAS and leaves the rest,
    // so an author workflow at a path main lacks reached a branch pushed to the base repo.
    const src = SRC('gh.ts');
    const del = src.indexOf("'rm', '-rqf', '--ignore-unmatch', '--', '.github'");
    const restore = src.indexOf("'checkout', 'origin/main', '--', '.github'");
    expect(del, 'no delete before the restore').toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(-1);
    expect(del).toBeLessThan(restore);
  });
});

/* --------------------------------------------------------------------------
 * The argument vectors the effects actually build, with `git`/`gh` replaced ([R108], [R109]).
 * ------------------------------------------------------------------------ */

const child = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: string[] }>,
  respond: (_args: string[]) => ({ status: 0, stdout: '', stderr: '' }),
}));

vi.mock('node:child_process', () => {
  const call = (tool: string, args: string[]) => {
    child.calls.push({ tool, args });
    const r = child.respond(args);
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return {
    spawnSync: (tool: string, args: string[]) => call(tool, args),
    execFileSync: (tool: string, args: string[]) => {
      const r = call(tool, args);
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    },
  };
});

/** The recorded `gh` invocation whose first two arguments are `first`/`second`. */
const ghCall = (first: string, second?: string) =>
  child.calls.find(
    (c) => c.tool === 'gh' && c.args[0] === first && (second === undefined || c.args[1] === second),
  );

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('openDoiPr ([R108])', () => {
  /** Everything the happy path shells out for; `over` replaces one answer. */
  const answers =
    (over: (args: string[]) => { status: number; stdout?: string; stderr?: string } | null) =>
    (args: string[]) => {
      const custom = over(args);
      if (custom)
        return { status: custom.status, stdout: custom.stdout ?? '', stderr: custom.stderr ?? '' };
      if (args.includes('get-url'))
        return { status: 0, stdout: 'https://github.com/o/r.git', stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: 'main', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'create')
        return { status: 0, stdout: 'https://github.com/o/r/pull/7', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

  beforeEach(() => {
    child.calls.length = 0;
    child.respond = answers(() => null);
  });

  it('names the paper repo, since its git calls are -C and gh reads the cwd', () => {
    openDoiPr('/elsewhere/paper', { conceptDoi: '10.5072/zenodo.5' });
    expect(argAfter(ghCall('pr', 'create')!.args, '--repo')).toBe('o/r');
  });

  it('targets the default branch', () => {
    openDoiPr('/elsewhere/paper', { conceptDoi: '10.5072/zenodo.5' });
    expect(argAfter(ghCall('pr', 'create')!.args, '--base')).toBe('main');
  });

  it('refuses when HEAD carries commits the base does not', () => {
    child.respond = answers((args) =>
      args.includes('merge-base') ? { status: 1, stderr: '' } : null,
    );
    expect(() => openDoiPr('/paper', { conceptDoi: '10.5072/zenodo.5' })).toThrow(UserError);
    expect(ghCall('pr', 'create'), 'no PR is opened from a diverged HEAD').toBeUndefined();
  });

  it('is idempotent: a second prepare returns the PR the first one opened', () => {
    child.respond = answers((args) => {
      if (args[0] === 'pr' && args[1] === 'create')
        return { status: 1, stderr: 'a pull request for branch "zenodo-doi" already exists' };
      if (args[0] === 'pr' && args[1] === 'list')
        return { status: 0, stdout: 'https://github.com/o/r/pull/7' };
      return null;
    });
    expect(openDoiPr('/paper', { conceptDoi: '10.5072/zenodo.5' })).toBe(
      'https://github.com/o/r/pull/7',
    );
  });
});

describe('the tolerant probes tell absent from forbidden ([R108], [R113])', () => {
  beforeEach(() => {
    child.calls.length = 0;
  });

  it('treats a 404 DELETE as already gone', () => {
    child.respond = () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
    expect(() => realConformanceGh.deleteBranch('o/r', 'cert-1')).not.toThrow();
  });

  it('refuses to report a teardown a 403 prevented', () => {
    child.respond = () => ({ status: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)' });
    expect(() => realConformanceGh.deleteBranch('o/r', 'cert-1')).toThrow(/403/);
  });

  it('treats an absent TAG as already gone, which the refs API spells 422 ([R149])', () => {
    // Not 404: `DELETE /git/refs/tags/x` on a missing ref answers 422 "Reference does not
    // exist". Every cert deletes a possibly-absent deposit tag before pushing it.
    child.respond = () => ({
      status: 1,
      stdout: '',
      stderr: 'gh: Reference does not exist (HTTP 422)',
    });
    expect(() => realConformanceGh.deleteTag('o/r', 'v9.9.9')).not.toThrow();
  });

  it('still refuses a 422 that is NOT an absent ref', () => {
    child.respond = () => ({ status: 1, stdout: '', stderr: 'gh: Validation failed (HTTP 422)' });
    expect(() => realConformanceGh.deleteTag('o/r', 'v9.9.9')).toThrow(/422/);
  });

  it('approving an UNGATED run is a no-op, which GitHub spells 403 ([R150])', () => {
    // The load-bearing case: live testing settled that fork runs are not gated every time, so
    // this is the normal path, not the exception.
    child.respond = () => ({
      status: 1,
      stdout: '',
      stderr: 'gh: This workflow run is not waiting for approval (HTTP 403)',
    });
    expect(() => realConformanceGh.approveWorkflowRun('o/r', 9)).not.toThrow();
  });

  it('but a 403 that is NOT about gating still throws', () => {
    child.respond = () => ({
      status: 1,
      stdout: '',
      stderr: 'gh: Resource not accessible by integration (HTTP 403)',
    });
    expect(() => realConformanceGh.approveWorkflowRun('o/r', 9)).toThrow(/403/);
  });

  it('every ref delete tolerates it, not just the one that failed a cert ([R149])', () => {
    child.respond = () => ({
      status: 1,
      stdout: '',
      stderr: 'gh: Reference does not exist (HTTP 422)',
    });
    expect(() => realConformanceGh.deleteBranch('o/r', 'cert-1')).not.toThrow();
    expect(() => realConformanceGh.deleteForkBranch('f/r', 't', 'cert-1')).not.toThrow();
  });
});

describe('list endpoints paginate ([R108])', () => {
  beforeEach(() => {
    child.calls.length = 0;
    child.respond = () => ({ status: 0, stdout: '', stderr: '' });
  });

  it('the compare behind the frozen-shim advisory', () => {
    changedFiles('o/r', 'base', 'head');
    expect(ghCall('api')!.args).toContain('--paginate');
  });

  it('the ruleset lookup', () => {
    realProvisioner.rulesetExists('o/r', 'protect-main');
    expect(ghCall('api')!.args).toContain('--paginate');
  });

  it('the cert branch listing', () => {
    realConformanceGh.listBranches('o/r', 'cert-');
    expect(ghCall('api')!.args).toContain('--paginate');
  });
});

describe('realGhPr.sticky ([R108])', () => {
  it('throws rather than report a comment it did not post', () => {
    child.calls.length = 0;
    child.respond = () => ({ status: 1, stdout: '', stderr: 'fatal: no such remote' });
    expect(() => realGhPr.sticky('.', '3', 'header', 'body')).toThrow();
  });
});

describe('the preview deploy pins wrangler ([R109])', () => {
  it('runs a pinned version, not whatever npm serves into a token-bearing process', async () => {
    child.calls.length = 0;
    child.respond = () => ({ status: 0, stdout: 'https://abc.pages.dev', stderr: '' });
    await realPagesDeployer.deploy({
      dir: '_build/site',
      projectName: 'p',
      branch: 'b',
      apiToken: 't',
      accountId: 'a',
    });
    const npx = child.calls.find((c) => c.tool === 'npx')!;
    expect(npx.args.some((a) => /^wrangler@\d+\.\d+\.\d+$/.test(a))).toBe(true);
    expect(npx.args, 'a floating wrangler is not pinned').not.toContain('wrangler');
  });
});

describe('realProvisioner.createLabel ([R127])', () => {
  it('does not swallow a refusal, since --force already covers the label existing', () => {
    child.calls.length = 0;
    child.respond = () => ({ status: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)' });
    expect(() =>
      realProvisioner.createLabel('o/r', 'editor-action-needed', { color: 'b60205' }),
    ).toThrow();
    expect(ghCall('label', 'create')!.args, 'the create is idempotent on its own').toContain(
      '--force',
    );
  });
});
