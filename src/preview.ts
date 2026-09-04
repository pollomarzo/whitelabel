/**
 * preview.ts: the `deploy-preview` + `notify` verbs ([R16]/[R26]/[R27]).
 *
 * deploy-preview NEVER fails the run ([R16]): no secrets, a CF outage, or a bad journal.yml all
 * degrade to an artifact-link comment. It runs in trusted Stage 2, which holds the
 * `pull-requests: write` a fork-PR Stage 1 does not, so the new-version reminder rides here too.
 * Cloudflare and git/gh are injected seams (real impls in gh.ts); no myst-cli import.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDoc } from './yaml-io.js';
import * as msg from './messages.js';
import { annotate, firstLine, stickyMarker, UserError } from './messages.js';
import { JournalConfig, type PreviewConfig } from './schema.js';

/* --------------------------------------------------------------------------
 * Seams (implemented by gh.ts)
 * ------------------------------------------------------------------------ */

export interface PagesDeployer {
  /** Deploy a built site dir to Cloudflare Pages; resolves the deployment URL (impl in gh.ts). */
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
  /** `v*` tags via `gh api repos/{repo}/tags` ([R23]); the Stage-2 checkout is shallow.
   *  `repo` null ⇒ no tags. */
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
/** Here, not beside its issue, so `oak bootstrap` provisions the name `openFailureIssue` uses ([R127]). */
export const LABEL_ZENODO_FAILED = 'zenodo-publish-failed';

/* --------------------------------------------------------------------------
 * journal.yml → tenant preview config ([R27]), mirrors loadJournalZenodo
 * ------------------------------------------------------------------------ */

/** Read `preview:` from `<instanceRoot>/journal.yml`; absent or no instance ⇒ schema defaults.
 *  A parse failure is the tenant's fault and degrades rather than failing ([R16]/[R140]):
 *  `problem` carries the reason into the comment. */
export function loadJournalPreview(instanceRoot: string | null): {
  preview: PreviewConfig;
  problem?: string;
} {
  const empty = () => ({ preview: JournalConfig.parse({ name: 'x' }).preview });
  if (!instanceRoot) return empty();
  const path = join(instanceRoot, 'journal.yml');
  if (!existsSync(path)) return empty();
  try {
    return { preview: JournalConfig.parse(readDoc(path).toJS() ?? {}).preview };
  } catch (e) {
    return { ...empty(), problem: msg.workflow.previewBadJournal(path, firstLine(e)) };
  }
}

/* --------------------------------------------------------------------------
 * Pure logic
 * ------------------------------------------------------------------------ */

/** PR-number shape: the file is untrusted and the value reaches a `gh api` path ([R136]). */
const PR_NUMBER = /^[0-9]{1,10}$/;

/** Read and DELETE `.pr-number` ([R26]). null when absent (push/non-PR run); a present but
 *  malformed file throws, as a hostile artifact rather than an absent one ([R136]). */
export function takePrNumber(siteDir: string): string | null {
  const f = join(siteDir, '.pr-number');
  if (!existsSync(f)) return null;
  const n = readFileSync(f, 'utf8').trim();
  rmSync(f, { force: true });
  if (!n) return null;
  if (!PR_NUMBER.test(n)) throw new UserError(msg.workflow.previewBadPrNumber(n));
  return n;
}

/** The same shape check for a PR number reaching `oak notify` by flag or by file ([R136]). */
export function assertPrNumber(n: string): string {
  if (!PR_NUMBER.test(n)) throw new UserError(msg.workflow.previewBadPrNumber(n));
  return n;
}

/** Cloudflare Pages runs these from the deploy root: `_worker.js`/`functions/` are code,
 *  `_redirects`/`_headers`/`_routes.json` rewrite responses. A fork controls the artifact, so a
 *  new entry must be one of those two kinds ([R154]). */
const PAGES_CONTROL_FILES = [
  '_worker.js',
  'functions',
  '_routes.json',
  '_redirects',
  '_headers',
  '_middleware.js',
];

/** Remove Pages control files from the deploy root; returns the names removed ([R154]). */
export function stripPagesControlFiles(siteDir: string): string[] {
  const removed: string[] = [];
  for (const name of PAGES_CONTROL_FILES) {
    const p = join(siteDir, name);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

const BRANCH_MAX = 28;
const slug = (x: string): string =>
  x
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `{repo}`/`{pr}` → a Cloudflare-Pages branch alias (lowercase `[a-z0-9-]`, ≤28 chars).
 *  Spend the budget on `{repo}` last so a long name cannot truncate away `{pr}`, and hash a
 *  truncated name so two papers sharing one Pages project stay distinct ([R139]). */
export function previewBranch(pattern: string, repo: string, pr: string): string {
  const shortRepo = repo.includes('/') ? repo.slice(repo.indexOf('/') + 1) : repo;
  const withPr = pattern.replaceAll('{pr}', pr);
  const fixed = slug(withPr.replaceAll('{repo}', ''));
  const full = slug(shortRepo);
  let name = full;
  if (fixed.length + full.length > BRANCH_MAX) {
    const digest = createHash('sha256').update(full).digest('hex').slice(0, 4);
    const room = BRANCH_MAX - fixed.length - (digest.length + 1);
    name = room > 0 ? `${slug(full.slice(0, room))}-${digest}` : digest;
  }
  return slug(withPr.replaceAll('{repo}', name)).slice(0, BRANCH_MAX).replace(/-+$/g, '');
}

export type PreviewPlan =
  | { mode: 'cloudflare'; accountId: string; apiToken: string; projectName: string; branch: string }
  | { mode: 'artifact'; reason: string };

/** Deploy to Cloudflare, or degrade to an artifact link with a reason ([R6]): needs
 *  `provider: cloudflare`, both secrets, and a `cf_project_name`. */
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

export function previewComment(url: string): string {
  return [stickyMarker(STICKY_PREVIEW), msg.pr.previewDeployed(url)].join('\n');
}

export function artifactComment(runUrl: string, reason: string): string {
  return [stickyMarker(STICKY_PREVIEW), msg.pr.previewArtifact(runUrl, reason)].join('\n');
}

/** Zenodo record URL from a DOI prefix (sandbox `10.5072` vs prod `10.5281`); an unknown prefix
 *  returns an error the caller fails loud on, since a published paper's DOI must parse. */
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
  return [stickyMarker(STICKY_NEWVERSION), msg.pr.newVersionReminder(doi, recordUrl)].join('\n');
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

/** `oak deploy-preview <site>` ([R16]): serve the inert Stage-1 artifact at a preview URL (or
 *  degrade to an artifact-link comment) and post it to the PR. Never fails the run; a missing
 *  `.pr-number` no-ops. Observable behaviour: DOCS.deployPreview. */
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

  // Strip fork-controlled Pages control files before any deploy path ([R154]).
  const stripped = stripPagesControlFiles(siteDir);
  if (stripped.length)
    process.stderr.write(annotate('warning', msg.workflow.previewStripped(stripped)) + '\n');

  const { preview, problem } = loadJournalPreview(instanceRoot);
  if (problem) process.stderr.write(annotate('warning', problem) + '\n');
  // Deep-link the Paper CI run holding the artifact (workflow_run.id), else the Actions tab.
  const runUrl = input.artifactRunId
    ? `${serverUrl}/${repo ?? ''}/actions/runs/${input.artifactRunId}`
    : `${serverUrl}/${repo ?? ''}/actions`;
  const plan = problem
    ? ({ mode: 'artifact', reason: problem } as PreviewPlan)
    : planPreview({ preview, cf, repo: repo ?? 'paper', pr });

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
      // The one [R16] degrade: a CF failure still leaves the reviewer the artifact link. Not
      // error-swallowing, it posts a different useful comment; a gh failure below is NOT degraded,
      // it throws.
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

  // The new-version reminder rides here (base context holds pull-requests: write, [R16]); its
  // failure propagates.
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

/** The new-version reminder ([R16]/[R23]): on an already-published paper, post a sticky reminder
 *  + label. First deposit (no tags) no-ops. A `v*` tag with an absent or unparseable DOI is
 *  "published but unlinked" and stays a hard error (exit 1), not papered over. */
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
