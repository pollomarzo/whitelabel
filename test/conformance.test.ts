/**
 * conformance.test.ts — `oak conformance` orchestration through a FAKE `ConformanceGh` seam
 * (no gh/git). Slice C0: `reset` closes labelled PRs + deletes `cert-*` branches + `*-cert-*`
 * tags, is idempotent (a second run is a no-op), and leaves unrelated refs untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  cmdConformanceReset,
  cmdConformanceCertify,
  pagesUrlFor,
  CONFORMANCE_LABEL,
  CERT_BRANCH_PREFIX,
  CERT_TAG_MARKER,
  CERT_DEPOSIT_TAG,
  type ConformanceGh,
  type ConformanceDeps,
  type WorkflowRun,
  type CheckRunRef,
} from '../src/conformance.js';
import { RESERVED_BUNDLE_NAMES } from '../src/zenodo.js';

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
    deleteRelease(_repo, tag) {
      // `--cleanup-tag` semantics: dropping the Release also drops the tag.
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

  it('cleans a stranded reserved deposit tag (no -cert- marker) and leaves real release tags', async () => {
    const gh = fakeGh({ tags: [CERT_DEPOSIT_TAG, 'v0.0.1', 'v0.0.2'] });
    const out = await cmdConformanceReset({ repo: REPO }, silentDeps(gh));
    expect(out.result).toMatchObject({ deletedTags: [CERT_DEPOSIT_TAG], changed: 1 });
    expect(gh.tags).toEqual(['v0.0.1', 'v0.0.2']);
  });

  it('reset on an already-clean fixture is a no-op', async () => {
    const gh = fakeGh({ branches: ['main'], tags: ['v0.0.1'] });
    const out = await cmdConformanceReset({ repo: REPO }, silentDeps(gh));
    expect(out.result.changed).toBe(0);
    expect(gh.branches).toEqual(['main']);
    expect(gh.tags).toEqual(['v0.0.1']);
  });
});

/* --------------------------------------------------------------------------
 * cmdConformanceCertify (C1 — install V + push→main)
 * ------------------------------------------------------------------------ */

const TAG = 'v0.0.0-dev.9';
// Both events so push→main (push) and the PR build (pull_request) each find a green Paper CI.
const SUCCESS_CI: WorkflowRun[] = [
  { id: 1, name: 'Paper CI', status: 'completed', conclusion: 'success', url: 'run-url', event: 'push' },
  { id: 2, name: 'Paper CI', status: 'completed', conclusion: 'success', url: 'pr-run-url', event: 'pull_request' },
];
const SUCCESS_CHECK: CheckRunRef[] = [{ name: 'Journal checks', conclusion: 'success' }];
const PREVIEW_COMMENT = '<!-- oak-sticky: oak-preview -->\n**Preview deployed** 🚀\n\nhttps://cert-x.oaktree-sapling-test.pages.dev\n';

/** Full seam for certify. Reset methods are inert (a certify run resets a clean fixture in
 *  tests); the C1/C2/C3 methods are driven by `over`. Records label/merge/close/tag/approve/
 *  release calls. The default publish run on the deposit tag sha ('main-sha') is observed
 *  `waiting` on the first poll (the required-reviewer gate) then `completed`/`success` after —
 *  so the happy path exercises the approve→conclude transition without stateful `over`. */
function fakeCertGh(over: {
  workflowRuns?: (sha: string) => WorkflowRun[];
  checkRuns?: (sha: string) => CheckRunRef[];
  comments?: (pr: number) => string[];
  committedDoi?: () => string | null;
  releaseAssets?: (tag: string) => string[];
} = {}): ConformanceGh & {
  labeled: [number, string][];
  merged: number[];
  closed: number[];
  pushedTags: [string, string][];
  approvals: [number, string][];
  deletedReleases: string[];
} {
  const labeled: [number, string][] = [];
  const merged: number[] = [];
  const closed: number[] = [];
  const pushedTags: [string, string][] = [];
  const approvals: [number, string][] = [];
  const deletedReleases: string[] = [];
  let publishPolls = 0;
  const defaultWorkflowRuns = (sha: string): WorkflowRun[] => {
    const runs = [...SUCCESS_CI];
    if (sha === 'main-sha') {
      publishPolls += 1;
      runs.push({
        id: 3,
        name: 'Publish Zenodo deposit',
        event: 'push',
        url: 'publish-run-url',
        status: publishPolls === 1 ? 'waiting' : 'completed',
        conclusion: publishPolls === 1 ? null : 'success',
      });
    }
    return runs;
  };
  return {
    labeled,
    merged,
    closed,
    pushedTags,
    approvals,
    deletedReleases,
    listOpenPrs: () => [],
    closePr: (_r, n) => closed.push(n),
    listBranches: () => [],
    deleteBranch: () => {},
    listTags: () => [],
    deleteTag: () => {},
    labelPr: (_r, n, l) => labeled.push([n, l]),
    prHeadSha: () => 'pr-head-sha',
    mergePr: (_r, n) => {
      merged.push(n);
      return 'merge-sha';
    },
    workflowRunsForCommit: (_r, sha) => (over.workflowRuns ?? defaultWorkflowRuns)(sha),
    checkRunsForCommit: (_r, sha) => (over.checkRuns ?? (() => SUCCESS_CHECK))(sha),
    openCertPr: (_r, _b, _m) => ({ number: 21, headSha: 'preview-head-sha' }),
    listIssueComments: (_r, pr) => (over.comments ?? (() => [PREVIEW_COMMENT]))(pr),
    committedDoi: () => (over.committedDoi ?? (() => '10.5072/zenodo.562233'))(),
    defaultBranchSha: () => 'main-sha',
    pushTag: (_r, tag, sha) => pushedTags.push([tag, sha]),
    approveDeployment: (_r, runId, env) => approvals.push([runId, env]),
    releaseAssets: (_r, tag) => (over.releaseAssets ?? (() => [...RESERVED_BUNDLE_NAMES]))(tag),
    deleteRelease: (_r, tag) => deletedReleases.push(tag),
  };
}

const certDeps = (
  gh: ConformanceGh,
  over: Partial<Pick<ConformanceDeps, 'probe' | 'installEngine'>> = {},
): ConformanceDeps => ({
  gh,
  log: () => {},
  sleep: async () => {}, // no real waits in tests
  probe: over.probe ?? (async () => 200),
  installEngine: over.installEngine ?? (async () => ({ upToDate: false, prNumber: 7, prUrl: 'https://github.com/me/fixture-paper-repo/pull/7' })),
});

describe('cmdConformanceCertify', () => {
  it('CERTIFIES push→main, the same-repo preview, and the deposit chain end to end', async () => {
    const gh = fakeCertGh();
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG, runId: '42' }, certDeps(gh));

    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({
      status: 'ok',
      paths: ['push-main', 'preview-same-repo', 'deposit'],
      tag: TAG,
      prNumber: 7,
      mergeSha: 'merge-sha',
      pagesUrl: pagesUrlFor(REPO),
      previewPr: 21,
      previewUrl: 'https://cert-x.oaktree-sapling-test.pages.dev',
      depositTag: CERT_DEPOSIT_TAG,
      releaseAssets: RESERVED_BUNDLE_NAMES,
    });
    expect(gh.labeled).toEqual([[7, CONFORMANCE_LABEL], [21, CONFORMANCE_LABEL]]);
    expect(gh.merged).toEqual([7]); // only the upgrade PR is merged (push→main trigger)
    expect(gh.closed).toEqual([21]); // the observation-only preview PR is closed, not merged
    expect(gh.pushedTags).toEqual([[CERT_DEPOSIT_TAG, 'main-sha']]); // reserved clean-semver tag
    expect(gh.approvals).toEqual([[3, 'zenodo-publish']]); // approved the waiting deployment gate
    expect(gh.deletedReleases).toContain(CERT_DEPOSIT_TAG); // pre-push idempotency + post-success cleanup
  });

  it('fails without merging when the fixture is already at V (no upgrade PR)', async () => {
    const gh = fakeCertGh();
    const out = await cmdConformanceCertify(
      { repo: REPO, tag: TAG },
      certDeps(gh, { installEngine: async () => ({ upToDate: true, prNumber: null, prUrl: null }) }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'install' });
    expect(gh.merged).toEqual([]);
  });

  it('fails the cert when Paper CI concludes failure on main', async () => {
    const gh = fakeCertGh({
      workflowRuns: () => [{ id: 9, name: 'Paper CI', status: 'completed', conclusion: 'failure', url: 'bad-run', event: 'push' }],
    });
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG }, certDeps(gh));
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'push-main' });
    expect(out.result.failure).toContain('Paper CI');
  });

  it('fails the cert when Pages does not serve 200 (green-but-empty guard)', async () => {
    const gh = fakeCertGh();
    // Only the /fixture-paper-repo/ Pages URL should 404; the pages.dev preview stays 200.
    const out = await cmdConformanceCertify(
      { repo: REPO, tag: TAG },
      certDeps(gh, { probe: async (url) => (url === pagesUrlFor(REPO) ? 404 : 200) }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'push-main' });
    expect(out.result.failure).toContain('404');
  });

  it('fails at the preview phase when the sticky degraded to an artifact link (no pages.dev URL)', async () => {
    const gh = fakeCertGh({ comments: () => ['<!-- oak-sticky: oak-preview -->\n**Preview build ready** 📦\nartifact link, no live preview'] });
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG }, certDeps(gh));
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'preview-same-repo' });
    expect(gh.merged).toEqual([7]); // push→main still happened; preview is the failing phase
  });

  it('fails at the preview phase when the preview URL does not serve 200', async () => {
    const gh = fakeCertGh();
    const out = await cmdConformanceCertify(
      { repo: REPO, tag: TAG },
      certDeps(gh, { probe: async (url) => (url.includes('pages.dev') ? 503 : 200) }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'preview-same-repo' });
    expect(out.result.failure).toContain('503');
  });

  it('fails at the deposit phase when the fixture carries no committed sandbox DOI', async () => {
    const gh = fakeCertGh({ committedDoi: () => null });
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG }, certDeps(gh));
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'deposit' });
    expect(out.result.failure).toContain('sandbox DOI');
    expect(gh.merged).toEqual([7]); // push→main + preview succeeded; deposit is the failing phase
    expect(gh.pushedTags).toEqual([]); // never tagged — the precondition failed first
  });

  it('fails at the deposit phase when the committed DOI is production, not sandbox', async () => {
    const gh = fakeCertGh({ committedDoi: () => '10.5281/zenodo.999999' });
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG }, certDeps(gh));
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'deposit' });
    expect(gh.pushedTags).toEqual([]);
  });

  it('fails at the deposit phase when the GH Release is missing a deposit asset', async () => {
    const gh = fakeCertGh({ releaseAssets: () => RESERVED_BUNDLE_NAMES.filter((n) => n !== 'engine.zip') });
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG }, certDeps(gh));
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'deposit' });
    expect(out.result.failure).toContain('engine.zip');
    expect(gh.pushedTags).toHaveLength(1); // tag was pushed before the (failing) asset check
    expect(gh.pushedTags[0]![1]).toBe('main-sha');
    expect(gh.approvals).toEqual([[3, 'zenodo-publish']]); // gate approved before the asset check
  });

  it('fails at the deposit phase when the publish run concludes failure', async () => {
    const gh = fakeCertGh({
      workflowRuns: (sha) =>
        sha === 'main-sha'
          ? [{ id: 3, name: 'Publish Zenodo deposit', status: 'completed', conclusion: 'failure', url: 'bad-publish', event: 'push' }]
          : SUCCESS_CI,
    });
    const out = await cmdConformanceCertify({ repo: REPO, tag: TAG }, certDeps(gh));
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ status: 'failed', path: 'deposit' });
    expect(out.result.failure).toContain('Publish Zenodo deposit');
    expect(gh.deletedReleases).toEqual([CERT_DEPOSIT_TAG]); // only the pre-push cleanup ran (failed before post-success cleanup)
  });
});
