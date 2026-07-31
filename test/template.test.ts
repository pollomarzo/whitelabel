/**
 * template.test.ts — the disjointness invariant for the split template trees.
 *
 * `templates/paper/`, `templates/instance/` and `templates/site/` are independent source
 * trees, and two of the three bootstrap tiers stamp a UNION of two of them into the SAME
 * repo root, back to back. A single flattened tree forbade same-path collisions by
 * construction; the split re-admits the possibility.
 *
 * NOT "all roots are disjoint" — only the pairs that are actually unioned:
 *
 *   paper ⊎ instance   `oak bootstrap journal --co-located`
 *   site  ⊎ instance   `oak bootstrap journal --external` ([S8] variant A′)
 *
 * `site` vs `paper` is deliberately UNCHECKED: they are never stamped together (the
 * co-located tier gets no site — repo=journal's index is the deferred `assemble()` work,
 * [S7]), and both legitimately own a root `myst.yml` and a `.gitignore`.
 *
 * If a future file legitimately belongs to both roles of a checked pair, this assertion
 * fails loudly and forces a deliberate precedence decision AT THAT MOMENT — rather than a
 * silent overwrite whose winner depends on render order. That is the whole point: the
 * invariant replaces a standing `PAPER_EXCLUDE`-style policy list.
 */
import { describe, it, expect } from 'vitest';
import { stampedFiles } from '../src/bootstrap.js';

const PAPER_ROOT = 'templates/paper';
const INSTANCE_ROOT = 'templates/instance';
const SITE_ROOT = 'templates/site';

const overlap = (a: string, b: string) => {
  const first = new Set(stampedFiles(a));
  return stampedFiles(b).filter((rel) => first.has(rel));
};

describe('template disjointness invariant', () => {
  it('--co-located: the paper and instance stamps write disjoint root-relative paths', () => {
    expect(overlap(PAPER_ROOT, INSTANCE_ROOT)).toEqual([]);
  });

  it('--external: the site and instance stamps write disjoint root-relative paths', () => {
    expect(overlap(SITE_ROOT, INSTANCE_ROOT)).toEqual([]);
  });
});
