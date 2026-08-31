/**
 * ref.ts: engine-ref classification + the floating-author trust policy.
 *
 * The shim runs `engine/ci/run.sh` at a ref read from the paper's own
 * `options.oaktree-sapling.version` (design §6a). For a *public* engine that accepts
 * PRs, "resolves inside the engine repo" (the [R9] guarantee from a pinned
 * `actions/checkout repository:`) also matches `refs/pull/N/merge` of any UNMERGED PR,
 * i.e. arbitrary contributor code. So the trust boundary is repo + ref-CLASS, not
 * the repo alone (dec. 23, [R41]).
 *
 * This module is the *pure, syntactic* half of the policy: classify a ref and decide
 * whether its class is allowed in a given trigger context.
 *
 * **Nothing calls it, and dec. 23 is not enforced anywhere** ([R118]). The semantic half
 * (is this tag/SHA an ancestor of a released engine tag) was recorded as living in
 * `oak validate`; it does not, and it could not: the composite action checks the engine out
 * AT the author's ref and runs `oak` from there, so a ref check inside the engine judges the
 * code it is already running. The enforcement point is the composite action, before the
 * checkout. What holds today is narrower: `ci/run.sh` refuses a ref carrying no
 * `dist/cli.cjs` ([R57]), which stops a branch tip but not a PR-merge ref that commits one.
 */

export type RefClass = 'tag' | 'sha' | 'pr-merge' | 'branch';

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const PR_MERGE = /^refs\/pull\/\d+\/merge$/;

export function classifyRef(ref: string): RefClass {
  if (SEMVER_TAG.test(ref)) return 'tag';
  if (FULL_SHA.test(ref)) return 'sha';
  if (PR_MERGE.test(ref)) return 'pr-merge';
  return 'branch';
}

export interface RefContext {
  /** true when the PR that triggered the build comes from a fork (no push rights). */
  isFork: boolean;
  /** maintainer allowlist override for dogfooding raw SHAs / PR-merge refs. */
  allowlisted?: boolean;
}

export interface RefDecision {
  allowed: boolean;
  refClass: RefClass;
  /** true when this class still needs the CI-side ancestry check before it's trusted. */
  needsAncestryCheck: boolean;
  reason: string;
}

/**
 * The floating-author path (design §6a, dec. 23):
 *  - `tag` / `branch` (engine default branch): always allowed *syntactically*, but must
 *    still pass the CI-side ancestry check (ancestor of a released tag / on default branch).
 *  - `sha` / `pr-merge`: allowed ONLY on non-fork PRs or a maintainer allowlist
 *    (engine-PR dogfooding); a fork must never point token-adjacent CI at raw code.
 */
export function decideRef(ref: string, ctx: RefContext): RefDecision {
  const refClass = classifyRef(ref);
  if (refClass === 'tag' || refClass === 'branch') {
    return {
      allowed: true,
      refClass,
      needsAncestryCheck: true,
      reason: `${refClass} accepted; ancestry check required before trust`,
    };
  }
  // sha | pr-merge: dogfooding only
  const permitted = !ctx.isFork || ctx.allowlisted === true;
  return {
    allowed: permitted,
    refClass,
    needsAncestryCheck: false,
    reason: permitted
      ? `${refClass} accepted for same-repo/allowlisted dogfooding`
      : `${refClass} refused from a fork PR (would run arbitrary engine code in CI)`,
  };
}
