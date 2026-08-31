/**
 * gh.ts shells out, so what these assert is the argument VECTOR: the secret that must not be in
 * argv, the stderr that must not be captured, the validation that must precede `git fetch`.
 * [R103], [R104], [R105].
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
});

describe('labelChildOutput', () => {
  it('names the tool on every line and drops blanks', () => {
    expect(labelChildOutput('git', 'a\n\nb')).toBe('  [git] a\n  [git] b');
  });
});
