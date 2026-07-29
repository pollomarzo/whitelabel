/**
 * conformance.ts — the paper-CI conformance harness (`oak conformance`).
 *
 * Certifies that the CI an engine version V stamps into paper repos works in all its parts —
 * build, Pages deploy, fork-safe preview, journal checks, the Zenodo deposit chain, the
 * self-bump — by driving the standing fixtures against V and asserting each path green.
 * See `whitelabel/plan-paper-ci-conformance.md`.
 *
 * Slice C0 (this file, so far): the `reset` subcommand — the repeatability floor. Every cert
 * run works on ephemeral, namespaced state (`cert-*` branches/PRs, a `*-cert-*` throwaway tag);
 * `reset` tears that down so runs are repeatable. Idempotent: a second reset is a no-op.
 *
 * The GitHub operations are behind the `ConformanceGh` seam so the orchestration is unit-tested
 * with the network faked (the BootstrapDeps/Provisioner pattern); a real run injects
 * `realConformanceGh` from gh.ts. The harness holds ONLY the fixture-scoped PAT — CF/Zenodo
 * creds stay the fixture repo's own secrets, read back from the fixture run (plan §credentials).
 */
import { STICKY_PREVIEW } from './preview.js';
import { RESERVED_BUNDLE_NAMES } from './zenodo.js';

/** Label stamped on every PR the harness opens — the robust teardown signal (works for fork
 *  PRs whose head branch the harness does not name). Provisioned on the fixture in C0. */
export const CONFORMANCE_LABEL = 'conformance';

/** Prefix for the ephemeral base-repo branches a cert run creates. */
export const CERT_BRANCH_PREFIX = 'cert-';

/** Substring marking a throwaway cert *branch*-side tag (reset sweeps `*-cert-*`). NOT usable
 *  for the deposit tag — `oak release` requires a clean `vX.Y.Z` (see `CERT_DEPOSIT_TAG`). */
export const CERT_TAG_MARKER = '-cert-';

/** The C3 deposit tag. `oak release` rejects anything but `/^v\d+\.\d+\.\d+$/`, so it can't
 *  carry the `-cert-` marker; a reserved throwaway version (won't collide with the fixture's
 *  real `v0.0.1`/`v0.0.2`) is pushed, published, asserted, then deleted. Reused every run —
 *  the deposit draft is keyed by github/id, not the tag, so the version label is immaterial. */
export const CERT_DEPOSIT_TAG = 'v0.0.0';

/** The injectable GitHub seam. Every method acts on `repo` = a fixture `owner/name`. */
export interface ConformanceGh {
  /** Open PRs on `repo` carrying `label`. Tolerates a not-yet-created label (→ []). */
  listOpenPrs(repo: string, label: string): { number: number; headRef: string }[];
  /** Close PR #n without merging. */
  closePr(repo: string, prNumber: number): void;
  /** Branch names on `repo` starting with `prefix` (the `refs/heads/` stripped). */
  listBranches(repo: string, prefix: string): string[];
  /** Delete a branch by name; tolerates an already-absent ref. */
  deleteBranch(repo: string, branch: string): void;
  /** Tag names on `repo` containing `marker`. */
  listTags(repo: string, marker: string): string[];
  /** Delete a tag by name; tolerates an already-absent ref. */
  deleteTag(repo: string, tag: string): void;

  // --- C1: install-V + push→main -------------------------------------------------------
  /** Add `label` to PR #n (so reset/teardown can find it). */
  labelPr(repo: string, prNumber: number, label: string): void;
  /** The PR's HEAD commit sha — the ref the merge-gating Check Run is posted on. */
  prHeadSha(repo: string, prNumber: number): string;
  /** Merge PR #n (delete its branch) and return the resulting merge-commit sha. */
  mergePr(repo: string, prNumber: number): string;
  /** Workflow runs whose head commit is `sha` (Paper CI / Journal checks …). */
  workflowRunsForCommit(repo: string, sha: string): WorkflowRun[];
  /** Check Runs on commit `sha` (the "Journal checks" run check-post posts). */
  checkRunsForCommit(repo: string, sha: string): CheckRunRef[];

  // --- C2: same-repo PR preview --------------------------------------------------------
  /** Open a same-repo PR off `main` on `branch` with a trivial always-valid content change
   *  (a MyST comment carrying `marker`), via the Contents API (no clone). Returns the PR
   *  number and its head sha. */
  openCertPr(repo: string, branch: string, marker: string): { number: number; headSha: string };
  /** Comment bodies on PR #n (to find the sticky preview comment). */
  listIssueComments(repo: string, prNumber: number): string[];

  // --- C3: deposit chain (publish/release half) ----------------------------------------
  /** The committed `project.doi` from the fixture's `myst.yml` on the default branch, or null
   *  if unset — the C3 precondition (the fixture must carry a sandbox DOI). */
  committedDoi(repo: string): string | null;
  /** The default branch (`main`) HEAD sha — the ref the throwaway cert tag points at. */
  defaultBranchSha(repo: string): string;
  /** Create a lightweight tag `tag` → `sha` (the `v*` push that triggers publish.yml). */
  pushTag(repo: string, tag: string, sha: string): void;
  /** Approve the pending `environment` deployment on run `runId` (the required-reviewer gate).
   *  Tolerates an empty/already-approved pending list. */
  approveDeployment(repo: string, runId: number, environment: string): void;
  /** Asset names on the GH Release for `tag` (`[]` when the release doesn't exist yet). */
  releaseAssets(repo: string, tag: string): string[];
  /** Delete the GH Release for `tag` (and, via cleanup, the tag); tolerates absence. */
  deleteRelease(repo: string, tag: string): void;
}

export interface WorkflowRun {
  id: number; // the run id — needed to approve/poll a *specific* run (C3)
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | … (null until completed)
  url: string;
  event: string; // push | pull_request | …
}

export interface CheckRunRef {
  name: string;
  conclusion: string | null; // null while still running
}

export interface ConformanceDeps {
  gh: ConformanceGh;
  log(msg: string): void;
  /** Await `ms` between polls (injected so tests run without real waits). */
  sleep(ms: number): Promise<void>;
  /** HTTP status of a GET to `url` (0 on network error) — the Pages-serves assertion. */
  probe(url: string): Promise<number>;
  /** Install engine `tag` into `repo` via `oak upgrade --both` (dogfoods the migration path).
   *  Returns the opened PR, or `upToDate` when the pin already equals `tag`. */
  installEngine(repo: string, tag: string): Promise<{ upToDate: boolean; prNumber: number | null; prUrl: string | null }>;
}

/** reset needs only the teardown seam — kept narrow so its callers stay light. */
export type ResetDeps = Pick<ConformanceDeps, 'gh' | 'log'>;

export interface Outcome {
  exitCode: number;
  result: Record<string, unknown>;
}

export interface ResetInput {
  /** The fixture paper repo, owner/name. Fork PRs surface here too (their head is on the fork,
   *  which the reset never touches — the fork uses a standing head branch, plan C2). */
  repo: string;
}

/**
 * Tear down the ephemeral state of prior cert runs so the fixture is a clean reset point.
 * Order: close labelled PRs first (so the PR list is clean even if a later branch delete is
 * denied), then delete `cert-*` branches, then `*-cert-*` tags. Every step is idempotent —
 * an absent target is skipped, not an error.
 */
export async function cmdConformanceReset(input: ResetInput, deps: ResetDeps): Promise<Outcome> {
  const { gh, log } = deps;
  const { repo } = input;

  const closedPrs: number[] = [];
  for (const pr of gh.listOpenPrs(repo, CONFORMANCE_LABEL)) {
    gh.closePr(repo, pr.number);
    closedPrs.push(pr.number);
    log(`closed PR #${pr.number} (${pr.headRef})`);
  }

  const deletedBranches: string[] = [];
  for (const branch of gh.listBranches(repo, CERT_BRANCH_PREFIX)) {
    gh.deleteBranch(repo, branch);
    deletedBranches.push(branch);
    log(`deleted branch ${branch}`);
  }

  // Cert tags: the `*-cert-*` branch-side markers plus the reserved deposit tag (which carries
  // no marker). `listTags` is a substring match, so `v0.0.0` also catches any `v0.0.0-cert-*`
  // leftover from the pre-fix tag scheme — the Set dedups the overlap.
  const certTags = new Set([...gh.listTags(repo, CERT_TAG_MARKER), ...gh.listTags(repo, CERT_DEPOSIT_TAG)]);
  const deletedTags: string[] = [];
  for (const tag of certTags) {
    // A crashed C3 run leaves a GH Release on the cert tag — clean it too. `deleteRelease`'s
    // `--cleanup-tag` also removes the tag, so the following `deleteTag` is a tolerated no-op.
    gh.deleteRelease(repo, tag);
    gh.deleteTag(repo, tag);
    deletedTags.push(tag);
    log(`deleted tag ${tag}`);
  }

  const changed = closedPrs.length + deletedBranches.length + deletedTags.length;
  log(changed === 0 ? 'reset: already clean (no-op)' : `reset: cleaned ${changed} item(s)`);

  return {
    exitCode: 0,
    result: { status: 'ok', repo, closedPrs, deletedBranches, deletedTags, changed },
  };
}

/* ==========================================================================================
 * C1 — install V + certify the push→main path
 * ======================================================================================== */

/** Poll bounds for waiting on real runs. A push→main Paper CI + Pages deploy is minutes; be
 *  generous (retry/fault-attribution is a later slice, C4). Tests inject a no-op `sleep`. */
const POLL = { tries: 80, intervalMs: 15_000 };

/**
 * Call `attempt` until it returns a value (ready), rethrowing whatever it throws (a definitive
 * failure — e.g. a concluded-but-failed run); `null` means "keep waiting". Throws on timeout.
 */
async function pollUntil<T>(
  label: string,
  attempt: () => T | null,
  deps: { sleep(ms: number): Promise<void>; log(msg: string): void },
  opts: { tries: number; intervalMs: number } = POLL,
): Promise<T> {
  for (let i = 0; i < opts.tries; i++) {
    const ready = attempt();
    if (ready !== null) return ready;
    if (i < opts.tries - 1) await deps.sleep(opts.intervalMs);
  }
  throw new Error(`timed out waiting for ${label} (${opts.tries}×${opts.intervalMs}ms)`);
}

/** null = still pending; the ref when it concluded success; throws when it concluded !success. */
function checkOutcome(runs: CheckRunRef[], name: string): CheckRunRef | null {
  const cr = runs.find((c) => c.name === name);
  if (!cr || cr.conclusion === null) return null;
  if (cr.conclusion !== 'success') throw new Error(`${name} Check Run concluded ${cr.conclusion}`);
  return cr;
}

/** Project-Pages URL for a fixture repo (owner.github.io/name/). */
export function pagesUrlFor(repo: string): string {
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}/`;
}

export interface CertifyInput {
  repo: string;
  tag: string; // engine version V under test
  runId?: string; // namespaces the cert-<runId> preview branch; defaults to a timestamp
}

/** The preview sticky's stable marker (preview.ts owns the identifier; keep in sync). */
const PREVIEW_STICKY_MARK = `<!-- oak-sticky: ${STICKY_PREVIEW} -->`;

/** Pull the Cloudflare `*.pages.dev` URL out of a preview sticky comment (null if it degraded
 *  to an artifact-link comment, i.e. no live preview to probe). */
function extractPreviewUrl(commentBody: string): string | null {
  const m = commentBody.match(/https:\/\/[^\s)]*pages\.dev[^\s)]*/);
  return m ? m[0] : null;
}

/**
 * Certify the **push→main** path for engine version V: install V via the dogfooded migration
 * PR, let the fixture's required "Journal checks" gate the merge (which also exercises the PR
 * check→check-post path), then assert — at the *part* level, not just run conclusions — that
 * Paper CI (build + Pages) is green, Pages actually serves 200, and the "Journal checks" Check
 * Run was posted on main. C2 (PR previews + sticky), C3 (deposit), C4 (verdict) append here.
 */
export async function cmdConformanceCertify(input: CertifyInput, deps: ConformanceDeps): Promise<Outcome> {
  const { gh, log, sleep, probe, installEngine } = deps;
  const { repo, tag } = input;
  const runId = input.runId ?? String(Date.now());
  let phase = 'push-main';
  try {
    // 1. Clean baseline (idempotent teardown of any prior run's ephemeral state).
    await cmdConformanceReset({ repo }, { gh, log });

    // 2. Install V by dogfooding the migration path (not a raw copy — the re-copy is under test).
    const up = await installEngine(repo, tag);
    if (up.upToDate || up.prNumber === null) {
      return {
        exitCode: 1,
        result: {
          status: 'failed',
          tag,
          path: 'install',
          failure: `no upgrade PR — the fixture pin already equals ${tag}. Cut a fresh dev tag so push→main has a change to certify.`,
        },
      };
    }
    const prNumber = up.prNumber;
    gh.labelPr(repo, prNumber, CONFORMANCE_LABEL);
    log(`upgrade PR #${prNumber}: ${up.prUrl}`);

    // 3. Wait for the required "Journal checks" to pass on the PR — the merge gate, and the
    //    prerequisite that exercises the PR check→check-post path for free.
    const prSha = gh.prHeadSha(repo, prNumber);
    await pollUntil(
      `PR #${prNumber} Journal checks`,
      () => checkOutcome(gh.checkRunsForCommit(repo, prSha), 'Journal checks'),
      { sleep, log },
    );

    // 4. Merge → the push→main event under test.
    const mergeSha = gh.mergePr(repo, prNumber);
    log(`merged PR #${prNumber} → ${mergeSha}`);

    // 5. Paper CI (build + deploy-pages) concluded success on the merge commit.
    await pollUntil(
      'Paper CI (push→main)',
      () => {
        const ci = gh.workflowRunsForCommit(repo, mergeSha).find((r) => r.name === 'Paper CI' && r.event === 'push');
        if (!ci || ci.status !== 'completed') return null;
        if (ci.conclusion !== 'success') throw new Error(`Paper CI concluded ${ci.conclusion} — ${ci.url}`);
        return ci;
      },
      { sleep, log },
    );

    // 6. Pages actually SERVES (the part, not just the deploy job's conclusion — "green-but-empty").
    const pagesUrl = pagesUrlFor(repo);
    const status = await probe(pagesUrl);
    if (status !== 200) throw new Error(`Pages ${pagesUrl} returned ${status}, expected 200`);
    log(`Pages 200: ${pagesUrl}`);

    // 7. The "Journal checks" Check Run was actually posted on main (check-post ran, not just check).
    await pollUntil(
      'Journal checks Check Run (push→main)',
      () => checkOutcome(gh.checkRunsForCommit(repo, mergeSha), 'Journal checks'),
      { sleep, log },
    );

    log(`push→main CERTIFIED for ${tag}`);

    // ---- Phase: same-repo PR preview (Cloudflare deploy + sticky comment) ---------------
    phase = 'preview-same-repo';
    const branch = `${CERT_BRANCH_PREFIX}${runId}`;
    const previewPr = gh.openCertPr(repo, branch, runId);
    gh.labelPr(repo, previewPr.number, CONFORMANCE_LABEL);
    log(`same-repo preview PR #${previewPr.number} (${branch})`);

    // Stage 1: Paper CI build on the PR (secretless by design — the untrusted build job).
    await pollUntil(
      `Paper CI (PR #${previewPr.number} build)`,
      () => {
        const ci = gh.workflowRunsForCommit(repo, previewPr.headSha).find((r) => r.name === 'Paper CI' && r.event === 'pull_request');
        if (!ci || ci.status !== 'completed') return null;
        if (ci.conclusion !== 'success') throw new Error(`Paper CI (PR) concluded ${ci.conclusion} — ${ci.url}`);
        return ci;
      },
      { sleep, log },
    );

    // Stage 2: the preview sticky comment, posted from base context (workflow_run) — its very
    // presence proves the fork-safe build→deploy split ran end to end.
    const previewBody = await pollUntil(
      `preview sticky comment on PR #${previewPr.number}`,
      () => gh.listIssueComments(repo, previewPr.number).find((b) => b.includes(PREVIEW_STICKY_MARK)) ?? null,
      { sleep, log },
    );

    // The preview actually SERVES 200 (not just that a comment was posted).
    const previewUrl = extractPreviewUrl(previewBody);
    if (!previewUrl) throw new Error('preview comment posted but carries no Cloudflare URL — degraded to artifact (fixture CF secrets missing?)');
    const previewStatus = await probe(previewUrl);
    if (previewStatus !== 200) throw new Error(`preview ${previewUrl} returned ${previewStatus}, expected 200`);
    log(`preview 200: ${previewUrl}`);

    // Close this observation-only PR + delete its branch (reset also handles it on a crash).
    gh.closePr(repo, previewPr.number);
    gh.deleteBranch(repo, branch);
    log(`same-repo preview CERTIFIED for ${tag}`);

    // ---- Phase: deposit chain (the publish/release half) --------------------------------
    // C3 certifies publish.yml → `oak release`: the tag push, the required-reviewer gate, and
    // the 5-file deposit bundle landing on the tag's GitHub Release ([R24]). It does NOT test
    // prepare-from-scratch — the fixture already carries a committed sandbox DOI and cmdPrepare
    // refuses when one is set (per-run DOI mutation is explicitly deferred). The harness holds
    // no Zenodo token, so it asserts the deposit token-free via the Release assets (same bytes).
    phase = 'deposit';

    // 1. Precondition: a committed *sandbox* DOI (10.5072/…) on the fixture's myst.yml.
    const doi = gh.committedDoi(repo);
    if (!doi || !doi.startsWith('10.5072/')) {
      throw new Error(
        `C3 needs a committed sandbox DOI on the fixture (found ${doi ?? 'none'}); ` +
          `prepare-from-scratch coverage is deferred.`,
      );
    }
    log(`fixture sandbox DOI: ${doi}`);

    // 2. Push the reserved deposit tag at main HEAD — a clean `vX.Y.Z` `oak release` accepts.
    //    Delete any stale one first (a prior crash), so the push + `gh release create` are clean.
    const depositTag = CERT_DEPOSIT_TAG;
    gh.deleteRelease(repo, depositTag); // --cleanup-tag also drops the tag; tolerant of absence
    gh.deleteTag(repo, depositTag); // belt-and-suspenders if a bare tag (no Release) lingered
    const tagSha = gh.defaultBranchSha(repo);
    gh.pushTag(repo, depositTag, tagSha);
    log(`pushed deposit tag ${depositTag} → ${tagSha}`);

    // 3. Find the publish run for that tag, approve its zenodo-publish deployment gate, then
    //    wait for it to conclude success.
    const publishRun = await pollUntil(
      `Publish Zenodo deposit run for ${depositTag}`,
      () => {
        const run = gh
          .workflowRunsForCommit(repo, tagSha)
          .find((r) => r.name === 'Publish Zenodo deposit' && r.event === 'push');
        if (!run) return null;
        if (run.status === 'completed') {
          // Concluded before we could approve (no gate, or a failure) — decide now.
          if (run.conclusion !== 'success') throw new Error(`Publish Zenodo deposit concluded ${run.conclusion} — ${run.url}`);
          return run;
        }
        if (run.status !== 'waiting') return null; // queued/in_progress — keep waiting for the gate
        return run;
      },
      { sleep, log },
    );
    if (publishRun.status === 'waiting') {
      gh.approveDeployment(repo, publishRun.id, 'zenodo-publish');
      log(`approved zenodo-publish deployment for run ${publishRun.id}`);
    }
    await pollUntil(
      `Publish Zenodo deposit success for ${depositTag}`,
      () => {
        const run = gh.workflowRunsForCommit(repo, tagSha).find((r) => r.id === publishRun.id);
        if (!run || run.status !== 'completed') return null;
        if (run.conclusion !== 'success') throw new Error(`Publish Zenodo deposit concluded ${run.conclusion} — ${run.url}`);
        return run;
      },
      { sleep, log },
    );

    // 4. The deposit bundle (the exact deposited bytes) landed on the tag's GH Release — assert
    //    all five reserved files are present. This is the token-free deposit assertion ([R24]).
    const releaseAssets = gh.releaseAssets(repo, depositTag);
    const missing = RESERVED_BUNDLE_NAMES.filter((n) => !releaseAssets.includes(n));
    if (missing.length) {
      throw new Error(
        `GH Release ${depositTag} is missing deposit asset(s): ${missing.join(', ')} ` +
          `(found: ${releaseAssets.join(', ') || 'none'})`,
      );
    }
    log(`deposit bundle on Release ${depositTag}: ${releaseAssets.join(', ')}`);

    // 5. Cleanup on success: drop the cert Release (and, via cleanup, its tag).
    gh.deleteRelease(repo, depositTag);
    gh.deleteTag(repo, depositTag); // tolerated no-op if the Release cleanup already removed it
    log(`deposit CERTIFIED for ${tag}`);

    return {
      exitCode: 0,
      result: {
        status: 'ok',
        tag,
        repo,
        paths: ['push-main', 'preview-same-repo', 'deposit'],
        prNumber,
        mergeSha,
        pagesUrl,
        previewPr: previewPr.number,
        previewUrl,
        depositTag,
        releaseAssets,
      },
    };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    log(`certify FAILED for ${tag} at ${phase}: ${failure}`);
    return { exitCode: 1, result: { status: 'failed', tag, path: phase, repo, failure } };
  }
}
