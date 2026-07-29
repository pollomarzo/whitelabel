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

/** Label stamped on every PR the harness opens — the robust teardown signal (works for fork
 *  PRs whose head branch the harness does not name). Provisioned on the fixture in C0. */
export const CONFORMANCE_LABEL = 'conformance';

/** Prefix for the ephemeral base-repo branches a cert run creates. */
export const CERT_BRANCH_PREFIX = 'cert-';

/** Substring marking a throwaway cert tag, e.g. `v0.0.0-cert-<run-id>`. A `-` marker (not the
 *  semver `+build` form) keeps the tag a clean git ref and a valid `v*` trigger for the
 *  fixture's publish.yml. */
export const CERT_TAG_MARKER = '-cert-';

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
}

export interface ConformanceDeps {
  gh: ConformanceGh;
  log(msg: string): void;
}

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
export async function cmdConformanceReset(input: ResetInput, deps: ConformanceDeps): Promise<Outcome> {
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

  const deletedTags: string[] = [];
  for (const tag of gh.listTags(repo, CERT_TAG_MARKER)) {
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
