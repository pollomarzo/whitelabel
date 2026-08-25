/**
 * no-node-modules.test.ts — the guard that keeps `npx oaktree-sapling` a download, not an install.
 *
 * `dist/cli.cjs` is an esbuild bundle that inlines every runtime dependency ([R51]), so the
 * published package declares NO `dependencies`: npx fetches the tarball and runs it, with no
 * `node_modules` anywhere. That is the whole reason a cold `npx` is seconds instead of the two
 * minutes it took while myst-cli and friends were still declared as production deps.
 *
 * The failure this exists to catch is silent and one-directional. Nothing in a type check, a
 * unit suite, or the other bundle-driven suites notices a `require` that esbuild left external
 * — every one of them runs from inside the engine checkout, where the repo's own `node_modules`
 * (installed for the dev toolchain) satisfies the stray require and the run goes green. Only a
 * user on a clean machine, or a paper's CI, hits the `MODULE_NOT_FOUND`. So this suite stages
 * the package the way npm publishes it, somewhere the module resolver cannot walk up into any
 * `node_modules` at all, and drives a verb that pulls in the heaviest inlined dependency.
 *
 * `validate` is that verb deliberately: it boots a real myst-cli session and runs the Curvenote
 * check implementations over the fixture paper. `--help` would pass against a hollow bundle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleState, assertBundleNotStale } from './bundle-state.js';

const engineDir = fileURLToPath(new URL('..', import.meta.url));
const fixturePaper = join(engineDir, 'test', 'fixture-paper');
const fixtureInstance = join(engineDir, 'test', 'fixture-instance');

/** Every ancestor of `dir`, innermost first — the exact chain node's resolver walks. */
function ancestors(dir: string): string[] {
  const chain: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    chain.push(d);
    if (d === parse(d).root) return chain;
  }
}

/**
 * Stage the published package: the `files` entries from package.json, copied into a fresh temp
 * dir. `engineRoot()` finds its assets by walking up from the bundle for `paper-base.yml`, so
 * the layout — not just the bundle — has to be the real one.
 */
function stagePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oak-nonodemod-'));
  const pkg = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'));
  for (const entry of pkg.files as string[]) {
    if (entry.startsWith('!')) continue; // a publish-time exclusion; irrelevant at runtime
    const rel = entry.replace(/\/$/, '');
    const from = join(engineDir, rel);
    if (existsSync(from)) cpSync(from, join(dir, rel), { recursive: true });
  }
  cpSync(fixturePaper, join(dir, 'paper'), { recursive: true });
  // The instance rides along because it is what SELECTS the Layer-B checks: `--no-instance`
  // validates to an empty check list, which would pass against a bundle that never loaded them.
  cpSync(fixtureInstance, join(dir, 'instance'), { recursive: true });
  return dir;
}

describe.skipIf(bundleState() === 'absent')('the bundle runs with no node_modules', () => {
  let dir: string;
  beforeAll(() => {
    assertBundleNotStale();
    dir = stagePackage();
  });

  it('stages somewhere the resolver cannot reach a node_modules', () => {
    // If this ever fails the suite below is worthless — it would be proving nothing, because a
    // stray require would resolve from up the tree exactly as it does inside the repo.
    const reachable = ancestors(dir).filter((d) => existsSync(join(d, 'node_modules')));
    expect(
      reachable,
      `temp dir ${dir} sits under a node_modules; this guard cannot work from here`,
    ).toEqual([]);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  });

  it('runs `validate` end to end — myst-cli session, Curvenote checks, exit 0', () => {
    const r = spawnSync(
      'node',
      [
        join(dir, 'dist', 'cli.cjs'), 'validate',
        '--paper', join(dir, 'paper'),
        '--instance', join(dir, 'instance'),
        '--repo', 'open-scholar-nexus/fixture-sample-paper',
        '--json',
      ],
      // NODE_PATH would hand the resolver a directory outside the walk-up chain, which is the
      // one way the check above can be true and the guard still be fooled.
      { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
    );
    const stderr = r.stderr ?? '';
    expect(stderr).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/);
    expect(r.status, `exit ${r.status}\n${stderr}`).toBe(0);
    // Proof myst-cli itself was inlined and ran, rather than the CLI short-circuiting.
    expect(stderr).toMatch(/building myst-cli session/);
    const out = JSON.parse(r.stdout ?? '');
    expect(out.status).toBe('ok');
    // The Curvenote check implementations read the processed mdast, so a non-empty all-passing
    // list is proof the whole myst pipeline ran inside the bundle.
    expect(out.checks.length).toBeGreaterThan(0);
    expect(out.checks.every((c: { status: string }) => c.status === 'pass')).toBe(true);
  }, 180_000);
});
