/**
 * gh.ts: the git / GitHub side effects for the deposit verbs, kept out of zenodo.ts so the
 * deposit logic stays a pure, network-free unit under test. Implements `GitContext` (used by
 * the publish bundle) with plain `git` + `gh api`, and exposes the CLI-level GitHub effects
 * the port inherits from the workflows: the DOI PR ([R3]/§1d), the release bundle asset
 * ([R24]/§1e), the commit comment, and the failure issue.
 *
 * All of these shell out to `git`/`gh`. They are best-effort at the CLI edge: when `gh`/token
 * are absent (a local sandbox rehearsal), the caller degrades to just the Zenodo work + a
 * working-tree myst.yml write, which is enough for the slice-3 acceptance (a sandbox record).
 */
import * as msg from './messages.js';
import { UserError } from './messages.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { GitContext } from './zenodo.js';
import type { GhPr, PagesDeployer } from './preview.js';
import type { CheckRun } from './checks.js';
import type { Provisioner } from './bootstrap.js';
import type { UpgradePr } from './upgrade.js';
import type { ConformanceGh } from './conformance.js';

/**
 * All git/gh chatter is CAPTURED, not inherited. `execFileSync` otherwise forwards the child's
 * stderr straight to ours, and the result was a bootstrap transcript where "Cloning into
 * '/tmp/oak-seed-…'", "warning: You appear to have cloned an empty repository" and our own
 * plan lines were indistinguishable: the reader cannot tell what the tool did from what a
 * tool it called said about itself.
 *
 * So: quiet on success, and on FAILURE the captured text is replayed with the tool's name in
 * front of every line, because that is exactly when it is the most useful thing on screen.
 * `--verbose` (via `OAK_VERBOSE`) replays it on success too, and CI is verbose by default:
 * a workflow log is read after the fact, by someone who cannot re-run it with a flag.
 */
function verboseChildren(): boolean {
  return Boolean(process.env.OAK_VERBOSE || process.env.CI);
}

/** Replay a child's captured output with its provenance on every line. */
export function labelChildOutput(tool: string, text: unknown): string {
  return String(text ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => `  [${tool}] ${l}`)
    .join('\n');
}

function echoChild(tool: string, text: unknown): void {
  const labelled = labelChildOutput(tool, text);
  if (labelled) process.stderr.write(labelled + '\n');
}

/**
 * Show what is running while it runs, then take the line back.
 *
 * Capturing the children's output ([R85]) bought a clean screen and paid for it in silence:
 * creating a repo, cloning, resolving the newest release are each seconds of nothing, and the
 * UX test read that as a hang. `spawnSync` blocks the event loop, so a spinner cannot animate,
 * but a line printed BEFORE the call and erased after needs no timer, and says the true thing.
 *
 * TTY only: erasing with `\r` in a redirected log or a workflow log would leave the marker
 * stranded mid-line, and CI already prints every child's output anyway.
 */
function showWorking(tool: string, args: string[]): () => void {
  if (!process.stderr.isTTY || verboseChildren()) return () => {};
  process.stderr.write(
    msg.workflow.working(
      `${tool} ${args
        .filter((a) => !a.startsWith('-'))
        .slice(0, 2)
        .join(' ')}`,
    ),
  );
  return () => process.stderr.write('\r\u001b[K');
}

/**
 * Run `git`/`gh` with both streams captured. `quiet` means "not even on failure", for the
 * probes that treat a non-zero exit as a valid answer (does this ruleset exist?), where the
 * child's complaint is noise about a question we already answered.
 */
function run(
  tool: 'git' | 'gh',
  args: string[],
  opts: { input?: string; cwd?: string; quiet?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const done = showWorking(tool, args);
  // spawnSync, not execFileSync: capturing stderr AND being able to replay it needs the
  // stream back in hand, which execFileSync only gives us on the failure path.
  const r = spawnSync(tool, args, {
    encoding: 'utf8',
    input: opts.input,
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.env ? { env: opts.env } : {}),
  });
  done();
  if (r.error) throw r.error;
  if (r.status !== 0) {
    if (!opts.quiet) echoChild(tool, r.stderr || r.stdout);
    const first =
      String(r.stderr || r.stdout || '')
        .split('\n')
        .find((l) => l.trim() !== '') ?? '';
    const err = new Error(
      `${tool} ${args[0] ?? ''} failed (exit ${r.status ?? `signal ${r.signal}`})${first ? `: ${first.trim()}` : ''}`,
    ) as Error & { status: number | null; stdout: string; stderr: string };
    err.status = r.status;
    err.stdout = String(r.stdout ?? '');
    err.stderr = String(r.stderr ?? '');
    throw err;
  }
  if (verboseChildren()) echoChild(tool, r.stderr);
  return String(r.stdout ?? '').trim();
}

function git(repoRoot: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return run('git', ['-C', repoRoot, ...args], opts);
}

/** git without a `-C` (clone / raw), optionally in `cwd`. */
function gitRaw(args: string[], cwd?: string): string {
  return run('git', args, { cwd });
}

function gh(args: string[], opts: { input?: string; cwd?: string; quiet?: boolean } = {}): string {
  return run('gh', args, opts);
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

/** `gh` run under a DIFFERENT token (the fork account's PAT), same shape as `gh()`, but the
 *  child sees `GH_TOKEN=token`. The conformance fork phase owns a second-account fork; base-repo
 *  ops keep using `gh()` (the ambient primary token), fork-repo ops use `ghAs(forkToken, …)`. */
function ghAs(
  token: string,
  args: string[],
  opts: { input?: string; cwd?: string; quiet?: boolean } = {},
): string {
  return run('gh', args, { ...opts, env: { ...process.env, GH_TOKEN: token } });
}

/** Tolerant `ghAs`: the fork-token twin of `ghOk` (an already-absent ref DELETE is a no-op). */
function ghOkAs(token: string, args: string[]): boolean {
  try {
    execFileSync('gh', args, { stdio: 'ignore', env: { ...process.env, GH_TOKEN: token } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Both reach `git fetch` positionally, and git parses options positionally, so a ref of
 * `--upload-pack=<command>` RUNS it ([R103]). Hence an allowlist of the two transports we
 * support, not a screen for `-`: `ext::` spells the same attack. Userinfo is refused rather than
 * stripped because `--from` is copied into a public commit message.
 */
const INGEST_URL =
  /^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?\/?$/;
const INGEST_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

export function assertIngestSource(sourceUrl: string, sourceRef: string): void {
  if (!INGEST_URL.test(sourceUrl)) throw new UserError(msg.bootstrap.ingestBadUrl(sourceUrl));
  if (!INGEST_REF.test(sourceRef) || sourceRef.includes('..')) {
    throw new UserError(msg.bootstrap.ingestBadRef(sourceRef));
  }
}

/** Commit-as-bot identity flags (a CI runner has no git identity; see openDoiPr). */
const BOT_ID = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
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
      // on a genuine gh failure (auth / network / rate limit), and review_pr is deposited into
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
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    `chore: reserve Zenodo DOI ${opts.conceptDoi}`,
  ]);
  git(repoRoot, ['push', '-u', 'origin', branch, '--force']);
  return gh([
    'pr',
    'create',
    '--title',
    'Reserve Zenodo DOI',
    '--body',
    `Stamps the reserved concept DOI \`${opts.conceptDoi}\` into \`myst.yml\`. Merge before tagging.`,
    '--head',
    branch,
  ]);
}

/** Attach the deposit bundle files to the tag's GitHub Release ([R24], durable past the
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
 * preview.ts seams: the deploy-preview / notify GitHub effects ([R69])
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
        'api',
        `repos/${repo}/issues/${prNumber}/comments`,
        '--paginate',
        '--jq',
        `[.[] | select(.body | startswith("${marker}"))] | last | .id // empty`,
      ]);
    } catch {
      /* no comments / no read access: fall through to create */
    }
    if (existingId) {
      gh(
        [
          'api',
          '--method',
          'PATCH',
          `repos/${repo}/issues/comments/${existingId}`,
          '-F',
          'body=@-',
        ],
        { input: body },
      );
    } else {
      gh(
        ['api', '--method', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-F', 'body=@-'],
        { input: body },
      );
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
      /* label already exists: fine */
    }
    gh(['pr', 'edit', prNumber, ...scope, '--add-label', label]);
  },

  versionTags(_repoRoot, repo) {
    // The Stage-2 checkout is shallow, so `git tag --merged origin/main` sees no history,
    // read tags from the API instead ([R23]). `v*` filtered client-side.
    if (!repo) return [];
    try {
      const out = gh(['api', `repos/${repo}/tags`, '--paginate', '--jq', '.[].name']);
      return out
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t.startsWith('v'));
    } catch {
      return [];
    }
  },
};

/** The real Cloudflare Pages deployer injected into `cmdDeployPreview`. Drives the CF Pages
 *  direct-upload protocol via wrangler (the same tool today's `wrangler-action` wraps) and
 *  parses the deployment URL from its output. Any failure throws; the caller degrades to an
 *  artifact-link comment rather than failing the run ([R16]). */
export const realPagesDeployer: PagesDeployer = {
  async deploy(opts) {
    // stderr inherited, not captured: a captured child's stderr joins the error message, which
    // preview.ts posts publicly, and wrangler's names the account id ([R104]).
    let out: string;
    try {
      out = execFileSync(
        'npx',
        [
          '--yes',
          'wrangler',
          'pages',
          'deploy',
          opts.dir,
          `--project-name=${opts.projectName}`,
          `--branch=${opts.branch}`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: opts.apiToken,
            CLOUDFLARE_ACCOUNT_ID: opts.accountId,
          },
        },
      );
    } catch {
      throw new Error(msg.workflow.wranglerFailed);
    }
    const m = /https?:\/\/[^\s]*\.pages\.dev[^\s]*/.exec(out);
    if (!m) throw new Error(msg.workflow.wranglerNoUrl);
    return m[0];
  },
};

/* --------------------------------------------------------------------------
 * checks.ts seam: the GitHub Check-Run reporter (slice 4). Posts the journal-check results
 * as a first-class Check Run: summary table + inline diff annotations (reporting option 2).
 * Needs `checks: write` (a trusted/base CI context, like the sticky comment).
 * ------------------------------------------------------------------------ */

export interface CheckRunPoster {
  create(repo: string, headSha: string, name: string, run: CheckRun): void;
}

/** Files changed between `base` and `head` per the compare API. Called from check-post in
 *  trusted base context, with `head` taken from `github.event.workflow_run.head_sha` (GitHub-set,
 *  not the fork-controlled artifact) so the frozen-shim advisory cannot be dodged. Best-effort:
 *  returns [] on any error so the advisory never fails the post. */
export function changedFiles(repo: string, base: string, head: string): string[] {
  try {
    const out = gh(
      ['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.files[].filename'],
      { quiet: true },
    );
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
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
 * bootstrap.ts seam: the GitHub/git provisioning (slice 5). Idempotent shells over
 * `gh api`/`git`, ported from create-submission-target.sh's `apply_rulesets_to_repo` +
 * repo-create/seed/ingest. Every mutation GET-then-acts; effects are injectable for tests.
 * ------------------------------------------------------------------------ */

export const realProvisioner: Provisioner = {
  ownerType(owner) {
    return gh(['api', `users/${owner}`, '--jq', '.type']) === 'Organization'
      ? 'Organization'
      : 'User';
  },
  repoExists(repo) {
    return ghOk(['api', `repos/${repo}`]);
  },
  createRepo(repo, opts) {
    gh([
      'repo',
      'create',
      repo,
      opts.private ? '--private' : '--public',
      '--description',
      opts.description,
    ]);
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
    assertIngestSource(opts.sourceUrl, opts.sourceRef);
    const tmp = mkdtempSync(join(tmpdir(), 'oak-ingest-'));
    gh(['repo', 'clone', repo, tmp]);
    gitRaw(['fetch', 'origin', 'main'], tmp);
    gitRaw(['fetch', opts.sourceUrl, opts.sourceRef], tmp);
    gitRaw(['checkout', '-B', 'review', 'origin/main'], tmp);
    gitRaw(['rm', '-rf', '.'], tmp);
    gitRaw(['checkout', 'FETCH_HEAD', '--', '.'], tmp);
    // DELETE then restore. `git checkout <tree> -- .github` overwrites the paths that tree has
    // and leaves the rest, so an author file at a path main lacks survived onto a branch pushed
    // to the BASE repo with our credentials ([R121]).
    gitRaw(['rm', '-rqf', '--ignore-unmatch', '--', '.github'], tmp);
    gitRaw(['checkout', 'origin/main', '--', '.github'], tmp);
    if (ghOk(['api', `repos/${repo}/contents/CODEOWNERS`])) {
      try {
        gitRaw(['checkout', 'origin/main', '--', 'CODEOWNERS'], tmp);
      } catch {
        /* CODEOWNERS may live under .github/, already restored above */
      }
    }
    gitRaw(['add', '-A'], tmp);
    gitRaw([...BOT_ID, 'commit', '-m', opts.message], tmp);
    gitRaw(['push', 'origin', 'review'], tmp);
  },
  prExists(repo, head) {
    try {
      return (
        Number(
          gh(['pr', 'list', '--repo', repo, '--head', head, '--json', 'number', '--jq', 'length']),
        ) > 0
      );
    } catch {
      return false;
    }
  },
  openPr(repo, opts) {
    return gh([
      'api',
      `repos/${repo}/pulls`,
      '--method',
      'POST',
      '--field',
      `title=${opts.title}`,
      '--field',
      `head=${opts.head}`,
      '--field',
      `base=${opts.base}`,
      '--field',
      `body=${opts.body}`,
      '--jq',
      '.html_url',
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
      return (
        gh(['api', `repos/${repo}/rulesets`, '--jq', `.[] | select(.name=="${name}") | .id`]) !== ''
      );
    } catch {
      return false;
    }
  },
  createRuleset(repo, body) {
    gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], {
      input: JSON.stringify(body),
    });
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
      'api',
      '-X',
      'PUT',
      `repos/${repo}/environments/${name}`,
      '--field',
      'deployment_branch_policy[protected_branches]=false',
      '--field',
      'deployment_branch_policy[custom_branch_policies]=true',
    ]);
  },
  branchPolicyExists(repo, env, name) {
    try {
      return (
        gh([
          'api',
          `repos/${repo}/environments/${env}/deployment-branch-policies`,
          '--jq',
          `.branch_policies[] | select(.name=="${name}") | .id`,
        ]) !== ''
      );
    } catch {
      return false;
    }
  },
  createBranchPolicy(repo, env, name, type) {
    gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/environments/${env}/deployment-branch-policies`,
      '--field',
      `name=${name}`,
      '--field',
      `type=${type}`,
    ]);
  },
  createLabel(repo, name, opts) {
    const args = ['label', 'create', name, '--repo', repo, '--force'];
    if (opts.color) args.push('--color', opts.color);
    if (opts.description) args.push('--description', opts.description);
    try {
      gh(args);
    } catch {
      /* label already exists at this definition, fine */
    }
  },
  setSecret(repo, name, value) {
    // stdin, never `--body`: argv is world-readable in /proc ([R104]).
    gh(['secret', 'set', name, '--repo', repo], { input: value });
  },
  repoVisibility(repo) {
    return gh(['api', `repos/${repo}`, '--jq', '.visibility']) === 'private' ? 'private' : 'public';
  },
  setRepoPublic(repo) {
    gh(['api', '-X', 'PATCH', `repos/${repo}`, '-F', 'private=false']);
  },
};

/* --------------------------------------------------------------------------
 * upgrade.ts seams: target resolution, template materialization, the gated resync PR.
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

/**
 * Latest STABLE engine release tag for `engineRepo`.
 *
 * Deliberately the `releases/latest` API and not `gh release list --limit 1`: the latter sorts
 * by date and includes pre-releases, so every dev cut became what `oak bootstrap` handed new
 * papers and what the scheduled `oak upgrade --version-only` floated existing ones onto. That
 * silently contradicted RELEASING.md ("marked pre-release, so `version: latest` never resolves
 * to one") and pointed tenants at dev tags the same document says will be DELETED when pruned.
 *
 * `releases/latest` is GitHub's own definition of the invariant, newest non-draft,
 * non-prerelease, so the rule now lives in one place instead of being reimplemented here.
 * A pre-release stays reachable, but only by naming it: `--engine-version` / `--to`.
 *
 * 404 when the repo has no stable release at all (only dev cuts, or none); that is an answer,
 * not a failure, so the probe is quiet and the caller gets a message that says how to proceed.
 */
export function latestEngineRelease(engineRepo: string): string {
  let tag = '';
  try {
    tag = gh(['api', `repos/${engineRepo}/releases/latest`, '--jq', '.tag_name'], { quiet: true });
  } catch {
    throw new Error(msg.workflow.noStableRelease(engineRepo));
  }
  if (!tag) throw new Error(msg.workflow.noStableRelease(engineRepo));
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

/** The gated upgrade/resync PR: openDoiPr's branch→commit-as-bot→push→gh-pr-create shape. */
export const realUpgradePr: UpgradePr = {
  open(repoRoot, opts) {
    git(repoRoot, ['checkout', '-B', opts.branch]);
    git(repoRoot, ['add', ...opts.paths]);
    git(repoRoot, [...BOT_ID, 'commit', '-m', opts.title]);
    git(repoRoot, ['push', '-u', 'origin', opts.branch, '--force']);
    // Run `gh` inside the clone so it infers the target repo from origin (in CI the CWD is
    // already the repo; locally `oak upgrade` clones to a tmp dir, so pass cwd explicitly).
    return gh(['pr', 'create', '--title', opts.title, '--body', opts.body, '--head', opts.branch], {
      cwd: repoRoot,
    });
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
      out = gh(
        [
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--label',
          label,
          '--json',
          'number,headRefName',
        ],
        { quiet: true },
      );
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
    // No "contains" ref filter: list tags and match the middle marker in JS.
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
    return gh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ]);
  },
  mergePr(repo, prNumber) {
    gh(['pr', 'merge', String(prNumber), '--repo', repo, '--merge', '--delete-branch']);
    return gh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeCommit',
      '--jq',
      '.mergeCommit.oid',
    ]);
  },
  workflowRunsForCommit(repo, sha) {
    const out = gh([
      'api',
      `repos/${repo}/actions/runs?head_sha=${sha}`,
      '--jq',
      '[.workflow_runs[] | {id, name, status, conclusion, url: .html_url, event}]',
    ]);
    return out ? (JSON.parse(out) as import('./conformance.js').WorkflowRun[]) : [];
  },
  checkRunsForCommit(repo, sha) {
    const out = gh([
      'api',
      `repos/${repo}/commits/${sha}/check-runs`,
      '--jq',
      '[.check_runs[] | {name, conclusion}]',
    ]);
    return out ? (JSON.parse(out) as import('./conformance.js').CheckRunRef[]) : [];
  },
  openCertPr(repo, branch, marker) {
    // Branch off main, then a trivial always-valid content change (a MyST `%` comment appended
    // to index.md) via the Contents API, no clone, so no git-credential dependency in CI.
    const mainSha = gh(['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha']);
    gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/git/refs`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${mainSha}`,
    ]);

    const meta = JSON.parse(
      gh([
        'api',
        `repos/${repo}/contents/index.md?ref=${branch}`,
        '--jq',
        '{content: .content, sha: .sha}',
      ]),
    ) as {
      content: string;
      sha: string;
    };
    const current = Buffer.from(meta.content, 'base64').toString('utf8'); // GitHub wraps base64 in \n; Buffer ignores them
    const updated = Buffer.from(`${current}\n% conformance ${marker}\n`, 'utf8').toString('base64');
    gh([
      'api',
      '-X',
      'PUT',
      `repos/${repo}/contents/index.md`,
      '-f',
      `message=conformance preview probe ${marker}`,
      '-f',
      `content=${updated}`,
      '-f',
      `sha=${meta.sha}`,
      '-f',
      `branch=${branch}`,
    ]);

    const url = gh([
      'pr',
      'create',
      '--repo',
      repo,
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      `conformance preview ${marker}`,
      '--body',
      'Automated conformance preview probe; opened and closed by the harness.',
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
  committedDoi(repo) {
    // Read myst.yml off the default branch via the Contents API (base64), then YAML-parse it.
    let content: string;
    try {
      content = gh(['api', `repos/${repo}/contents/myst.yml`, '--jq', '.content'], { quiet: true });
    } catch {
      return null; // no myst.yml / no read access
    }
    if (!content) return null;
    const text = Buffer.from(content, 'base64').toString('utf8'); // GitHub wraps base64 in \n; Buffer ignores them
    const doi = parseDocument(text).getIn(['project', 'doi']);
    return doi != null ? String(doi) : null;
  },
  defaultBranchSha(repo) {
    return gh(['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha']);
  },
  pushTag(repo, tag, sha) {
    gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/git/refs`,
      '-f',
      `ref=refs/tags/${tag}`,
      '-f',
      `sha=${sha}`,
    ]);
  },
  approveDeployment(repo, runId, environment) {
    // GET the pending deployments, pick the environment id matching `environment`, then POST the
    // approval. A missing/empty pending list (already approved, or no gate) is a tolerated no-op.
    let envId: string;
    try {
      envId = gh(
        [
          'api',
          `repos/${repo}/actions/runs/${runId}/pending_deployments`,
          '--jq',
          `[.[] | select(.environment.name=="${environment}") | .environment.id] | first // empty`,
        ],
        { quiet: true },
      );
    } catch {
      return;
    }
    if (!envId) return;
    gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/actions/runs/${runId}/pending_deployments`,
      '-F',
      `environment_ids[]=${envId}`,
      '-f',
      'state=approved',
      '-f',
      'comment=conformance harness auto-approve',
    ]);
  },
  releaseAssets(repo, tag) {
    // `gh release view` errors when the release doesn't exist yet, treat that as no assets.
    try {
      const out = gh(
        ['release', 'view', tag, '-R', repo, '--json', 'assets', '--jq', '[.assets[].name]'],
        { quiet: true },
      );
      return out ? (JSON.parse(out) as string[]) : [];
    } catch {
      return [];
    }
  },
  deleteRelease(repo, tag) {
    // `--cleanup-tag` also removes the underlying tag. Tolerant: an absent release is a no-op.
    ghOk(['release', 'delete', tag, '-R', repo, '-y', '--cleanup-tag']);
  },

  // --- fork-PR preview path (optional, lab-tier) ---------------------------------------
  sweepForkBranches(forkRepo, forkToken, prefix) {
    // Idempotency: clear stale cert branches on the fork left by a crashed run (mirrors the
    // base-repo listBranches/deleteBranch sweep, but on the fork under the fork token).
    const out = ghAs(forkToken, [
      'api',
      `repos/${forkRepo}/git/matching-refs/heads/${prefix}`,
      '--jq',
      '.[].ref',
    ]);
    const branches = out ? out.split('\n').map((r) => r.replace(/^refs\/heads\//, '')) : [];
    for (const branch of branches) {
      ghOkAs(forkToken, ['api', '-X', 'DELETE', `repos/${forkRepo}/git/refs/heads/${branch}`]);
    }
    return branches;
  },
  openForkPr(baseRepo, forkRepo, forkToken, branch, tag, marker) {
    // On the FORK (fork token): branch off its default branch, then bump the engine pin to V so
    // the fork PR builds under V: that pin change is also the non-empty content diff. All via
    // the Contents API (no clone → no git-credential dependency for the fork token).
    const forkOwner = forkRepo.split('/')[0];
    const defaultBranch = ghAs(forkToken, ['api', `repos/${forkRepo}`, '--jq', '.default_branch']);
    const headSha = ghAs(forkToken, [
      'api',
      `repos/${forkRepo}/git/ref/heads/${defaultBranch}`,
      '--jq',
      '.object.sha',
    ]);
    ghAs(forkToken, [
      'api',
      '-X',
      'POST',
      `repos/${forkRepo}/git/refs`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${headSha}`,
    ]);

    const meta = JSON.parse(
      ghAs(forkToken, [
        'api',
        `repos/${forkRepo}/contents/myst.yml?ref=${branch}`,
        '--jq',
        '{content: .content, sha: .sha}',
      ]),
    ) as { content: string; sha: string };
    const doc = parseDocument(Buffer.from(meta.content, 'base64').toString('utf8')); // GitHub wraps base64 in \n; Buffer ignores them
    doc.setIn(['project', 'options', 'oaktree-sapling', 'version'], tag);
    const updated = Buffer.from(String(doc), 'utf8').toString('base64');
    ghAs(forkToken, [
      'api',
      '-X',
      'PUT',
      `repos/${forkRepo}/contents/myst.yml`,
      '-f',
      `message=conformance fork preview ${marker} (pin engine ${tag})`,
      '-f',
      `content=${updated}`,
      '-f',
      `sha=${meta.sha}`,
      '-f',
      `branch=${branch}`,
    ]);

    // Open the cross-fork PR on the BASE repo with the PRIMARY token, `--head owner:branch`
    // targets the fork's head branch.
    const url = gh([
      'pr',
      'create',
      '--repo',
      baseRepo,
      '--base',
      'main',
      '--head',
      `${forkOwner}:${branch}`,
      '--title',
      `conformance fork preview ${marker}`,
      '--body',
      'Automated conformance fork-PR preview probe; opened and closed by the harness.',
    ]);
    const number = Number(url.split('/').pop());
    // Re-read the fork branch head sha post-commit (the PUT advanced it).
    const postSha = ghAs(forkToken, [
      'api',
      `repos/${forkRepo}/git/ref/heads/${branch}`,
      '--jq',
      '.object.sha',
    ]);
    return { number, headSha: postSha };
  },
  deleteForkBranch(forkRepo, forkToken, branch) {
    ghOkAs(forkToken, ['api', '-X', 'DELETE', `repos/${forkRepo}/git/refs/heads/${branch}`]);
  },
  approveWorkflowRun(repo, runId) {
    // The fork-PR first-time-contributor gate is on the BASE repo, so approve with the PRIMARY
    // token. TOLERANT: a no-op error when approval isn't required. NOTE: whether fork runs need
    // approval every time (vs. only the first) is UNCERTAIN; the tolerant approve covers both,
    // and live-testing will settle it.
    ghOk(['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/approve`]);
  },
};
