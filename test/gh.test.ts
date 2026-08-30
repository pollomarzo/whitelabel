/**
 * gh.ts had no test file at all before Pass A. These cover the findings P3 raised, on the
 * principle taken from [R90]: a guard added in response to a finding ships with a demonstration
 * that it rejects that finding's own input.
 *
 * The seam functions here are pure or shell out, so what is asserted is the argument VECTOR and
 * the validation, which is where three of the four defects actually lived.
 */
import { describe, expect, it } from 'vitest';
import { assertIngestSource, labelChildOutput } from '../src/gh.js';
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

  // The demonstrated exploit: `git fetch <url> --upload-pack=<cmd>` RUNS <cmd>, because git
  // parses options positionally. Verified against real git before this guard was written.
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

  // --from is copied verbatim into a public commit message and PR body, so a credentialed URL
  // would be published. Refused rather than silently rewritten.
  it('refuses a URL carrying credentials', () => {
    expect(() => assertIngestSource('https://user:tok@github.com/o/r', 'main')).toThrow(UserError);
  });

  it('refuses a ref that could climb out of the ref namespace', () => {
    expect(() => assertIngestSource('https://github.com/o/r', '../../etc/passwd')).toThrow(
      UserError,
    );
  });

  it('is a UserError, so it reaches the editor as a sentence and not a stack', () => {
    // cli.ts prints UserError.message and exits 2; anything else is engineCrash with a stack.
    try {
      assertIngestSource('ext::sh -c id', 'main');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as Error).message).toContain('--from');
    }
  });
});

/**
 * Source lints, the idiom release-resolution.test.ts established for a ledger rule whose naive
 * form must not come back. These paths shell out or need a live token, so the argument vector is
 * the honest thing to assert.
 */
describe('gh.ts argument vectors', () => {
  it('never passes a secret value in argv', () => {
    const src = SRC('gh.ts');
    const setSecret = /setSecret\([^)]*\)\s*\{([\s\S]*?)\n  \},/.exec(src);
    expect(setSecret, 'setSecret not found; this lint needs updating').toBeTruthy();
    // `--body <value>` puts the token in /proc/<pid>/cmdline. It must go through stdin.
    expect(codeOnly(setSecret![1])).not.toContain('--body');
    expect(codeOnly(setSecret![1])).toContain('input:');
  });

  it('does not put a captured child stderr into the preview comment', () => {
    // Node concatenates a captured child's stderr into the thrown error's message, and
    // preview.ts posts that message publicly. wrangler names the API path it called, which
    // carries the Cloudflare account id, so its stderr must be inherited, not captured.
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
});

describe('labelChildOutput', () => {
  it('names the tool on every line and drops blanks', () => {
    expect(labelChildOutput('git', 'a\n\nb')).toBe('  [git] a\n  [git] b');
  });
});
