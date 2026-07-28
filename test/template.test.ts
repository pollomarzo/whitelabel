/**
 * template.test.ts — the disjointness invariant for the split template trees.
 *
 * `templates/paper/` and `templates/instance/` are two independent source trees that the
 * co-located journal tier (`oak bootstrap journal --co-located`) stamps into the SAME repo
 * root, back to back. A single flattened tree forbade same-path collisions by construction; the
 * split re-admits the possibility. Today there is zero overlap — this test keeps it that way.
 *
 * If a future file legitimately belongs to both roles (a `.gitignore`, a top-level script),
 * this assertion fails loudly and forces a deliberate precedence decision AT THAT MOMENT —
 * rather than a silent overwrite whose winner depends on render order. That is the whole point:
 * the invariant replaces a standing `PAPER_EXCLUDE`-style policy list.
 */
import { describe, it, expect } from 'vitest';
import { stampedFiles } from '../src/bootstrap.js';

const PAPER_ROOT = 'templates/paper';
const INSTANCE_ROOT = 'templates/instance';

describe('template disjointness invariant', () => {
  it('the paper and instance stamps write disjoint root-relative paths', () => {
    const paper = new Set(stampedFiles(PAPER_ROOT));
    const shared = stampedFiles(INSTANCE_ROOT).filter((rel) => paper.has(rel));
    expect(shared).toEqual([]);
  });
});
