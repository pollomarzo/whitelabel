/**
 * Remove the temp dirs the suite creates ([R152]).
 *
 * 63 `mkdtempSync` call sites across 13 files, none of which clean up, so a working session
 * accumulated 27,410 dirs and filled a 14G tmpfs; node then fails writes with EDQUOT and dozens
 * of unrelated tests go red. The cost is not the space, it is that a red suite stops being
 * signal. One teardown here beats 63 edits and cannot be forgotten at a new call site.
 *
 * Only dirs modified since the run started, so a concurrent session's dirs survive.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIXES = ['oak-', 'oaktree-'];
let startedAt = 0;

export function setup(): void {
  startedAt = Date.now();
}

export function teardown(): void {
  const dir = tmpdir();
  for (const name of readdirSync(dir)) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue;
    const abs = join(dir, name);
    try {
      if (statSync(abs).mtimeMs >= startedAt) rmSync(abs, { recursive: true, force: true });
    } catch {
      /* raced with another process, or not ours to remove */
    }
  }
}
