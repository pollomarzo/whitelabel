/**
 * preview.ts: the `deploy-preview` + `notify` verbs (slice 2-shim). Ports today's
 * `maybe_preview-deploy.yml` + `notify-newversion.yml` into the engine, with the design's
 * corrections baked in:
 *
 *  - **Preview provider is a journal knob ([R6]/[R27]).** Cloudflare project name + preview
 *    branch pattern (hardcoded `oaktree-sapling` / `pr-<n>` today) come from `journal.yml`
 *    `preview:`; a tenant with no Cloudflare secrets DEGRADES to an artifact-link comment
 *    instead of failing: deploy-preview NEVER fails the run ([R16]).
 *  - **`.pr-number` is stripped before serving ([R26]).** Stage 1 stashes the PR number in
 *    the artifact (workflow_run.pull_requests is empty for forks); Stage 2 reads it and
 *    DELETES it before the deploy, or it ships as a publicly served file on the preview.
 *  - **The new-version reminder runs in Stage 2 ([R16]).** Its sticky comment + label need
 *    `pull-requests: write`, which fork-PR Stage-1 runs never hold; base-context Stage 2 does,
 *    and everything it reads (base tags, base `myst.yml` doi) is base-repo context. So
 *    deploy-preview invokes it internally after posting the preview comment (and `oak notify
 *    new-version` exposes the same logic standalone).
 *  - **Tags are read without full history ([R23]).** Today's notify reads
 *    `git tag --merged origin/main 'v*'` on a `fetch-depth: 0` checkout; the Stage-2 checkout
 *    is shallow (no tag history), so the `versionTags` seam reads them from `gh api .../tags`.
 *
 * SEAMS (so the logic is unit-testable with no network / no git): the Cloudflare deploy
 * (`PagesDeployer`) and the git/gh side (`GhPr`) are injected; the real implementations live
 * in `gh.ts` (mirroring `zenodo.ts`'s `ZenodoTransport` + `GitContext`). This module does NOT
 * import myst-cli: it only reads the built artifact + `journal.yml`.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readDoc } from './yaml-io.js';
import * as msg from './messages.js';
import { annotate } from './messages.js';
import { JournalConfig, type PreviewConfig } from './schema.js';

/* --------------------------------------------------------------------------
 * Seams (implemented by gh.ts)
 * ------------------------------------------------------------------------ */

export interface PagesDeployer {
  /** Deploy a built site directory to Cloudflare Pages; resolves the deployment URL. The real
   *  impl drives the CF Pages direct-upload protocol (via wrangler); see gh.ts. */
  deploy(opts: {
    dir: string;
    accountId: string;
    apiToken: string;
    projectName: string;
    branch: string;
  }): Promise<string>;
}

export interface GhPr {
  /** Upsert a sticky comment (keyed by `header`) on a PR, create, else edit in place. */
  sticky(repoRoot: string, prNumber: string, header: string, body: string): void;
  /** Add a label to a PR, creating the label first if it does not exist. */
  addLabel(
    repoRoot: string,
    prNumber: string,
    label: string,
    opts?: { color?: string; description?: string },
  ): void;
  /** `v*` tags, read from `gh api repos/{repo}/tags` ([R23]): the Stage-2 checkout is shallow,
   *  so `git tag --merged origin/main` has no history to see. `repo` may be null (⇒ no tags). */
  versionTags(repoRoot: string, repo: string | null): string[];
}

/* --------------------------------------------------------------------------
 * Result envelope (mirrors zenodo.ts, the workflows' `status` contract)
 * ------------------------------------------------------------------------ */

export interface Outcome {
  exitCode: number;
  result: Record<string, unknown>;
}
const ok = (fields: Record<string, unknown>): Outcome => ({
  exitCode: 0,
  result: { status: 'ok', ...fields },
});
const err = (exitCode: number, message: string, fields: Record<string, unknown> = {}): Outcome => ({
  exitCode,
  result: { status: 'error', message, ...fields },
});

/* --------------------------------------------------------------------------
 * Sticky-comment headers + labels (stable identifiers, do not rename)
 * ------------------------------------------------------------------------ */

export const STICKY_PREVIEW = 'oak-preview';
export const STICKY_NEWVERSION = 'zenodo-newversion-reminder';
export const LABEL_EDITOR_ACTION = 'editor-action-needed';
/** Here rather than beside the issue that carries it, so `oak bootstrap` provisions the name
 *  `openFailureIssue` asks for ([R127]). */
export const LABEL_ZENODO_FAILED = 'zenodo-publish-failed';

/* --------------------------------------------------------------------------
 * journal.yml → tenant preview config ([R27]), mirrors loadJournalZenodo
 * ------------------------------------------------------------------------ */

/** Read the tenant's `preview:` block from `<instanceRoot>/journal.yml`. A fresh tenant (or a
 *  build with no instance) has none, return the schema defaults (`provider: artifact`). */
export function loadJournalPreview(instanceRoot: string | null): PreviewConfig {
  const empty = () => JournalConfig.parse({ name: 'x' }).preview;
  if (!instanceRoot) return empty();
  const path = join(instanceRoot, 'journal.yml');
  if (!existsSync(path)) return empty();
  return JournalConfig.parse(readDoc(path).toJS() ?? {}).preview;
}

/* --------------------------------------------------------------------------
 * Pure logic
 * ------------------------------------------------------------------------ */

/** Read `.pr-number` from the build dir and DELETE it ([R26]) so it never serves publicly.
 *  Returns null when absent (a push build, or a non-PR run); the caller then no-ops. */
export function takePrNumber(siteDir: string): string | null {
  const f = join(siteDir, '.pr-number');
  if (!existsSync(f)) return null;
  const n = readFileSync(f, 'utf8').trim();
  rmSync(f, { force: true });
  return n || null;
}

/** Apply `{repo}`/`{pr}` placeholders in the preview branch pattern, then slugify to a
 *  Cloudflare-Pages-safe branch alias (lowercase, `[a-z0-9-]`, ≤28 chars). `repo` may be
 *  `owner/name`: only the short name is used. */
export function previewBranch(pattern: string, repo: string, pr: string): string {
  const shortRepo = repo.includes('/') ? repo.slice(repo.indexOf('/') + 1) : repo;
  return pattern
    .replaceAll('{repo}', shortRepo)
    .replaceAll('{pr}', pr)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/g, '');
}

export type PreviewPlan =
  | { mode: 'cloudflare'; accountId: string; apiToken: string; projectName: string; branch: string }
  | { mode: 'artifact'; reason: string };

/** Decide whether to deploy to Cloudflare or degrade to an artifact link ([R6]). Cloudflare
 *  needs `provider: cloudflare` AND both secrets AND a `cf_project_name`; anything short of
 *  that degrades with a reason (never an error). */
export function planPreview(input: {
  preview: PreviewConfig;
  cf: { apiToken?: string; accountId?: string };
  repo: string;
  pr: string;
}): PreviewPlan {
  const { preview, cf, repo, pr } = input;
  if (preview.provider !== 'cloudflare') {
    return { mode: 'artifact', reason: msg.workflow.previewProviderIsNot(preview.provider) };
  }
  if (!cf.apiToken || !cf.accountId) {
    return { mode: 'artifact', reason: msg.workflow.previewNoCloudflareSecrets };
  }
  if (!preview.cf_project_name) {
    return { mode: 'artifact', reason: msg.workflow.previewNoProjectName };
  }
  return {
    mode: 'cloudflare',
    accountId: cf.accountId,
    apiToken: cf.apiToken,
    projectName: preview.cf_project_name,
    branch: previewBranch(preview.branch_pattern, repo, pr),
  };
}

const STICKY_MARK = (header: string): string => `<!-- oak-sticky: ${header} -->`;

export function previewComment(url: string): string {
  return [STICKY_MARK(STICKY_PREVIEW), msg.pr.previewDeployed(url)].join('\n');
}

export function artifactComment(runUrl: string, reason: string): string {
  return [STICKY_MARK(STICKY_PREVIEW), msg.pr.previewArtifact(runUrl, reason)].join('\n');
}

/** Parse the Zenodo record URL from a concept DOI prefix (sandbox `10.5072` vs prod `10.5281`).
 *  Returns an error string for an unrecognized prefix; the caller fails loud, matching today's
 *  notify (a published paper with an unparseable DOI is an inconsistent state). */
export function recordUrlForDoi(
  doi: string,
): { doi: string; recordUrl: string } | { error: string } {
  const map: Array<[string, string]> = [
    ['10.5072/zenodo.', 'https://sandbox.zenodo.org/records/'],
    ['10.5281/zenodo.', 'https://zenodo.org/records/'],
  ];
  for (const [prefix, base] of map) {
    if (doi.startsWith(prefix)) return { doi, recordUrl: `${base}${doi.slice(prefix.length)}` };
  }
  return { error: msg.workflow.notifyBadDoi(doi) };
}

/** Whether the paper already has a published `v*` tag (⇒ a new-version reminder is due). */
export function hasVersionTag(tags: string[]): boolean {
  return tags.some((t) => /^v/.test(t.trim()));
}

export function newVersionComment(doi: string, recordUrl: string): string {
  return [STICKY_MARK(STICKY_NEWVERSION), msg.pr.newVersionReminder(doi, recordUrl)].join('\n');
}

/* --------------------------------------------------------------------------
 * Orchestration
 * ------------------------------------------------------------------------ */

export interface DeployPreviewInput {
  siteDir: string;
  repoRoot: string;
  instanceRoot: string | null;
  /** GITHUB_REPOSITORY (owner/repo), GITHUB_SERVER_URL, used for the degrade link + labels. */
  repo: string | null;
  serverUrl: string;
  /** The Paper CI run id (workflow_run.id) holding the paper-build artifact, deep-links the
   *  degrade comment straight to that run, not the whole Actions tab. */
  artifactRunId?: string;
  cf: { apiToken?: string; accountId?: string };
  /** myst.yml path in base context (for the notify DOI read). */
  mystPath: string;
}

export interface PreviewDeps {
  deployer: PagesDeployer;
  gh: GhPr;
}

/**
 * `oak deploy-preview <site>`: read+strip `.pr-number`, deploy the inert artifact to
 * Cloudflare Pages (or degrade to an artifact-link comment), post the sticky preview comment,
 * then run the new-version reminder ([R16]). NEVER fails the run: a Cloudflare error degrades
 * to the artifact comment, and a missing `.pr-number` no-ops.
 */
export async function cmdDeployPreview(
  input: DeployPreviewInput,
  deps: PreviewDeps,
): Promise<Outcome> {
  const { siteDir, repoRoot, instanceRoot, repo, serverUrl, cf, mystPath } = input;
  const pr = takePrNumber(siteDir);
  if (!pr) {
    process.stderr.write(msg.workflow.noPrNumber + '\n');
    return ok({ preview: 'skipped', reason: msg.workflow.previewNoPrNumberReason });
  }

  const preview = loadJournalPreview(instanceRoot);
  // Deep-link the specific Paper CI run that holds the paper-build artifact (Stage 2 knows it as
  // workflow_run.id); fall back to the Actions tab when it wasn't passed (e.g. a local run).
  const runUrl = input.artifactRunId
    ? `${serverUrl}/${repo ?? ''}/actions/runs/${input.artifactRunId}`
    : `${serverUrl}/${repo ?? ''}/actions`;
  const plan = planPreview({ preview, cf, repo: repo ?? 'paper', pr });

  let outcome: Record<string, unknown>;
  if (plan.mode === 'cloudflare') {
    try {
      const url = await deps.deployer.deploy({
        dir: siteDir,
        accountId: plan.accountId,
        apiToken: plan.apiToken,
        projectName: plan.projectName,
        branch: plan.branch,
      });
      deps.gh.sticky(repoRoot, pr, STICKY_PREVIEW, previewComment(url));
      outcome = { preview: 'cloudflare', url, branch: plan.branch };
    } catch (e) {
      // The ONE meaningful degrade ([R16]): a CF outage / missing secrets still leaves the
      // reviewer the artifact. This is not error-swallowing; it posts a different, useful
      // comment. A gh failure below is NOT degraded: it throws and fails the run, loudly.
      const failure = (e as Error).message;
      process.stderr.write(annotate('warning', msg.workflow.cloudflareDegraded(failure)) + '\n');
      deps.gh.sticky(
        repoRoot,
        pr,
        STICKY_PREVIEW,
        artifactComment(runUrl, msg.workflow.cloudflareDegradedReason(failure)),
      );
      outcome = {
        preview: 'artifact',
        reason: msg.workflow.previewCloudflareFailedReason(failure),
      };
    }
  } else {
    deps.gh.sticky(repoRoot, pr, STICKY_PREVIEW, artifactComment(runUrl, plan.reason));
    outcome = { preview: 'artifact', reason: plan.reason };
  }

  // The new-version reminder rides here, base context holds pull-requests: write ([R16]).
  // Its failure (a real "published but unlinked" inconsistency, or a gh error) propagates.
  const notify = runNewVersionReminder({ repoRoot, mystPath, repo, pr }, deps.gh);
  return {
    exitCode: notify.exitCode,
    result: { status: notify.result.status, ...outcome, notify: notify.result },
  };
}

export interface NotifyInput {
  repoRoot: string;
  mystPath: string;
  repo: string | null;
  /** The PR to comment on. deploy-preview passes the number it already read+stripped. */
  pr: string;
}

/**
 * The new-version reminder ([R16]/[R23]). Reads `v*` tags (via `gh api`, the Stage-2 checkout
 * is shallow) and, when the paper is already published, posts a sticky reminder + label.
 *
 * First deposit (no tags) is a clean no-op. A `v*` tag with an absent/unparseable DOI is the
 * "published but unlinked" inconsistency the original `notify-newversion.yml` `exit 1`s on; we
 * keep it a hard error (exit 1): it's a real repo-state problem, not something to paper over.
 * gh comment/label failures propagate too. (The only [R16] degrade is CF→artifact, upstream.)
 */
export function runNewVersionReminder(input: NotifyInput, gh: GhPr): Outcome {
  const { repoRoot, mystPath, repo, pr } = input;
  let tags: string[];
  try {
    tags = gh.versionTags(repoRoot, repo);
  } catch (e) {
    // An unreadable tag list must not read as "never published" ([R108]).
    const why = String((e as Error).message ?? e);
    process.stderr.write(annotate('error', msg.workflow.notifyTagsFailed(why)) + '\n');
    return err(1, why, { reminder: 'error' });
  }
  if (!hasVersionTag(tags)) {
    return ok({ reminder: 'skipped', reason: msg.workflow.notifyFirstDeposit });
  }

  const doi = readProjectDoi(mystPath);
  if (!doi) {
    process.stderr.write(annotate('error', msg.workflow.notifyPublishedButUnlinked) + '\n');
    return err(1, 'v* tag present but project.doi missing', { reminder: 'error' });
  }
  const parsed = recordUrlForDoi(doi);
  if ('error' in parsed) {
    process.stderr.write(annotate('error', `notify: ${parsed.error}`) + '\n');
    return err(1, parsed.error, { reminder: 'error' });
  }

  gh.sticky(repoRoot, pr, STICKY_NEWVERSION, newVersionComment(parsed.doi, parsed.recordUrl));
  gh.addLabel(repoRoot, pr, LABEL_EDITOR_ACTION, {
    color: 'b60205',
    description: msg.bootstrap.labelEditorAction,
  });
  return ok({ reminder: 'posted', record_url: parsed.recordUrl, doi: parsed.doi });
}

/** `project.doi` from a myst.yml, or null. */
function readProjectDoi(mystPath: string): string | null {
  if (!existsSync(mystPath)) return null;
  const doi = readDoc(mystPath).getIn(['project', 'doi']);
  return typeof doi === 'string' && doi ? doi : null;
}
