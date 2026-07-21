/**
 * bundle-state.ts — shared guard for the suites that drive the REAL bundle (`dist/cli.cjs`).
 *
 * Both integration suites exercise the bundled artifact rather than importing myst-cli
 * in-process ([R51]). That creates two distinct hazards, which must NOT be treated the same:
 *
 *   - **absent** → SKIP. `dist/cli.cjs` is gitignored, so a fresh clone has none. Skipping keeps
 *     the default `npm test` portable (the property the suite headers and test.yml rely on).
 *   - **stale** → FAIL. A bundle older than the newest `src/**` silently exercises OLD code, so
 *     the suite reports green on changes it never ran. This is not hypothetical: it hid the
 *     export-path change during the [R71] refactor until a manual rebundle.
 *
 * `npm test` bundles first, so the common path is always fresh; this guard covers the paths
 * that do not (`npm run test:watch`, a bare `vitest`, an editor runner).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('..', import.meta.url));
export const bundlePath = join(engineDir, 'dist', 'cli.cjs');

/** Newest mtime under src/ (recursive). */
function newestSourceMtime(): number {
  const srcDir = join(engineDir, 'src');
  if (!existsSync(srcDir)) return 0;
  return readdirSync(srcDir, { recursive: true })
    .map(String)
    .map((f) => join(srcDir, f))
    .filter((f) => f.endsWith('.ts') && existsSync(f))
    .reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
}

export type BundleState = 'absent' | 'stale' | 'fresh';

export function bundleState(): BundleState {
  if (!existsSync(bundlePath)) return 'absent';
  return statSync(bundlePath).mtimeMs < newestSourceMtime() ? 'stale' : 'fresh';
}

/**
 * Throw when the bundle is stale. Call from a `beforeAll` in bundle-driven suites: a stale
 * bundle must be a loud failure, never a silent pass against old code.
 */
export function assertBundleNotStale(): void {
  if (bundleState() === 'stale') {
    throw new Error(
      `dist/cli.cjs is OLDER than src/ — this suite would exercise stale code and pass.\n` +
        `Run \`npm run bundle\` (\`npm test\` does it for you; \`test:watch\` does not).`,
    );
  }
}
