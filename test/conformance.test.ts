/**
 * conformance.test.ts — `oak conformance` orchestration through a FAKE `ConformanceGh` seam
 * (no gh/git). Slice C0: `reset` closes labelled PRs + deletes `cert-*` branches + `*-cert-*`
 * tags, is idempotent (a second run is a no-op), and leaves unrelated refs untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  cmdConformanceReset,
  CONFORMANCE_LABEL,
  CERT_BRANCH_PREFIX,
  CERT_TAG_MARKER,
  type ConformanceGh,
} from '../src/conformance.js';

const REPO = 'me/fixture-paper-repo';

/** In-memory fixture repo: labelled PRs, branches, tags. Mirrors the real seam's semantics
 *  (listBranches is prefix-filtered; listTags is marker-filtered; deletes tolerate absence). */
function fakeGh(init: {
  prs?: { number: number; headRef: string; label?: string }[];
  branches?: string[];
  tags?: string[];
}): ConformanceGh & { prs: typeof prs; branches: string[]; tags: string[] } {
  const prs = (init.prs ?? []).map((p) => ({ ...p, open: true }));
  let branches = [...(init.branches ?? [])];
  let tags = [...(init.tags ?? [])];
  return {
    prs,
    get branches() {
      return branches;
    },
    get tags() {
      return tags;
    },
    listOpenPrs(_repo, label) {
      return prs.filter((p) => p.open && p.label === label).map((p) => ({ number: p.number, headRef: p.headRef }));
    },
    closePr(_repo, prNumber) {
      const pr = prs.find((p) => p.number === prNumber);
      if (pr) pr.open = false;
    },
    listBranches(_repo, prefix) {
      return branches.filter((b) => b.startsWith(prefix));
    },
    deleteBranch(_repo, branch) {
      branches = branches.filter((b) => b !== branch);
    },
    listTags(_repo, marker) {
      return tags.filter((t) => t.includes(marker));
    },
    deleteTag(_repo, tag) {
      tags = tags.filter((t) => t !== tag);
    },
  };
}

const silentDeps = (gh: ConformanceGh) => ({ gh, log: () => {} });

describe('cmdConformanceReset', () => {
  it('closes labelled PRs, deletes cert-* branches and *-cert-* tags; leaves the rest', async () => {
    const gh = fakeGh({
      prs: [
        { number: 1, headRef: `${CERT_BRANCH_PREFIX}101`, label: CONFORMANCE_LABEL },
        { number: 2, headRef: 'secondacct:conformance-fork', label: CONFORMANCE_LABEL }, // fork PR, non-cert head
        { number: 3, headRef: 'feature/unrelated' }, // no label — an author PR, must survive
      ],
      branches: [`${CERT_BRANCH_PREFIX}101`, `${CERT_BRANCH_PREFIX}102`, 'main', 'gh-pages'],
      tags: [`v0.0.0${CERT_TAG_MARKER}101`, 'v0.0.1', 'v0.0.2'],
    });

    const out = await cmdConformanceReset({ repo: REPO }, silentDeps(gh));

    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({
      status: 'ok',
      repo: REPO,
      closedPrs: [1, 2],
      deletedBranches: [`${CERT_BRANCH_PREFIX}101`, `${CERT_BRANCH_PREFIX}102`],
      deletedTags: [`v0.0.0${CERT_TAG_MARKER}101`],
      changed: 5,
    });

    // the unlabelled author PR stays open; main/gh-pages + real release tags survive
    expect(gh.prs.find((p) => p.number === 3)!.open).toBe(true);
    expect(gh.branches).toEqual(['main', 'gh-pages']);
    expect(gh.tags).toEqual(['v0.0.1', 'v0.0.2']);
  });

  it('is idempotent — a second reset is a no-op with changed: 0', async () => {
    const gh = fakeGh({
      prs: [{ number: 1, headRef: `${CERT_BRANCH_PREFIX}101`, label: CONFORMANCE_LABEL }],
      branches: [`${CERT_BRANCH_PREFIX}101`],
      tags: [`v0.0.0${CERT_TAG_MARKER}101`],
    });

    const first = await cmdConformanceReset({ repo: REPO }, silentDeps(gh));
    expect(first.result.changed).toBe(3); // 1 pr + 1 branch + 1 tag

    const second = await cmdConformanceReset({ repo: REPO }, silentDeps(gh));
    expect(second.result).toMatchObject({ closedPrs: [], deletedBranches: [], deletedTags: [], changed: 0 });
  });

  it('reset on an already-clean fixture is a no-op', async () => {
    const gh = fakeGh({ branches: ['main'], tags: ['v0.0.1'] });
    const out = await cmdConformanceReset({ repo: REPO }, silentDeps(gh));
    expect(out.result.changed).toBe(0);
    expect(gh.branches).toEqual(['main']);
    expect(gh.tags).toEqual(['v0.0.1']);
  });
});
