/**
 * gh.ts — the git / GitHub side effects for the deposit verbs, kept out of zenodo.ts so the
 * deposit logic stays a pure, network-free unit under test. Implements `GitContext` (used by
 * the publish bundle) with plain `git` + `gh api`, and exposes the CLI-level GitHub effects
 * the port inherits from the workflows: the DOI PR ([R3]/§1d), the release bundle asset
 * ([R24]/§1e), the commit comment, and the failure issue.
 *
 * All of these shell out to `git`/`gh`. They are best-effort at the CLI edge: when `gh`/token
 * are absent (a local sandbox rehearsal), the caller degrades to just the Zenodo work + a
 * working-tree myst.yml write, which is enough for the slice-3 acceptance (a sandbox record).
 */
import { execFileSync, type StdioOptions } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitContext } from './zenodo.js';
import type { GhPr, PagesDeployer } from './preview.js';
import type { CheckRun } from './checks.js';
import type { Provisioner } from './bootstrap.js';
import type { UpgradePr } from './upgrade.js';
import type { ConformanceGh } from './conformance.js';

/**
 * `execFileSync` forwards the child's stderr to ours unless stdio says otherwise, so a probe
 * that treats failure as a valid answer still prints the failure. `quiet` pipes stderr into
 * the (discarded) result instead — use it only where the throw is caught and answered.
 */
const stdio = (quiet?: boolean): StdioOptions | undefined =>
  quiet ? ['pipe', 'pipe', 'pipe'] : undefined;

function git(repoRoot: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: stdio(opts.quiet),
  }).trim();
}

/** git without a `-C` (clone / raw), optionally in `cwd`. */
function gitRaw(args: string[], cwd?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}

function gh(args: string[], opts: { input?: string; cwd?: string; quiet?: boolean } = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input: opts.input,
    cwd: opts.cwd,
    stdio: stdio(opts.quiet),
  }).trim();
}

/** true when `gh api <path>` returns 2xx (idempotency GET probe). */
function ghOk(args: string[]): boolean {
  try {
    execFileSync('gh', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Commit-as-bot identity flags (a CI runner has no git identity — see openDoiPr). */
const BOT_ID = [
  '-c', 'user.name=github-actions[bot]',
  '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];

/** The real git/gh context injected into `cmdPublish`. */
export const realGitContext: GitContext = {
  async headSha(repoRoot) {
    return git(repoRoot, ['rev-parse', 'HEAD']);
  },
  async gitArchive(repoRoot, outZip) {
    git(repoRoot, ['archive', '--format=zip', '-o', outZip, 'HEAD']);
  },
  async reviewPr(repoRoot, sha) {
    // [R35.2]: read the PR associated with the tagged commit via the API, NOT a commit-subject
    // `#\d+` regex (any stray `#123` misattributes a value that gets deposited into provenance).
    const repo = originRepo(repoRoot);
    if (!repo) return null;
    try {
      // NOT quiet: "commit has no PR" exits 0 with empty output, so this catch is reached only
      // on a genuine gh failure (auth / network / rate limit) — and review_pr is deposited into
      // provenance, so that failure must stay visible rather than silently becoming null.
      const out = gh(['api', `repos/${repo}/commits/${sha}/pulls`, '--jq', '.[0].number // empty']);
      return out || null;
    } catch {
      return null;
    }
  },
};

/** owner/repo from the origin remote, or null. */
export function originRepo(repoRoot: string): string | null {
  try {
    const url = git(repoRoot, ['remote', 'get-url', 'origin'], { quiet: true });
    const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Open the reviewable DOI PR over the working-tree myst.yml write ([R3], replacing the
 * peter-evans action). Creates a branch, commits just myst.yml, pushes, and `gh pr create`s.
 * Returns the PR URL. Requires `GH_TOKEN`/`gh` auth (the §1d job supplies it).
 */
export function openDoiPr(repoRoot: string, opts: { conceptDoi: string }): string {
  // Version-agnostic branch: prepare only reserves the concept DOI (the version is the tag,
  // applied later at publish). Re-prepares force-push over the same branch.
  const branch = 'zenodo-doi';
  git(repoRoot, ['checkout', '-B', branch]);
  git(repoRoot, ['add', 'myst.yml']);
  // A CI runner has no git identity, so an inline one is required or `commit` fails with
  // "Author identity unknown" (the actions/checkout runner sets no user.name/email).
  git(repoRoot, [
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `chore: reserve Zenodo DOI ${opts.conceptDoi}`,
  ]);
  git(repoRoot, ['push', '-u', 'origin', branch, '--force']);
  return gh([
    'pr', 'create',
    '--title', 'Reserve Zenodo DOI',
    '--body', `Stamps the reserved concept DOI \`${opts.conceptDoi}\` into \`myst.yml\`. Merge before tagging.`,
    '--head', branch,
  ]);
}

/** Attach the deposit bundle files to the tag's GitHub Release ([R24] — durable past the
 *  30-day artifact retention, and puts the exact deposited bytes next to the tag). */
export function uploadReleaseAsset(repoRoot: string, tag: string, files: string[]): void {
  const repo = originRepo(repoRoot);
  const base = ['release', ...(repo ? ['--repo', repo] : [])];
  try {
    gh([...base, 'view', tag]);
  } catch {
    gh([...base, 'create', tag, '--title', tag, '--notes', 'Automated deposit bundle.']);
  }
  gh([...base, 'upload', tag, ...files, '--clobber']);
}

/** Sticky commit comment on the tagged commit (publish success). */
export function postCommitComment(repoRoot: string, sha: string, body: string): void {
  const repo = originRepo(repoRoot);
  if (!repo) return;
  gh(['api', `repos/${repo}/commits/${sha}/comments`, '-f', `body=${body}`]);
}

/** Open a failure issue (publish error), labelled for editor attention. */
export function openFailureIssue(repoRoot: string, title: string, body: string): void {
  const repo = originRepo(repoRoot);
  const base = ['issue', 'create', ...(repo ? ['--repo', repo] : [])];
  gh([...base, '--title', title, '--body', body, '--label', 'zenodo-publish-failed']);
}

/* --------------------------------------------------------------------------
 * preview.ts seams — the deploy-preview / notify GitHub effects ([R69])
 * ------------------------------------------------------------------------ */

/** The real git/gh PR context injected into `cmdDeployPreview` / the new-version reminder.
 *  Sticky comments are keyed on a hidden HTML marker so re-runs edit in place, not pile up. */
export const realGhPr: GhPr = {
  sticky(repoRoot, prNumber, header, body) {
    const repo = originRepo(repoRoot);
    if (!repo) return;
    const marker = `<!-- oak-sticky: ${header} -->`;
    // Find an existing sticky (its body opens with the marker) and edit it; else create.
    let existingId = '';
    try {
      existingId = gh([
        'api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate',
        '--jq', `[.[] | select(.body | startswith("${marker}"))] | last | .id // empty`,
      ]);
    } catch {
      /* no comments / no read access — fall through to create */
    }
    if (existingId) {
      gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existingId}`, '-F', 'body=@-'], { input: body });
    } else {
      gh(['api', '--method', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-F', 'body=@-'], { input: body });
    }
  },

  addLabel(repoRoot, prNumber, label, opts = {}) {
    const repo = originRepo(repoRoot);
    const scope = repo ? ['--repo', repo] : [];
    try {
      const create = ['label', 'create', label, ...scope];
      if (opts.color) create.push('--color', opts.color);
      if (opts.description) create.push('--description', opts.description);
      gh(create);
    } catch {
      /* label already exists — fine */
    }
    gh(['pr', 'edit', prNumber, ...scope, '--add-label', label]);
  },

  versionTags(_repoRoot, repo) {
    // The Stage-2 checkout is shallow, so `git tag --merged origin/main` sees no history —
    // read tags from the API instead ([R23]). `v*` filtered client-side.
    if (!repo) return [];
    try {
      const out = gh(['api', `repos/${repo}/tags`, '--paginate', '--jq', '.[].name']);
      return out.split('\n').map((t) => t.trim()).filter((t) => t.startsWith('v'));
    } catch {
      return [];
    }
  },
};

/** The real Cloudflare Pages deployer injected into `cmdDeployPreview`. Drives the CF Pages
 *  direct-upload protocol via wrangler (the same tool today's `wrangler-action` wraps) and
 *  parses the deployment URL from its output. Any failure throws — the caller degrades to an
 *  artifact-link comment rather than failing the run ([R16]). */
export const realPagesDeployer: PagesDeployer = {
  async deploy(opts) {
    const out = execFileSync(
      'npx',
      [
        '--yes', 'wrangler', 'pages', 'deploy', opts.dir,
        `--project-name=${opts.projectName}`,
        `--branch=${opts.branch}`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CLOUDFLARE_API_TOKEN: opts.apiToken, CLOUDFLARE_ACCOUNT_ID: opts.accountId },
      },
    );
    const m = /https?:\/\/[^\s]*\.pages\.dev[^\s]*/.exec(out);
    if (!m) throw new Error('wrangler did not report a *.pages.dev deployment URL');
    return m[0];
  },
};

/* --------------------------------------------------------------------------
 * checks.ts seam — the GitHub Check-Run reporter (slice 4). Posts the journal-check results
 * as a first-class Check Run: summary table + inline diff annotations (reporting option 2).
 * Needs `checks: write` (a trusted/base CI context, like the sticky comment).
 * ------------------------------------------------------------------------ */

export interface CheckRunPoster {
  create(repo: string, headSha: string, name: string, run: CheckRun): void;
}

export const realCheckRun: CheckRunPoster = {
  create(repo, headSha, name, run) {
    const body = JSON.stringify({
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion: run.conclusion,
      output: { title: run.title, summary: run.summary, annotations: run.annotations },
    });
    gh(['api', '--method', 'POST', `repos/${repo}/check-runs`, '--input', '-'], { input: body });
  },
};

/* --------------------------------------------------------------------------
 * bootstrap.ts seam — the GitHub/git provisioning (slice 5). Idempotent shells over
 * `gh api`/`git`, ported from create-submission-target.sh's `apply_rulesets_to_repo` +
 * repo-create/seed/ingest. Every mutation GET-then-acts; effects are injectable for tests.
 * ------------------------------------------------------------------------ */

export const realProvisioner: Provisioner = {
  ownerType(owner) {
    return gh(['api', `users/${owner}`, '--jq', '.type']) === 'Organization' ? 'Organization' : 'User';
  },
  repoExists(repo) {
    return ghOk(['api', `repos/${repo}`]);
  },
  createRepo(repo, opts) {
    gh(['repo', 'create', repo, opts.private ? '--private' : '--public', '--description', opts.description]);
  },
  branchExists(repo, branch) {
    return ghOk(['api', `repos/${repo}/branches/${branch}`]);
  },
  seedBranch(repo, branch, sourceDir, message) {
    // Clone the (empty) repo via gh so origin + auth come from the user's gh config (no
    // hardcoded transport), then bring the locally-rendered tree in, commit, and push.
    const tmp = mkdtempSync(join(tmpdir(), 'oak-seed-'));
    gh(['repo', 'clone', repo, tmp]);
    cpSync(sourceDir, tmp, { recursive: true });
    gitRaw(['checkout', '-B', branch], tmp);
    gitRaw(['add', '-A'], tmp);
    gitRaw([...BOT_ID, 'commit', '-m', message], tmp);
    gitRaw(['push', 'origin', `${branch}:${branch}`], tmp);
  },
  ingestReviewBranch(repo, opts) {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-ingest-'));
    gh(['repo', 'clone', repo, tmp]);
    gitRaw(['fetch', 'origin', 'main'], tmp);
    gitRaw(['fetch', opts.sourceUrl, opts.sourceRef], tmp);
    gitRaw(['checkout', '-B', 'review', 'origin/main'], tmp);
    gitRaw(['rm', '-rf', '.'], tmp);
    gitRaw(['checkout', 'FETCH_HEAD', '--', '.'], tmp);
    // NEW MODEL: restore the ENTIRE editor-side .github (not just workflows + CODEOWNERS) so
    // author FETCH_HEAD content can never supply the trust-boundary pins.yml.
    gitRaw(['checkout', 'origin/main', '--', '.github'], tmp);
    if (ghOk(['api', `repos/${repo}/contents/CODEOWNERS`])) {
      try {
        gitRaw(['checkout', 'origin/main', '--', 'CODEOWNERS'], tmp);
      } catch {
        /* CODEOWNERS may live under .github/ — already restored above */
      }
    }
    gitRaw(['add', '-A'], tmp);
    gitRaw([...BOT_ID, 'commit', '-m', opts.message], tmp);
    gitRaw(['push', 'origin', 'review'], tmp);
  },
  prExists(repo, head) {
    try {
      return Number(gh(['pr', 'list', '--repo', repo, '--head', head, '--json', 'number', '--jq', 'length'])) > 0;
    } catch {
      return false;
    }
  },
  openPr(repo, opts) {
    return gh([
      'api', `repos/${repo}/pulls`, '--method', 'POST',
      '--field', `title=${opts.title}`, '--field', `head=${opts.head}`,
      '--field', `base=${opts.base}`, '--field', `body=${opts.body}`,
      '--jq', '.html_url',
    ]);
  },
  grantTeamWrite(repo, team) {
    const [org, slug] = team.split('/');
    gh(['api', '-X', 'PUT', `orgs/${org}/teams/${slug}/repos/${repo}`, '-f', 'permission=push']);
  },
  teamId(team) {
    const [org, slug] = team.split('/');
    return Number(gh(['api', `orgs/${org}/teams/${slug}`, '--jq', '.id']));
  },
  rulesetExists(repo, name) {
    try {
      return gh(['api', `repos/${repo}/rulesets`, '--jq', `.[] | select(.name=="${name}") | .id`]) !== '';
    } catch {
      return false;
    }
  },
  createRuleset(repo, body) {
    gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], { input: JSON.stringify(body) });
  },
  pagesEnabled(repo) {
    return ghOk(['api', `repos/${repo}/pages`]);
  },
  enablePages(repo) {
    gh(['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'build_type=workflow']);
  },
  environmentExists(repo, name) {
    return ghOk(['api', `repos/${repo}/environments/${name}`]);
  },
  upsertEnvironment(repo, name) {
    gh([
      'api', '-X', 'PUT', `repos/${repo}/environments/${name}`,
      '--field', 'deployment_branch_policy[protected_branches]=false',
      '--field', 'deployment_branch_policy[custom_branch_policies]=true',
    ]);
  },
  branchPolicyExists(repo, env, name) {
    try {
      return (
        gh([
          'api', `repos/${repo}/environments/${env}/deployment-branch-policies`,
          '--jq', `.branch_policies[] | select(.name=="${name}") | .id`,
        ]) !== ''
      );
    } catch {
      return false;
    }
  },
  createBranchPolicy(repo, env, name, type) {
    gh([
      'api', '-X', 'POST', `repos/${repo}/environments/${env}/deployment-branch-policies`,
      '--field', `name=${name}`, '--field', `type=${type}`,
    ]);
  },
  createLabel(repo, name, opts) {
    const args = ['label', 'create', name, '--repo', repo, '--force'];
    if (opts.color) args.push('--color', opts.color);
    if (opts.description) args.push('--description', opts.description);
    try {
      gh(args);
    } catch {
      /* label already exists at this definition — fine */
    }
  },
  setSecret(repo, name, value) {
    gh(['secret', 'set', name, '--repo', repo, '--body', value]);
  },
  repoVisibility(repo) {
    return gh(['api', `repos/${repo}`, '--jq', '.visibility']) === 'private' ? 'private' : 'public';
  },
  setRepoPublic(repo) {
    gh(['api', '-X', 'PATCH', `repos/${repo}`, '-F', 'private=false']);
  },
};

/* --------------------------------------------------------------------------
 * upgrade.ts seams — target resolution, template materialization, the gated resync PR.
 * ------------------------------------------------------------------------ */

/** The authenticated gh user login (`gh api user`). */
export function authedUser(): string {
  return gh(['api', 'user', '--jq', '.login']);
}

/** Full clone of `repo` into a temp dir (origin set) for an in-repo upgrade. */
export function tempClone(repo: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'oak-upgrade-'));
  gh(['repo', 'clone', repo, tmp]);
  return tmp;
}

/** Latest engine release tag for `engineRepo` (`gh release list`). */
export function latestEngineRelease(engineRepo: string): string {
  const tag = gh(['release', 'list', '--repo', engineRepo, '--limit', '1', '--json', 'tagName', '--jq', '.[0].tagName']);
  if (!tag) throw new Error(`no releases found on ${engineRepo} — pass --to <tag>`);
  return tag;
}

/** Shallow-clone `engineRepo` at `tag` and return its `templates/paper/` path. `oak upgrade`
 *  only resyncs the frozen shim (`.github/` + `CODEOWNERS`), which lives in the paper template;
 *  instance-config data is tenant-owned and never resynced, so one root suffices. */
export function materializeTemplate(engineRepo: string, tag: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'oak-tmpl-'));
  gh(['repo', 'clone', engineRepo, tmp, '--', '--depth', '1', '--branch', tag]);
  return join(tmp, 'templates', 'paper');
}

/** The gated upgrade/resync PR — openDoiPr's branch→commit-as-bot→push→gh-pr-create shape. */
export const realUpgradePr: UpgradePr = {
  open(repoRoot, opts) {
    git(repoRoot, ['checkout', '-B', opts.branch]);
    git(repoRoot, ['add', ...opts.paths]);
    git(repoRoot, [...BOT_ID, 'commit', '-m', opts.title]);
    git(repoRoot, ['push', '-u', 'origin', opts.branch, '--force']);
    // Run `gh` inside the clone so it infers the target repo from origin (in CI the CWD is
    // already the repo; locally `oak upgrade` clones to a tmp dir, so pass cwd explicitly).
    return gh(['pr', 'create', '--title', opts.title, '--body', opts.body, '--head', opts.branch], { cwd: repoRoot });
  },
};

/** The real GitHub seam for `oak conformance` (slice C0: reset). Drives the fixture repos via
 *  the fixture-scoped PAT (gh reads GH_TOKEN). Deletes are DELETE-ref calls wrapped so an
 *  already-absent target is a no-op, not a throw. */
export const realConformanceGh: ConformanceGh = {
  listOpenPrs(repo, label) {
    // A not-yet-provisioned label makes `gh pr list --label` error; treat as no PRs.
    let out: string;
    try {
      out = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--label', label, '--json', 'number,headRefName'], { quiet: true });
    } catch {
      return [];
    }
    if (!out) return [];
    return (JSON.parse(out) as { number: number; headRefName: string }[]).map((p) => ({
      number: p.number,
      headRef: p.headRefName,
    }));
  },
  closePr(repo, prNumber) {
    gh(['pr', 'close', String(prNumber), '--repo', repo]);
  },
  listBranches(repo, prefix) {
    // matching-refs returns refs whose name starts with the given path (empty [] when none).
    const out = gh(['api', `repos/${repo}/git/matching-refs/heads/${prefix}`, '--jq', '.[].ref']);
    return out ? out.split('\n').map((r) => r.replace(/^refs\/heads\//, '')) : [];
  },
  deleteBranch(repo, branch) {
    ghOk(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`]);
  },
  listTags(repo, marker) {
    // No "contains" ref filter — list tags and match the middle marker in JS.
    const out = gh(['api', `repos/${repo}/tags`, '--paginate', '--jq', '.[].name']);
    return out ? out.split('\n').filter((t) => t.includes(marker)) : [];
  },
  deleteTag(repo, tag) {
    ghOk(['api', '-X', 'DELETE', `repos/${repo}/git/refs/tags/${tag}`]);
  },
  labelPr(repo, prNumber, label) {
    gh(['pr', 'edit', String(prNumber), '--repo', repo, '--add-label', label]);
  },
  prHeadSha(repo, prNumber) {
    return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid']);
  },
  mergePr(repo, prNumber) {
    gh(['pr', 'merge', String(prNumber), '--repo', repo, '--merge', '--delete-branch']);
    return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
  },
  workflowRunsForCommit(repo, sha) {
    const out = gh([
      'api',
      `repos/${repo}/actions/runs?head_sha=${sha}`,
      '--jq',
      '[.workflow_runs[] | {name, status, conclusion, url: .html_url, event}]',
    ]);
    return out ? (JSON.parse(out) as import('./conformance.js').WorkflowRun[]) : [];
  },
  checkRunsForCommit(repo, sha) {
    const out = gh(['api', `repos/${repo}/commits/${sha}/check-runs`, '--jq', '[.check_runs[] | {name, conclusion}]']);
    return out ? (JSON.parse(out) as import('./conformance.js').CheckRunRef[]) : [];
  },
  openCertPr(repo, branch, marker) {
    // Branch off main, then a trivial always-valid content change (a MyST `%` comment appended
    // to index.md) via the Contents API — no clone, so no git-credential dependency in CI.
    const mainSha = gh(['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha']);
    gh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${mainSha}`]);

    const meta = JSON.parse(gh(['api', `repos/${repo}/contents/index.md?ref=${branch}`, '--jq', '{content: .content, sha: .sha}'])) as {
      content: string;
      sha: string;
    };
    const current = Buffer.from(meta.content, 'base64').toString('utf8'); // GitHub wraps base64 in \n; Buffer ignores them
    const updated = Buffer.from(`${current}\n% conformance ${marker}\n`, 'utf8').toString('base64');
    gh([
      'api', '-X', 'PUT', `repos/${repo}/contents/index.md`,
      '-f', `message=conformance preview probe ${marker}`,
      '-f', `content=${updated}`,
      '-f', `sha=${meta.sha}`,
      '-f', `branch=${branch}`,
    ]);

    const url = gh([
      'pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
      '--title', `conformance preview ${marker}`,
      '--body', 'Automated conformance preview probe — opened and closed by the harness.',
    ]);
    const number = Number(url.split('/').pop());
    const headSha = gh(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']);
    return { number, headSha };
  },
  listIssueComments(repo, prNumber) {
    // A cert PR won't approach one page of comments, so no --paginate (which would concatenate
    // per-page JSON arrays into invalid JSON).
    const out = gh(['api', `repos/${repo}/issues/${prNumber}/comments`, '--jq', '[.[].body]']);
    return out ? (JSON.parse(out) as string[]) : [];
  },
};
