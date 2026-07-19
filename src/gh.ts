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
import { execFileSync } from 'node:child_process';
import type { GitContext } from './zenodo.js';
import type { GhPr, PagesDeployer } from './preview.js';
import type { CheckRun } from './checks.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function gh(args: string[], opts: { input?: string } = {}): string {
  return execFileSync('gh', args, { encoding: 'utf8', input: opts.input }).trim();
}

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
    const url = git(repoRoot, ['remote', 'get-url', 'origin']);
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
