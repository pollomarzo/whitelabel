#!/usr/bin/env node
/**
 * cli.ts — the `oak` entry point (bundled to dist/cli.cjs per tag; CI calls it directly
 * via ci/run.sh). Verb surface maps the 7 current isp-actions-config workflows (impl §2).
 *
 * Implemented: `build` (slice 2). The rest are stubbed with their slice number. The myst
 * edge is imported lazily inside `build` so `oak` with no/other args stays light and the
 * dep only loads when actually building.
 */
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';

// dist/cli.cjs is an esbuild CJS bundle ([R51]), so `__dirname` is the bundle's dir
// (engine/dist). `oak` is only ever run bundled — CI (ci/run.sh) and local both invoke
// dist/cli.cjs — so we don't need the ESM import.meta.url dance. @types/node declares
// __dirname globally, keeping tsc happy under NodeNext.
declare const __dirname: string;

type Verb =
  | 'build'
  | 'validate'
  | 'deploy-preview'
  | 'deposit'
  | 'release'
  | 'notify'
  | 'bootstrap'
  | 'upgrade';

const STUB_SLICE: Partial<Record<Verb, string>> = {
  bootstrap: 'slice 5',
  upgrade: 'slice 5',
};

/** engineRoot = the dir holding paper-base.yml. When run as dist/cli.cjs it is one level
 *  up from the bundle; in dev (tsx/src) it is two up from src/. Detect by probing. */
function engineRoot(): string {
  for (const up of ['..', '.']) {
    const cand = resolve(__dirname, up);
    if (existsSync(join(cand, 'paper-base.yml'))) return cand;
  }
  return resolve(__dirname, '..');
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** engine_repo pin, for asset URLs; falls back to the interim home ([R56]; canonical
 *  open-scholar-nexus/oaktree-sapling later). Real repos carry pins.yml, so this is only
 *  a last resort. */
function readEngineRepo(paperRoot: string): string {
  const pins = join(paperRoot, '.github', 'actions', 'engine', 'pins.yml');
  if (existsSync(pins)) {
    const v = parseDocument(readFileSync(pins, 'utf8')).get('engine_repo');
    if (typeof v === 'string') return v;
  }
  return 'pollomarzo/whitelabel';
}

/** Run the two-pass build for a paper; shared by `oak build` and `oak release`. Returns the
 *  resolved paper root (its `_build/exports` now holds the PDF `release` deposits). */
async function buildPaper(argv: string[]): Promise<{ paperRoot: string; resolvedId?: string }> {
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  const instanceRoot = has(argv, 'no-instance')
    ? null
    : resolve(flag(argv, 'instance') ?? mustInstance());
  const baseUrl = flag(argv, 'base-url') ?? '';
  const engineRepo = flag(argv, 'engine-repo') ?? readEngineRepo(paperRoot);

  // Dev/CI-from-checkout asset resolution: a local typst template in the engine checkout
  // beats the (not-yet-existent) release zip; `--no-site-template` uses myst's default
  // theme until the fork release exists (compose siteTemplate: null).
  const localTypst = join(engineRoot(), 'templates', 'typst');
  const assetOverrides = {
    ...(flag(argv, 'typst-template')
      ? { typstTemplate: resolve(flag(argv, 'typst-template')!) }
      : existsSync(localTypst)
        ? { typstTemplate: localTypst }
        : {}),
    ...(has(argv, 'no-site-template') ? { siteTemplate: null as string | null } : {}),
  };

  const { runBuild } = await import('./build.js');
  const { createMystEdge } = await import('./myst.js');
  const res = await runBuild({
    paperRoot,
    engineRoot: engineRoot(),
    instanceRoot,
    engineRepo,
    baseUrl,
    assetOverrides,
    // --exports-only builds just the typst PDF (offline canary; no network theme).
    // --no-exports builds HTML only (until the typst-template release zip exists).
    buildOpts: has(argv, 'exports-only')
      ? { exportsOnly: true }
      : has(argv, 'no-exports')
        ? { all: false, html: true }
        : { all: true, html: true },
    edge: createMystEdge(),
  });
  for (const w of res.warnings) process.stderr.write(`::warning::${w}\n`);
  return { paperRoot, resolvedId: res.resolvedProject.id };

  function mustInstance(): string {
    process.stderr.write(
      'oak build: pass --instance <path> (or --no-instance for an unbranded build). ' +
        'Local pins-based instance cloning is a CI concern for now.\n',
    );
    process.exit(2);
  }
}

async function cmdBuild(argv: string[]): Promise<number> {
  const { resolvedId } = await buildPaper(argv);
  process.stderr.write(`oak build: done (id=${resolvedId ?? '?'})\n`);
  return 0;
}

/** myst.yml path from --myst, or <--paper|.>/myst.yml. */
function mystPathOf(argv: string[]): string {
  return resolve(flag(argv, 'myst') ?? join(flag(argv, 'paper') ?? '.', 'myst.yml'));
}
function instanceRootOf(argv: string[]): string | null {
  const i = flag(argv, 'instance');
  return i ? resolve(i) : null;
}
function emit(result: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/** `oak deposit <prepare|publish|status>` — the Zenodo deposit verbs (slice 3). */
async function cmdDeposit(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const z = await import('./zenodo.js');
  const gh = await import('./gh.js');

  const mystPath = mystPathOf(rest);
  const instanceRoot = instanceRootOf(rest);
  const sandbox = has(rest, 'sandbox');
  const siteUrl = flag(rest, 'site-url') ?? process.env.SITE_URL;
  const token = flag(rest, 'token') ?? process.env.ZENODO_TOKEN;
  if (!token) {
    process.stderr.write('no token: set ZENODO_TOKEN or pass --token\n');
    return 2;
  }
  const api = new z.ZenodoApi(z.createFetchTransport(), z.apiBase(sandbox), token);

  if (sub === 'prepare') {
    const repo = flag(rest, 'repo') ?? process.env.GITHUB_REPOSITORY;
    if (!repo) {
      process.stderr.write('deposit prepare: pass --repo owner/repo (or set GITHUB_REPOSITORY)\n');
      return 2;
    }
    const out = await z.cmdPrepare({ mystPath, repo, siteUrl, sandbox, api, instanceRoot });
    emit(out.result);
    // Open the DOI PR over the working-tree myst.yml write ([R3]/§1d). Best-effort: a local
    // sandbox rehearsal with no gh/token just leaves the write for the human to PR.
    if (out.exitCode === 0 && !has(rest, 'no-pr') && process.env.GH_TOKEN) {
      try {
        const url = gh.openDoiPr(resolve(mystPath, '..'), { conceptDoi: String(out.result.concept_doi) });
        process.stderr.write(`deposit prepare: opened DOI PR ${url}\n`);
      } catch (e) {
        process.stderr.write(`::warning::deposit prepare: DOI PR not opened (${(e as Error).message})\n`);
      }
    }
    return out.exitCode;
  }

  if (sub === 'publish') {
    const pdf = flag(rest, 'pdf');
    const tag = flag(rest, 'tag');
    if (!pdf || !tag) {
      process.stderr.write('deposit publish: --pdf and --tag are required\n');
      return 2;
    }
    const out = await z.cmdPublish({
      mystPath, pdf: resolve(pdf), tag, siteUrl, sandbox,
      bundleOut: resolve(flag(rest, 'bundle-out') ?? '_bundle'),
      api, git: gh.realGitContext, instanceRoot, engineRoot: engineRoot(),
    });
    emit(out.result);
    return out.exitCode;
  }

  if (sub === 'status') {
    const out = await z.cmdStatus({ mystPath, siteUrl, sandbox, api, instanceRoot });
    emit(out.result);
    return out.exitCode;
  }

  process.stderr.write('oak deposit: usage: oak deposit <prepare|publish|status> [...]\n');
  return 2;
}

/** Find the built PDF under `_build/exports` (the typst export). */
function findExportedPdf(paperRoot: string): string | null {
  const dir = join(paperRoot, '_build', 'exports');
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith('.pdf'));
  return hit ? join(dir, String(hit)) : null;
}

/** `oak release --tag vX` — build + deposit publish + attach the bundle to the tag Release,
 *  post a commit comment / failure issue via gh (§1e). Env is derived from the committed DOI. */
async function cmdRelease(argv: string[]): Promise<number> {
  const tag = flag(argv, 'tag');
  if (!tag) {
    process.stderr.write('oak release: --tag vX.Y.Z is required\n');
    return 2;
  }
  const z = await import('./zenodo.js');
  const gh = await import('./gh.js');

  // Build in a CHILD process, not in-process: the myst HTML/site build calls process.exit(0)
  // on success, which — run in-process — kills `release` before its deposit half ever runs
  // (observed on CI: build succeeded, job exited 0, nothing deposited). The child isolates
  // that exit; the parent then reads the same working tree's _build/exports (PDF) and
  // _build/site/content (abstract) for the deposit. `oak build` ignores the extra release
  // flags (--tag/--bundle-out/--site-url).
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  execFileSync(process.execPath, [process.argv[1]!, 'build', ...argv], { stdio: 'inherit' });
  const mystPath = mystPathOf(argv);

  const doi = parseDocument(readFileSync(mystPath, 'utf8')).getIn(['project', 'doi']);
  if (typeof doi !== 'string' || !doi) {
    process.stderr.write('oak release: project.doi missing — run prepare and merge that PR first.\n');
    return 2;
  }
  const sandbox = z.isSandboxDoi(doi);
  const token = flag(argv, 'token') ?? (sandbox ? process.env.ZENODO_TOKEN_SANDBOX : process.env.ZENODO_TOKEN);
  if (!token) {
    process.stderr.write(`no token: set ${sandbox ? 'ZENODO_TOKEN_SANDBOX' : 'ZENODO_TOKEN'}\n`);
    return 2;
  }

  const pdf = findExportedPdf(paperRoot);
  if (!pdf) {
    process.stderr.write('oak release: no PDF under _build/exports (did the typst export run?)\n');
    return 2;
  }

  const api = new z.ZenodoApi(z.createFetchTransport(), z.apiBase(sandbox), token);
  const bundleOut = resolve(flag(argv, 'bundle-out') ?? '_bundle');
  const out = await z.cmdPublish({
    mystPath, pdf, tag,
    siteUrl: flag(argv, 'site-url') ?? process.env.SITE_URL,
    sandbox, bundleOut, api, git: gh.realGitContext, instanceRoot: instanceRootOf(argv),
    engineRoot: engineRoot(),
  });
  emit(out.result);

  if (out.exitCode === 0 && process.env.GH_TOKEN) {
    try {
      const files = readdirSync(bundleOut).map((f) => join(bundleOut, f));
      gh.uploadReleaseAsset(paperRoot, tag, files);
      const sha = await gh.realGitContext.headSha(paperRoot);
      gh.postCommitComment(paperRoot, sha, `Zenodo draft populated: ${out.result.draft_url ?? out.result.version_doi}`);
    } catch (e) {
      process.stderr.write(`::warning::oak release: gh post-steps failed (${(e as Error).message})\n`);
    }
  } else if (out.exitCode !== 0 && process.env.GH_TOKEN) {
    try {
      gh.openFailureIssue(paperRoot, `Zenodo publish failed for ${tag}`, String(out.result.message ?? 'unknown error'));
    } catch {
      /* best-effort */
    }
  }
  return out.exitCode;
}

/** `oak deploy-preview <site>` — deploy the inert Stage-1 artifact to Cloudflare Pages (or
 *  degrade to an artifact-link comment [R16]), post the sticky preview comment, then run the
 *  new-version reminder. Slice 2-shim; the git/gh + CF effects are the real gh.ts seams. */
async function cmdDeployPreview(argv: string[]): Promise<number> {
  const preview = await import('./preview.js');
  const gh = await import('./gh.js');
  const siteDir = resolve(argv.find((a) => !a.startsWith('--')) ?? 'site');
  const out = await preview.cmdDeployPreview(
    {
      siteDir,
      repoRoot: resolve(flag(argv, 'paper') ?? '.'),
      instanceRoot: instanceRootOf(argv),
      repo: flag(argv, 'repo') ?? process.env.GITHUB_REPOSITORY ?? null,
      serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
      cf: { apiToken: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID },
      mystPath: mystPathOf(argv),
    },
    { deployer: gh.realPagesDeployer, gh: gh.realGhPr },
  );
  emit(out.result);
  return out.exitCode;
}

/** `oak notify new-version [--pr N | --site <dir>]` — the standalone new-version reminder.
 *  deploy-preview runs the same logic internally ([R16]); this is the manual/testable entry.
 *  The PR number comes from `--pr` or a `.pr-number` in `--site` (read-only — deploy-preview
 *  owns the [R26] delete). */
async function cmdNotify(argv: string[]): Promise<number> {
  if (argv[0] !== 'new-version') {
    process.stderr.write('oak notify: usage: oak notify new-version [--pr N | --site <dir>]\n');
    return 2;
  }
  const rest = argv.slice(1);
  const preview = await import('./preview.js');
  const gh = await import('./gh.js');

  let pr = flag(rest, 'pr');
  if (!pr) {
    const f = join(resolve(flag(rest, 'site') ?? 'site'), '.pr-number');
    if (existsSync(f)) pr = readFileSync(f, 'utf8').trim();
  }
  if (!pr) {
    process.stderr.write('oak notify new-version: pass --pr N (or --site <dir> holding a .pr-number)\n');
    return 2;
  }

  const out = preview.runNewVersionReminder(
    {
      repoRoot: resolve(flag(rest, 'paper') ?? '.'),
      mystPath: mystPathOf(rest),
      repo: flag(rest, 'repo') ?? process.env.GITHUB_REPOSITORY ?? null,
      pr,
    },
    gh.realGhPr,
  );
  emit(out.result);
  return out.exitCode;
}

/** The SHA a CI Check Run should attach to. On `pull_request` GITHUB_SHA is the synthetic
 *  merge commit (a check run there is invisible on the PR), so read the PR HEAD sha from the
 *  event payload; otherwise (push/dispatch) GITHUB_SHA is correct. */
function ciHeadSha(): string | undefined {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
    try {
      const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const head = ev?.pull_request?.head?.sha;
      if (typeof head === 'string' && head) return head;
    } catch {
      /* fall through to GITHUB_SHA */
    }
  }
  return process.env.GITHUB_SHA;
}

/** `oak validate` — run the journal-controlled checks (slice 4). Layer A (engine invariants,
 *  also the `oak build` pre-flight phase) + Layer B (journal-selected editorial checks). Posts
 *  a GitHub Check Run in CI (best-effort: needs GH_TOKEN + GITHUB_SHA + the repo). */
async function cmdValidate(argv: string[]): Promise<number> {
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  const noInstance = has(argv, 'no-instance');
  const instanceFlag = flag(argv, 'instance');
  if (!noInstance && !instanceFlag) {
    process.stderr.write('oak validate: pass --instance <path> (or --no-instance for a bare check).\n');
    return 2;
  }
  const instanceRoot = noInstance ? null : resolve(instanceFlag!);
  const strict = has(argv, 'strict');

  const gh = await import('./gh.js');
  const repo = flag(argv, 'repo') ?? process.env.GITHUB_REPOSITORY ?? gh.originRepo(paperRoot);

  const { runValidate } = await import('./validate.js');
  const { createMystEdge } = await import('./myst.js');

  // myst-cli writes progress to STDOUT — the `📖/📚 Built…` logger lines AND a raw `console.debug`
  // from `new Session()` that bypasses its own logger — which would corrupt the JSON `emit()` puts
  // there. Forward every stdout write to stderr for the duration of the run (preserving myst's own
  // formatting), so stdout carries ONLY our machine-readable payload; restore before we emit.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let out;
  try {
    out = await runValidate(
      { paperRoot, instanceRoot, edge: createMystEdge() },
      { strict, repo, pathBase: process.env.GITHUB_WORKSPACE ?? paperRoot },
    );
  } finally {
    process.stdout.write = realStdoutWrite;
  }

  emit({
    status: out.status,
    errors: out.errors,
    warnings: out.warnings,
    checks: out.checks,
    ...(has(argv, 'json') ? { checkRun: out.checkRun } : {}),
  });

  // Post the first-class Check Run in CI (needs checks:write + the head SHA). On a
  // `pull_request` the default GITHUB_SHA is the ephemeral MERGE commit; a check run there
  // does NOT surface on the PR — so we resolve the PR HEAD sha from the event payload
  // ourselves (the runner keeps re-injecting the merge SHA, so a workflow `env:` override
  // can't be relied on). Falls back to GITHUB_SHA off a PR (push/dispatch).
  const headSha = ciHeadSha();
  if (process.env.GH_TOKEN && headSha && repo) {
    try {
      gh.realCheckRun.create(repo, headSha, 'Journal checks', out.checkRun);
    } catch (e) {
      process.stderr.write(`::warning::oak validate: check-run not posted (${(e as Error).message})\n`);
    }
  }
  return out.exitCode;
}

async function main(argv: string[]): Promise<number> {
  const verb = argv[0] as Verb | undefined;
  if (verb === 'build') return cmdBuild(argv.slice(1));
  if (verb === 'validate') return cmdValidate(argv.slice(1));
  if (verb === 'deposit') return cmdDeposit(argv.slice(1));
  if (verb === 'release') return cmdRelease(argv.slice(1));
  if (verb === 'deploy-preview') return cmdDeployPreview(argv.slice(1));
  if (verb === 'notify') return cmdNotify(argv.slice(1));
  if (verb && verb in STUB_SLICE) {
    process.stderr.write(`oak ${verb}: not implemented yet (${STUB_SLICE[verb]}).\n`);
    return 1;
  }
  process.stderr.write(
    `oak: usage:\n` +
      `  oak build   [--paper <dir>] [--instance <dir> | --no-instance] [--base-url <url>] [--no-site-template]\n` +
      `  oak validate [--paper <dir>] [--instance <dir> | --no-instance] [--strict] [--json]\n` +
      `  oak deposit prepare --repo <owner/repo> [--site-url <url>] [--sandbox] [--instance <dir>]\n` +
      `  oak deposit publish --pdf <path> --tag <vX.Y.Z> [--site-url <url>] [--sandbox] [--instance <dir>]\n` +
      `  oak deposit status  [--sandbox] [--instance <dir>]\n` +
      `  oak release --tag <vX.Y.Z> [--paper <dir>] [--instance <dir>] [--site-url <url>]\n` +
      `  oak deploy-preview <site> [--instance <dir>] [--repo <owner/repo>]\n` +
      `  oak notify new-version [--pr <n> | --site <dir>] [--repo <owner/repo>]\n`,
  );
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`::error::${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
