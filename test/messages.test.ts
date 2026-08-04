/**
 * messages.test.ts — the guard that keeps `src/messages.ts` worth reviewing.
 *
 * The user reviews the wording in ONE file; that only stays true if new prose cannot quietly
 * appear beside the code that prints it. So this suite scans the tenant-facing modules for a
 * string literal being handed straight to an output sink (a `write`/`log` call, or a `message:`
 * / `error:` / `reason:` field of a result) and fails on any it finds.
 *
 * It is a lint, not a proof: a message assembled from variables slips through. It catches the
 * common case — someone adding `log('  ✓ done')` — which is exactly how the catalog would rot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

/**
 * The modules whose output a tenant or author reads. `conformance.ts` (the maintainer's release
 * harness) and `zenodo.ts` (progress markers + the Zenodo API's own error bodies) are out by the
 * same decision recorded in the messages.ts header.
 */
const COVERED = [
  'cli.ts',
  'bootstrap.ts',
  'upgrade.ts',
  'build.ts',
  'validate.ts',
  'checks.ts',
  'preview.ts',
  'schema.ts',
  'compose.ts',
  'gh.ts',
  'yaml-io.ts',
];

/** A sink that puts its argument in front of a person. */
const SINKS = /(?:stderr\.write|stdout\.write|\blog|\bwarn|\bemit)\(\s*(['"`])|(?:message|error|reason|title|body|description)\s*:\s*(['"`])/g;

/** Prose = a literal with whitespace in it. `'main'`, `'ok'`, `'v*'` are identifiers. */
function isProse(quote: string, rest: string): boolean {
  const end = rest.indexOf(quote);
  const literal = end === -1 ? rest : rest.slice(0, end);
  return /\S\s+\S/.test(literal) && literal.length > 12;
}

/** Literals that are NOT prose for a reader, with the reason each is allowed to stay. */
const ALLOWED = [
  // an engine fault only reachable when the engine's own package.json is broken
  'bootstrap: engine package.json declares no myst-cli dependency',
];

describe('every tenant-facing string lives in messages.ts', () => {
  for (const file of COVERED) {
    it(`${file} hands no prose literal straight to an output sink`, () => {
      const src = readFileSync(join(srcDir, file), 'utf8');
      const offenders: string[] = [];
      for (const m of src.matchAll(SINKS)) {
        const quote = m[1] ?? m[2]!;
        const rest = src.slice(m.index! + m[0].length);
        if (!isProse(quote, rest)) continue;
        const literal = rest.slice(0, rest.indexOf(quote));
        if (ALLOWED.some((a) => literal.includes(a))) continue;
        offenders.push(literal.slice(0, 80));
      }
      expect(offenders, `move these into src/messages.ts:\n  ${offenders.join('\n  ')}`).toEqual([]);
    });
  }

  it('messages.ts itself points at the surfaces it cannot hold', () => {
    // The review is only complete if the file says where the rest of the words are.
    const src = readFileSync(join(srcDir, 'messages.ts'), 'utf8');
    for (const pointer of ['templates/paper/README.md', 'templates/instance/journal.yml', 'plugins/gallery.mjs']) {
      expect(src).toContain(pointer);
    }
  });
});
