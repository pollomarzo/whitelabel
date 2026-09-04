/**
 * conformance.ts: the paper-CI conformance harness (`oak conformance`).
 *
 * Certifies that the CI an engine version V stamps into paper repos works in all its parts:
 * build, Pages deploy, fork-safe preview, journal checks, the Zenodo deposit chain, the
 * self-bump: by driving the standing fixtures against V and asserting each path green.
 * See `whitelabel/plan-paper-ci-conformance.md`.
 *
 * Slice C0 (this file, so far): the `reset` subcommand, the repeatability floor. Every cert
 * run works on ephemeral, namespaced state (`cert-*` branches/PRs, a `*-cert-*` throwaway tag);
 * `reset` tears that down so runs are repeatable. Idempotent: a second reset is a no-op.
 *
 * The GitHub operations are behind the `ConformanceGh` seam so the orchestration is unit-tested
 * with the network faked (the BootstrapDeps/Provisioner pattern); a real run injects
 * `realConformanceGh` from gh.ts. The harness holds ONLY the fixture-scoped PAT, CF/Zenodo
 * creds stay the fixture repo's own secrets, read back from the fixture run (plan §credentials).
 */
import { STICKY_PREVIEW } from './preview.js';
import { stickyMarker } from './messages.js';
import { RESERVED_BUNDLE_NAMES } from './zenodo.js';
import { UPGRADE_BRANCH_PREFIX } from './upgrade.js';

/** Label stamped on every PR the harness opens, the robust teardown signal (works for fork
 *  PRs whose head branch the harness does not name). Provisioned on the fixture in C0. */
export const CONFORMANCE_LABEL = 'conformance';

/** Prefix for the ephemeral base-repo branches a cert run creates. */
export const CERT_BRANCH_PREFIX = 'cert-';

/** Substring marking a throwaway cert *branch*-side tag (reset sweeps `*-cert-*`). NOT usable
 *  for the deposit tag: `oak release` requires a clean `vX.Y.Z` (see `CERT_DEPOSIT_TAG`). */
export const CERT_TAG_MARKER = '-cert-';

/** The C3 deposit tag. `oak release` rejects anything but `/^v\d+\.\d+\.\d+$/`, so it can't
 *  carry the `-cert-` marker; a reserved throwaway version (won't collide with the fixture's
 *  real `v0.0.1`/`v0.0.2`) is pushed, published, asserted, then deleted. Reused every run:
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
  /** The PR's HEAD commit sha: the ref the merge-gating Check Run is posted on. */
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
   *  if unset: the C3 precondition (the fixture must carry a sandbox DOI). */
  committedDoi(repo: string): string | null;
  /** The committed engine version pin from the fixture's `myst.yml`, or null when unset. */
  committedEngineVersion(repo: string): string | null;
  /** The default branch (`main`) HEAD sha, the ref the throwaway cert tag points at. */
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

  // --- fork-PR preview path (optional, lab-tier) ---------------------------------------
  /** Delete `refs/heads/<prefix>*` on the FORK (fork token), idempotency for stale cert
   *  branches a crashed run left behind. Returns the swept branch names. */
  sweepForkBranches(forkRepo: string, forkToken: string, prefix: string): string[];
  /** Open a CROSS-fork PR: on the fork (fork token) branch off its default branch and bump the
   *  engine pin to `tag` (the non-empty diff, and the faithful build-under-V), then `gh pr create`
   *  on the BASE repo (primary token) with `--head <forkOwner>:<branch>`. Returns the base-repo PR
   *  number and the fork branch's post-commit head sha. */
  openForkPr(
    baseRepo: string,
    forkRepo: string,
    forkToken: string,
    branch: string,
    tag: string,
    marker: string,
  ): { number: number; headSha: string };
  /** Delete the fork's cert branch (fork token); tolerates an already-absent ref. */
  deleteForkBranch(forkRepo: string, forkToken: string, branch: string): void;
  /** Approve a workflow run awaiting the first-time-contributor gate (the gate is on the BASE
   *  repo, so the PRIMARY token). TOLERANT: a no-op when approval isn't required. */
  approveWorkflowRun(repo: string, runId: number): void;
}

export interface WorkflowRun {
  id: number; // the run id; needed to approve/poll a *specific* run (C3)
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
  /** HTTP status of a GET to `url` (0 on network error), the Pages-serves assertion. */
  probe(url: string): Promise<number>;
  /** Install engine `tag` into `repo` via `oak upgrade --both` (dogfoods the migration path).
   *  Returns the opened PR, or `upToDate` when the pin already equals `tag`. */
  installEngine(
    repo: string,
    tag: string,
  ): Promise<{ upToDate: boolean; prNumber: number | null; prUrl: string | null }>;
  /** The second-account fork (repo + its own PAT) for the optional fork-PR preview phase, or null
   *  when unconfigured: the phase then self-skips so certs keep working pre-provisioning. */
  fork?: { repo: string; token: string } | null;
}

/** reset needs only the teardown seam, kept narrow so its callers stay light. */
export type ResetDeps = Pick<ConformanceDeps, 'gh' | 'log'>;

export interface Outcome {
  exitCode: number;
  result: Record<string, unknown>;
}

export interface ResetInput {
  /** The fixture paper repo, owner/name. Fork PRs surface here too (their head is on the fork,
   *  which the reset never touches: the fork uses a standing head branch, plan C2). */
  repo: string;
}

/**
 * Tear down the ephemeral state of prior cert runs so the fixture is a clean reset point.
 * Order: close labelled PRs first (so the PR list is clean even if a later branch delete is
 * denied), then delete `cert-*` branches, then `*-cert-*` tags. Every step is idempotent:
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

  // Both prefixes: the install phase's own `oak upgrade` opens the second, and sweeping only the
  // first made certify once-per-tag ([R117]). Deleting a branch closes its PR.
  const deletedBranches: string[] = [];
  for (const prefix of [CERT_BRANCH_PREFIX, UPGRADE_BRANCH_PREFIX]) {
    for (const branch of gh.listBranches(repo, prefix)) {
      gh.deleteBranch(repo, branch);
      deletedBranches.push(branch);
      log(`deleted branch ${branch}`);
    }
  }

  // Cert tags: the `*-cert-*` branch-side markers plus the reserved deposit tag (which carries
  // no marker). `listTags` is a substring match, so `v0.0.0` also catches any `v0.0.0-cert-*`
  // leftover from the pre-fix tag scheme; the Set dedups the overlap.
  const certTags = new Set([
    ...gh.listTags(repo, CERT_TAG_MARKER),
    ...gh.listTags(repo, CERT_DEPOSIT_TAG),
  ]);
  const deletedTags: string[] = [];
  for (const tag of certTags) {
    // A crashed C3 run leaves a GH Release on the cert tag, clean it too. `deleteRelease`'s
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
 * C1: install V + certify the push→main path
 * ======================================================================================== */

/** Poll bounds for waiting on real runs. A push→main Paper CI + Pages deploy is minutes; be
 *  generous. Tests inject a no-op `sleep`. */
const POLL = { tries: 80, intervalMs: 15_000 };

/** Probe retry bounds: a preview/Pages URL can 5xx/refuse briefly right after deploy. */
const PROBE = { tries: 6, intervalMs: 5_000 };

/**
 * A failure that is NOT the engine's fault, a third-party outage/slowness (Cloudflare, Pages,
 * Zenodo, the GitHub API) or a poll timeout. It yields an **inconclusive** verdict, never a red
 * "the engine is broken": a cert red must mean *us* (design C4, "red must mean us").
 */
export class ThirdPartyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThirdPartyError';
  }
}

/**
 * Call `attempt` until it returns a value (ready), rethrowing whatever it throws (a definitive
 * failure: e.g. a concluded-but-failed run); `null` means "keep waiting". A timeout is treated
 * as third-party (a stuck/slow runner is not an engine defect), UNLESS `settled` says the work
 * that would produce the part has finished: then the part is absent, not late, which is the
 * green-but-empty class the harness exists to catch ([R113]).
 */
async function pollUntil<T>(
  label: string,
  attempt: () => T | null,
  deps: { sleep(ms: number): Promise<void>; log(msg: string): void },
  opts: { tries: number; intervalMs: number; settled?: () => boolean } = POLL,
): Promise<T> {
  for (let i = 0; i < opts.tries; i++) {
    const ready = attempt();
    if (ready !== null) return ready;
    if (i < opts.tries - 1) await deps.sleep(opts.intervalMs);
  }
  if (opts.settled?.()) {
    throw new Error(`${label} never appeared, though every run on its commit has finished`);
  }
  throw new ThirdPartyError(
    `timed out waiting for ${label} (${opts.tries}×${opts.intervalMs}ms); slow/stuck third party`,
  );
}

/**
 * A `gh` child that failed because the API could not SERVE us, in the shape gh.ts's `run`
 * formats: a rate limit, a 5xx, a dropped connection ([R113]). Those are a third party's bad day
 * and must not redden a cert.
 *
 * A 401/403 that is not a rate limit is the opposite: the API served us and REFUSED this
 * request, which means a missing scope, a missing `permissions:` block or a call that does not
 * apply. Those are ours, and reading them as third-party turned a harness bug green ([R150]).
 */
function isGitHubApiFault(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  if (!/^gh \S* ?failed \(exit /.test(m)) return false;
  if (/rate limit|secondary rate|abuse detection|HTTP 429/i.test(m)) return true;
  return /HTTP 5\d\d|ECONNRESET|EAI_AGAIN|ETIMEDOUT|timed out|connection reset|bad gateway|service unavailable/i.test(
    m,
  );
}

/**
 * Assert a URL serves 200, retrying transient statuses (network error / 429 / 5xx) with backoff.
 * A persistent transient → `ThirdPartyError` (inconclusive); a definitive 4xx (e.g. 404 = nothing
 * deployed) → a normal Error (our break: the deploy produced no page).
 */
async function assertServes200(
  deps: { probe(url: string): Promise<number>; sleep(ms: number): Promise<void> },
  url: string,
  label: string,
): Promise<void> {
  const transient = (s: number) => s === 0 || s === 429 || s >= 500;
  let status = 0;
  for (let i = 0; i < PROBE.tries; i++) {
    status = await deps.probe(url);
    if (status === 200) return;
    if (!transient(status)) throw new Error(`${label} ${url} returned ${status}, expected 200`);
    if (i < PROBE.tries - 1) await deps.sleep(PROBE.intervalMs);
  }
  throw new ThirdPartyError(
    `${label} ${url} still ${status} after ${PROBE.tries} tries; transient/outage`,
  );
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
const PREVIEW_STICKY_MARK = stickyMarker(STICKY_PREVIEW);

/** Pull the Cloudflare `*.pages.dev` URL out of a preview sticky comment (null if it degraded
 *  to an artifact-link comment, i.e. no live preview to probe). */
function extractPreviewUrl(commentBody: string): string | null {
  const m = commentBody.match(/https:\/\/[^\s)]*pages\.dev[^\s)]*/);
  return m ? m[0] : null;
}

/**
 * Certify the **push→main** path for engine version V: install V via the dogfooded migration
 * PR, let the fixture's required "Journal checks" gate the merge (which also exercises the PR
 * check→check-post path), then assert (at the *part* level, not just run conclusions) that
 * Paper CI (build + Pages) is green, Pages actually serves 200, and the "Journal checks" Check
 * Run was posted on main. C2 (PR previews + sticky), C3 (deposit), C4 (verdict) append here.
 */
export async function cmdConformanceCertify(
  input: CertifyInput,
  deps: ConformanceDeps,
): Promise<Outcome> {
  const { gh, log, sleep, probe, installEngine, fork } = deps;
  const { repo, tag } = input;
  const runId = input.runId ?? String(Date.now());
  /** Every run this commit triggered has finished, so a missing part is absent, not late. */
  const settled = (sha: string) => () => {
    const runs = gh.workflowRunsForCommit(repo, sha);
    return runs.length > 0 && runs.every((r) => r.status === 'completed');
  };
  let phase = 'push-main';
  // The certified paths, built up as each phase passes (the fork phase pushes its own).
  const paths: string[] = ['push-main', 'preview-same-repo', 'deposit'];
  const skipped: string[] = [];
  let forkResult: Record<string, unknown> = {};
  try {
    // 1. Clean baseline (idempotent teardown of any prior run's ephemeral state).
    await cmdConformanceReset({ repo }, { gh, log });

    // 2. Install V by dogfooding the migration path (not a raw copy; the re-copy is under test).
    const up = await installEngine(repo, tag);
    if (up.upToDate || up.prNumber === null) {
      return {
        exitCode: 1,
        result: {
          status: 'failed',
          tag,
          path: 'install',
          failure: `no upgrade PR: the fixture pin already equals ${tag}. Cut a fresh dev tag so push→main has a change to certify.`,
        },
      };
    }
    const prNumber = up.prNumber;
    gh.labelPr(repo, prNumber, CONFORMANCE_LABEL);
    log(`upgrade PR #${prNumber}: ${up.prUrl}`);

    // 3. Wait for the required "Journal checks" to pass on the PR, the merge gate, and the
    //    prerequisite that exercises the PR check→check-post path for free.
    const prSha = gh.prHeadSha(repo, prNumber);
    await pollUntil(
      `PR #${prNumber} Journal checks`,
      () => checkOutcome(gh.checkRunsForCommit(repo, prSha), 'Journal checks'),
      { sleep, log },
      { ...POLL, settled: settled(prSha) },
    );

    // 4. Merge → the push→main event under test.
    const mergeSha = gh.mergePr(repo, prNumber);
    log(`merged PR #${prNumber} → ${mergeSha}`);

    // The pin write is itself under test (installEngine dogfoods `oak upgrade`), so a
    // regression in it would otherwise certify V while the fixture ran something else ([R113]).
    const pinned = gh.committedEngineVersion(repo);
    if (pinned !== tag) {
      throw new Error(`fixture pins ${pinned ?? 'no engine version'} after the merge, not ${tag}`);
    }
    log(`fixture pinned to ${pinned}`);

    // 5. Paper CI (build + deploy-pages) concluded success on the merge commit.
    await pollUntil(
      'Paper CI (push→main)',
      () => {
        const ci = gh
          .workflowRunsForCommit(repo, mergeSha)
          .find((r) => r.name === 'Paper CI' && r.event === 'push');
        if (!ci || ci.status !== 'completed') return null;
        if (ci.conclusion !== 'success')
          throw new Error(`Paper CI concluded ${ci.conclusion}: ${ci.url}`);
        return ci;
      },
      { sleep, log },
    );

    // 6. Pages actually SERVES (the part, not just the deploy job's conclusion, "green-but-empty").
    const pagesUrl = pagesUrlFor(repo);
    await assertServes200({ probe, sleep }, pagesUrl, 'Pages');
    log(`Pages 200: ${pagesUrl}`);

    // 7. The "Journal checks" Check Run was actually posted on main (check-post ran, not just check).
    await pollUntil(
      'Journal checks Check Run (push→main)',
      () => checkOutcome(gh.checkRunsForCommit(repo, mergeSha), 'Journal checks'),
      { sleep, log },
      { ...POLL, settled: settled(mergeSha) },
    );

    log(`push→main CERTIFIED for ${tag}`);

    // ---- Phase: same-repo PR preview (Cloudflare deploy + sticky comment) ---------------
    phase = 'preview-same-repo';
    const branch = `${CERT_BRANCH_PREFIX}${runId}`;
    const previewPr = gh.openCertPr(repo, branch, runId);
    gh.labelPr(repo, previewPr.number, CONFORMANCE_LABEL);
    log(`same-repo preview PR #${previewPr.number} (${branch})`);

    // Stage 1: Paper CI build on the PR (secretless by design, the untrusted build job).
    await pollUntil(
      `Paper CI (PR #${previewPr.number} build)`,
      () => {
        const ci = gh
          .workflowRunsForCommit(repo, previewPr.headSha)
          .find((r) => r.name === 'Paper CI' && r.event === 'pull_request');
        if (!ci || ci.status !== 'completed') return null;
        if (ci.conclusion !== 'success')
          throw new Error(`Paper CI (PR) concluded ${ci.conclusion}: ${ci.url}`);
        return ci;
      },
      { sleep, log },
    );

    // Stage 2: the preview sticky comment, posted from base context (workflow_run); its very
    // presence proves the fork-safe build→deploy split ran end to end.
    const previewBody = await pollUntil(
      `preview sticky comment on PR #${previewPr.number}`,
      () =>
        gh.listIssueComments(repo, previewPr.number).find((b) => b.includes(PREVIEW_STICKY_MARK)) ??
        null,
      { sleep, log },
      { ...POLL, settled: settled(previewPr.headSha) },
    );

    // The preview actually SERVES 200 (not just that a comment was posted).
    const previewUrl = extractPreviewUrl(previewBody);
    if (!previewUrl)
      throw new Error(
        'preview comment posted but carries no Cloudflare URL; degraded to artifact (fixture CF secrets missing?)',
      );
    await assertServes200({ probe, sleep }, previewUrl, 'preview');
    log(`preview 200: ${previewUrl}`);

    // Close this observation-only PR + delete its branch (reset also handles it on a crash).
    gh.closePr(repo, previewPr.number);
    gh.deleteBranch(repo, branch);
    log(`same-repo preview CERTIFIED for ${tag}`);

    // ---- Phase: deposit chain (the publish/release half) --------------------------------
    // C3 certifies publish.yml → `oak release`: the tag push, the required-reviewer gate, and
    // the 5-file deposit bundle landing on the tag's GitHub Release ([R24]). It does NOT test
    // prepare-from-scratch: the fixture already carries a committed sandbox DOI and cmdPrepare
    // refuses when one is set (per-run DOI mutation is explicitly deferred). The harness holds
    // no Zenodo token, so it asserts the deposit token-free, by NAME, over the Release assets.
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

    // 2. Push the reserved deposit tag at main HEAD, a clean `vX.Y.Z` `oak release` accepts.
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
          // Concluded before we could approve (no gate, or a failure), decide now.
          if (run.conclusion !== 'success')
            throw new Error(`Publish Zenodo deposit concluded ${run.conclusion}: ${run.url}`);
          return run;
        }
        if (run.status !== 'waiting') return null; // queued/in_progress; keep waiting for the gate
        return run;
      },
      { sleep, log },
    );
    // Conditional, not an assertion of the gate: a fixture provisioned before [R123], or an
    // org tenant whose --owner named no team, legitimately has no reviewer to wait for.
    if (publishRun.status === 'waiting') {
      gh.approveDeployment(repo, publishRun.id, 'zenodo-publish');
      log(`approved zenodo-publish deployment for run ${publishRun.id}`);
    }
    await pollUntil(
      `Publish Zenodo deposit success for ${depositTag}`,
      () => {
        const run = gh.workflowRunsForCommit(repo, tagSha).find((r) => r.id === publishRun.id);
        if (!run || run.status !== 'completed') return null;
        if (run.conclusion !== 'success')
          throw new Error(`Publish Zenodo deposit concluded ${run.conclusion}: ${run.url}`);
        return run;
      },
      { sleep, log },
    );

    // 4. All five reserved deposit files are ON the tag's GH Release, by name: the harness holds
    //    no Zenodo token, so it cannot compare bytes, only that nothing is missing ([R24]).
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

    // ---- Phase: fork-PR preview (optional, lab-tier) ------------------------------------
    // The flagship cross-repository case: the PR head is on a SECOND-account fork, so Stage-1
    // build is secretless (untrusted context) and Stage-2 preview deploys from BASE context. Runs
    // ONLY when a fork is configured; otherwise it is skipped (not a failure) so certs keep
    // working before provisioning. Fork-repo ops use the fork token; base-repo ops the primary.
    if (fork) {
      phase = 'preview-fork';
      gh.sweepForkBranches(fork.repo, fork.token, CERT_BRANCH_PREFIX); // idempotency
      const forkBranch = `${CERT_BRANCH_PREFIX}${runId}`;
      const forkPr = gh.openForkPr(repo, fork.repo, fork.token, forkBranch, tag, runId);
      gh.labelPr(repo, forkPr.number, CONFORMANCE_LABEL);
      log(`fork PR #${forkPr.number} from ${fork.repo}:${forkBranch}`);

      // The fork PR's Paper CI run may sit in action_required (awaiting the first-time-contributor
      // gate): find it, then approve (tolerant: no-op if not gated).
      const forkRun = await pollUntil(
        `fork PR #${forkPr.number} Paper CI run`,
        () =>
          gh
            .workflowRunsForCommit(repo, forkPr.headSha)
            .find((r) => r.name === 'Paper CI' && r.event === 'pull_request') ?? null,
        { sleep, log },
      );
      gh.approveWorkflowRun(repo, forkRun.id);

      // Stage 1: the secretless build concludes success.
      await pollUntil(
        `fork Paper CI (secretless Stage-1) #${forkPr.number}`,
        () => {
          const r = gh
            .workflowRunsForCommit(repo, forkPr.headSha)
            .find((x) => x.name === 'Paper CI' && x.event === 'pull_request');
          if (!r || r.status !== 'completed') return null;
          if (r.conclusion !== 'success')
            throw new Error(`fork Paper CI concluded ${r.conclusion}: ${r.url}`);
          return r;
        },
        { sleep, log },
      );

      // Stage 2: the base-context preview sticky + a live 200.
      const forkBody = await pollUntil(
        `fork preview sticky on PR #${forkPr.number}`,
        () =>
          gh.listIssueComments(repo, forkPr.number).find((b) => b.includes(PREVIEW_STICKY_MARK)) ??
          null,
        { sleep, log },
        { ...POLL, settled: settled(forkPr.headSha) },
      );
      const forkPreviewUrl = extractPreviewUrl(forkBody);
      if (!forkPreviewUrl)
        throw new Error('fork preview comment carries no Cloudflare URL; degraded to artifact?');
      await assertServes200({ probe, sleep }, forkPreviewUrl, 'fork preview');
      log(`fork preview 200: ${forkPreviewUrl}`);

      gh.closePr(repo, forkPr.number); // base repo (primary token)
      gh.deleteForkBranch(fork.repo, fork.token, forkBranch); // fork repo (fork token)
      log(`fork preview CERTIFIED for ${tag}`);
      paths.push('preview-fork');
      forkResult = { forkPr: forkPr.number, forkPreviewUrl };
    } else {
      // In the verdict, not only the log: a cert that certified three of four paths must not
      // read the same as one that certified all four ([R113]).
      skipped.push('preview-fork');
      log(
        'fork preview phase SKIPPED (no fork configured; set CONFORMANCE_FORK_REPO/PAT to enable)',
      );
    }

    log(`engine ${tag}: paper-CI CERTIFIED (${paths.join(', ')})`);
    return {
      exitCode: 0,
      result: {
        status: 'ok',
        tag,
        repo,
        paths,
        skipped,
        prNumber,
        mergeSha,
        pagesUrl,
        previewPr: previewPr.number,
        previewUrl,
        depositTag,
        releaseAssets,
        ...forkResult,
      },
    };
  } catch (err) {
    // Attribute the failure: a ThirdPartyError (outage/timeout) is INCONCLUSIVE (exit 3), never
    // a red "the engine is broken"; anything else is a definitive cert FAILURE (exit 1).
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ThirdPartyError || isGitHubApiFault(err)) {
      log(`engine ${tag}: paper-CI INCONCLUSIVE at ${phase}: ${message}`);
      return {
        exitCode: 3, // 3, not 2: 2 is the CLI's usage code ([R111])
        result: { status: 'inconclusive', tag, path: phase, repo, reason: message },
      };
    }
    log(`engine ${tag}: paper-CI FAILED at ${phase}: ${message}`);
    return { exitCode: 1, result: { status: 'failed', tag, path: phase, repo, failure: message } };
  } finally {
    // Always-run teardown: every run leaves the fixture clean regardless of outcome. Guarded so a
    // teardown hiccup never masks the verdict (the run logs + verdict URLs remain for debugging).
    try {
      await cmdConformanceReset({ repo }, { gh, log });
    } catch (e) {
      log(`teardown warning: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
