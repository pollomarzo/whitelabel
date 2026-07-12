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
export function openDoiPr(repoRoot: string, opts: { conceptDoi: string; version: string }): string {
  const branch = `zenodo-doi-${opts.version}`;
  git(repoRoot, ['checkout', '-B', branch]);
  git(repoRoot, ['add', 'myst.yml']);
  git(repoRoot, ['commit', '-m', `chore: reserve Zenodo DOI ${opts.conceptDoi}`]);
  git(repoRoot, ['push', '-u', 'origin', branch, '--force']);
  return gh([
    'pr', 'create',
    '--title', `Reserve Zenodo DOI (${opts.version})`,
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
