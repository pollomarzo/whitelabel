/**
 * release-resolution.test.ts: the guard on which engine tag a tenant gets by default.
 *
 * Two callers resolve "the newest engine release" for somebody: `oak bootstrap` when no
 * `--engine-version` is given, and the scheduled `oak upgrade --version-only` that floats a
 * paper's pin. Both write the answer into a tenant's repo, so picking the wrong tag is not a
 * cosmetic bug: it is a pin on a tag `RELEASING.md` says will be DELETED during pruning.
 *
 * `gh release list --limit 1` sorts by date and includes pre-releases, so it returned every dev
 * cut. `repos/<repo>/releases/latest` is GitHub's own "newest non-draft, non-prerelease", which
 * is the invariant RELEASING.md already claims ("marked pre-release, so `version: latest` never
 * resolves to one"). The first assertion pins the resolver to that endpoint.
 *
 * It is a lint, not a proof: the same trade `messages.test.ts` makes. Driving the real resolver
 * would need a network call and a repo whose release mix we control, and neither belongs in the
 * unit suite. What it does catch is the specific regression: someone reaching for the
 * list-and-take-the-first form again because it reads as the obvious way to ask.
 *
 * The second assertion covers the failure this change introduces. A repo can now have many
 * releases and still resolve nothing, so the message a tenant hits must not say "no releases":
 * they are looking at a page full of them, and must name the flag that reaches a pre-release.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as msg from '../src/messages.js';

const srcDir = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

/** The body of `latestEngineRelease`, from its signature to the closing brace. */
function resolverBody(): string {
  const src = readFileSync(join(srcDir, 'gh.ts'), 'utf8');
  const start = src.indexOf('export function latestEngineRelease');
  expect(start, 'latestEngineRelease has been renamed or removed').toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end);
}

describe('the default engine tag a tenant is given', () => {
  it('resolves through releases/latest, which excludes pre-releases', () => {
    const body = resolverBody();
    expect(body).toContain('releases/latest');
  });

  it('never resolves by taking the first of a date-sorted release list', () => {
    // The exact shape of the bug: `gh release list --limit 1` happily returns a dev tag.
    const body = resolverBody();
    expect(body).not.toMatch(/'release',\s*'list'/);
    expect(body).not.toContain('--limit');
  });

  it('tells a tenant with only pre-releases how to name one', () => {
    // "no releases" would be a lie they can see through, and a dead end either way.
    for (const m of [msg.workflow.noStableRelease('me/engine'), msg.workflow.bootstrapNoRelease]) {
      expect(m).not.toMatch(/no releases found/);
      expect(m).toMatch(/pre-release/);
      expect(m).toMatch(/--to <tag>|--engine-version <tag>/);
    }
  });
});
