#!/usr/bin/env node
/**
 * cli.ts: the `oak` entry point (bundled to dist/cli.cjs per tag; CI calls it directly via
 * ci/run.sh). Every verb below is implemented. The myst edge is imported lazily inside `build`
 * so `oak` with no/other args stays light and the dep only loads when actually building.
 */
import { join, resolve } from 'node:path';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdtempSync,
  watchFile,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import type { UpgradeMode } from './upgrade.js';
import type { ComposeInput } from './compose.js';
import type { MaterializeInput, StartOpts } from './materialize.js';
import * as msg from './messages.js';
import { annotate, UserError } from './messages.js';

// dist/cli.cjs is an esbuild CJS bundle ([R51]), so `__dirname` is the bundle's dir
// (engine/dist). `oak` is only ever run bundled, CI (ci/run.sh) and local both invoke
// dist/cli.cjs, so we don't need the ESM import.meta.url dance. @types/node declares
// __dirname globally, keeping tsc happy under NodeNext.
declare const __dirname: string;

type Verb =
  | 'build'
  | 'start'
  | 'validate'
  | 'check-post'
  | 'deploy-preview'
  | 'deposit'
  | 'release'
  | 'notify'
  | 'bootstrap'
  | 'upgrade'
  | 'conformance';

/** engineRoot = the dir holding paper-base.yml. When run as dist/cli.cjs it is one level
 *  up from the bundle; in dev (tsx/src) it is two up from src/. Detect by probing. */
function engineRoot(): string {
  for (const up of ['..', '.']) {
    const cand = resolve(__dirname, up);
    if (existsSync(join(cand, 'paper-base.yml'))) return cand;
  }
  return resolve(__dirname, '..');
}

/**
 * A `--name value` pair. Absent is undefined; PRESENT BUT MALFORMED throws, because the two are
 * not the same question: an unset flag falls back to an env var at several call sites, so a
 * `--repo` whose value vanished (an unquoted empty shell variable) would silently act on
 * whatever the environment names instead of refusing.
 */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new UserError(msg.flagNeedsValue(name));
  }
  return value;
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

/**
 * Dev/CI-from-checkout asset resolution. `--typst-template` is the EXPLICIT override and
 * tops compose's precedence chain; the engine checkout's local `templates/typst` is the
 * BOTTOM fallback ([R76]): it beats the (not-yet-existent) release zip but yields to a
 * tenant's or an author's template, which is the whole point of the chain. (It used to be
 * forced into the same slot as the explicit flag, i.e. first, which made both overrides
 * unreachable.) `--no-site-template` uses myst's default theme until the fork release
 * exists (compose siteTemplate: null).
 *
 * Shared by `oak build` and `oak validate`, which since [R82] materialize the SAME
 * `myst.oak.yml` through the same `materializeDerived` (`materialize.ts`). Sharing the function
 * is not enough
 * to stop them drifting if they feed it different inputs: `templates/typst` exists in every
 * checkout including CI, so a validate that skipped these overrides stamped the release-zip
 * URL where the build stamps the local path, two different files under one name, and
 * `readStampedTemplate` (zenodo.ts) reads that file as the record of what the build rendered
 * with. Same overrides in, same bytes out.
 */
function assetOverridesFrom(argv: string[]): ComposeInput['assetOverrides'] {
  const localTypst = join(engineRoot(), 'templates', 'typst');
  return {
    ...(flag(argv, 'typst-template')
      ? { typstTemplate: resolve(flag(argv, 'typst-template')!) }
      : {}),
    ...(existsSync(localTypst) ? { engineTypstTemplate: localTypst } : {}),
    ...(has(argv, 'no-site-template') ? { siteTemplate: null as string | null } : {}),
  };
}

/**
 * The [R38] instance-root chain, minus the deferred pins-based clone: an explicit
 * `--instance` › the CO-LOCATED root (a `journal.yml` sitting beside the paper) › the
 * explicit `--no-instance` opt-out.
 *
 * The co-located rung is what `ci/run.sh` means by "'.' = co-located, leave to the CLI's
 * root resolution": when `pins.yml` says `instance_repo: .` the shim clones nothing and
 * passes no `--instance`, so WITHOUT this rung every co-located repo's CI died on the
 * usage error below. It also makes the error itself useful: the common way to reach it is
 * a paper whose `pins.yml` still carries the template's `.` placeholder, and the old text
 * ("pass --instance <path>") named a flag the author cannot reach from a CI log.
 *
 * Returns a root or an error STRING; it never exits, so `oak validate` can turn the failure
 * into a report instead of a crash.
 */
function resolveInstanceRoot(
  argv: string[],
  paperRoot: string,
  verb: 'build' | 'start' | 'validate',
): { root: string | null } | { error: string } {
  if (has(argv, 'no-instance')) return { root: null };
  const explicit = flag(argv, 'instance');
  if (explicit) return { root: resolve(explicit) };
  if (existsSync(join(paperRoot, 'journal.yml'))) return { root: paperRoot };
  return { error: msg.build.noInstance(verb, paperRoot) };
}

/**
 * Is this directory the JOURNAL repo rather than a paper?
 *
 * `oak build` assumed every target was a paper, and the co-located rung above reads a
 * `journal.yml` as "the journal settings are in this repo", which is equally true of the
 * journal repo itself, where there is no manuscript at all. So a `oak build` typed in a journal
 * clone sailed past instance resolution and died inside the config read, on a coordinate a
 * journal repo is never supposed to have (the UX-test crash).
 *
 * The discriminator is the ENGINE COORDINATE, not `journal.yml`: a co-located repo is both a
 * journal and a paper and carries both, while the journal repo's `myst.yml` is the WEBSITE and
 * carries no `project.options.oaktree-sapling`. A `--no-site` journal has no myst.yml at all.
 * A myst.yml we cannot parse is not called a journal; that is a different error, and it should
 * be allowed to speak for itself.
 */
function isJournalRepo(root: string): boolean {
  if (!existsSync(join(root, 'journal.yml'))) return false;
  const mystPath = join(root, 'myst.yml');
  if (!existsSync(mystPath)) return true;
  try {
    const v = parseDocument(readFileSync(mystPath, 'utf8')).getIn([
      'project',
      'options',
      'oaktree-sapling',
      'version',
    ]);
    return !(typeof v === 'string' && v);
  } catch {
    return false;
  }
}

/** Everything `materializeDerived` needs except the myst edge, shared by build and start so a
 *  preview cannot compose from different inputs than the build it is previewing. */
function materializeInputFrom(
  argv: string[],
  paperRoot: string,
  instanceRoot: string | null,
): Omit<MaterializeInput, 'edge'> {
  return {
    paperRoot,
    engineRoot: engineRoot(),
    instanceRoot,
    engineRepo: flag(argv, 'engine-repo') ?? readEngineRepo(paperRoot),
    baseUrl: flag(argv, 'base-url') ?? '',
    assetOverrides: assetOverridesFrom(argv),
  };
}

/** Run the two-pass build for a paper; shared by `oak build` and `oak release`. Returns the
 *  resolved paper root (its `_build/exports` now holds the PDF `release` deposits). */
async function buildPaper(argv: string[]): Promise<{ paperRoot: string; resolvedId?: string }> {
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  if (isJournalRepo(paperRoot)) {
    process.stderr.write(annotate('error', msg.build.inJournalRepo(paperRoot)) + '\n');
    process.exit(2);
  }
  const resolved = resolveInstanceRoot(argv, paperRoot, 'build');
  if ('error' in resolved) {
    process.stderr.write(resolved.error + '\n');
    process.exit(2);
  }

  const { runBuild } = await import('./build.js');
  const { createMystEdge } = await import('./myst.js');
  const res = await runBuild({
    ...materializeInputFrom(argv, paperRoot, resolved.root),
    // --exports-only builds just the typst PDF (offline canary; no network theme).
    // --no-exports builds HTML only (until the typst-template release zip exists).
    buildOpts: has(argv, 'exports-only')
      ? { exportsOnly: true }
      : has(argv, 'no-exports')
        ? { all: false, html: true }
        : { all: true, html: true },
    edge: createMystEdge(),
  });
  for (const w of res.warnings) process.stderr.write(annotate('warning', w) + '\n');
  return { paperRoot, resolvedId: res.resolvedProject.id };
}

async function cmdBuild(argv: string[]): Promise<number> {
  const { resolvedId } = await buildPaper(argv);
  process.stderr.write(msg.build.done(resolvedId ?? '?') + '\n');
  return 0;
}

/** The `myst start` flags `oak start` forwards (myst's own names and meanings). */
function startOptsFrom(argv: string[]): StartOpts {
  const num = (name: string) => {
    const raw = flag(argv, name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new UserError(msg.flagNeedsPort(name, raw));
    return n;
  };
  return {
    ...(num('port') !== undefined ? { port: num('port') } : {}),
    ...(num('server-port') !== undefined ? { serverPort: num('server-port') } : {}),
    ...(has(argv, 'headless') ? { headless: true } : {}),
    ...(has(argv, 'keep-host') ? { keepHost: true } : {}),
    ...(flag(argv, 'template') ? { template: flag(argv, 'template') } : {}),
    ...(flag(argv, 'base-url') ? { baseurl: flag(argv, 'base-url') } : {}),
  };
}

/**
 * `oak start`: compose, then hand off to myst's dev server (the same one `myst start` runs).
 *
 * Never returns: myst's `startServer` resolves once the server is UP, and `main()`'s return
 * would exit the process out from under it. The wait is what keeps the server alive; Ctrl-C
 * ends it.
 */
async function cmdStart(argv: string[]): Promise<number> {
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  // Parsed before any resolution or compose: a typo must not cost a build ([R131]).
  const startOpts = startOptsFrom(argv);
  const { createMystEdge } = await import('./myst.js');
  const edge = createMystEdge();

  // The journal repo is a plain myst project (its website), with nothing to compose: no engine
  // layers, no edition, no derived config; myst reads its own myst.yml, exactly as the site
  // workflow does. Same shape check as `oak build`, opposite conclusion: here there IS
  // something to show.
  if (isJournalRepo(paperRoot)) {
    process.stderr.write(msg.start.journalSite(paperRoot) + '\n');
    await edge.start(paperRoot, startOpts);
    return await never();
  }

  const resolved = resolveInstanceRoot(argv, paperRoot, 'start');
  if ('error' in resolved) {
    process.stderr.write(resolved.error + '\n');
    return 2;
  }
  const input = { ...materializeInputFrom(argv, paperRoot, resolved.root), edge };

  const { runStart } = await import('./build.js');
  const { materializeDerived } = await import('./materialize.js');
  process.stderr.write(msg.start.composed(paperRoot, resolved.root) + '\n');
  const first = await runStart({ ...input, startOpts });
  for (const w of first.warnings) process.stderr.write(annotate('warning', w) + '\n');

  // myst watches the DERIVED config (that is the one it was pointed at), so an edit to the
  // author's `myst.yml` would otherwise change nothing on screen until the next `oak start`:
  // the one file an author edits most. Recomposing rewrites `myst.oak.yml`, which myst's own
  // watcher then picks up: the reload path stays myst's, we only refresh its input.
  watchFile(join(paperRoot, 'myst.yml'), { interval: 500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    materializeDerived(input).then(
      () => process.stderr.write(msg.start.recomposed + '\n'),
      // A half-edited config is normal while typing: say what is stale and keep serving.
      (e) =>
        process.stderr.write(msg.start.recomposeFailed(String((e as Error)?.message ?? e)) + '\n'),
    );
  });
  return await never();
}

/** Hand the process to the running server: resolve never, so `main()` never exits. */
function never(): Promise<number> {
  return new Promise<number>(() => {});
}

/** myst.yml path from --myst, or <--paper|.>/myst.yml. */
function mystPathOf(argv: string[]): string {
  return resolve(flag(argv, 'myst') ?? join(flag(argv, 'paper') ?? '.', 'myst.yml'));
}
function instanceRootOf(argv: string[]): string | null {
  const i = flag(argv, 'instance');
  return i ? resolve(i) : null;
}

/** Keys a human summary never prints: already narrated as prose (`runbook`, logged line by
 *  line with `→`), or a whole markdown document meant for the PR UI (`checkRun`). */
const SUMMARY_SKIP = new Set(['runbook', 'checkRun']);

/** Fallback rendering of a result object for a human: one `key: value` line per field. Arrays
 *  of strings become bullets, nested objects a compact `k=v` list, empty things nothing. */
function summarize(result: Record<string, unknown>): string[] {
  // A refusal is a sentence, not a record; the message already names the verb and the fix.
  if (result.status === 'error') {
    const text = result.error ?? result.message;
    if (typeof text === 'string') return [text];
  }
  // An abort has already explained itself at the prompt; repeating it as fields is the
  // duplication this pass exists to remove.
  if (result.status === 'aborted') return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (SUMMARY_SKIP.has(key) || value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      if (value.every((v) => typeof v === 'string')) {
        lines.push(`${key}:`);
        for (const v of value) lines.push(`  - ${v}`);
      } else lines.push(`${key}: ${value.length}`);
    } else if (typeof value === 'object') {
      const inner = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (inner) lines.push(`${key}: ${inner}`);
    } else lines.push(`${key}: ${value}`);
  }
  return lines;
}

/**
 * The human rendering for the verbs that narrate every step as they happen (`bootstrap`,
 * `upgrade`): their result object is a recap of lines already on the screen, so it closes
 * with one line naming what to open, instead of repeating itself.
 */
function narrated(result: Record<string, unknown>): string[] {
  const special = summarize(result);
  if (result.status !== 'ok') return special;
  const what = result.repo ?? result.target ?? '';
  const links = [result.pr, result.site_url].filter(
    (v): v is string => typeof v === 'string' && !!v,
  );
  return [`done: ${what}${links.length ? `; ${links.join('  ')}` : ''}`];
}

/**
 * Print a verb's result. The JSON envelope is OPT-IN (`--json`): dumping it into a human's
 * terminal repeats, in a shape nobody reads, what the verb has just said in prose, the
 * runbook a tenant is supposed to act on arrived twice, once as instructions and once as a
 * log. Nothing in CI parses this stdout (the shim and the workflows consume FILES, `oak
 * validate --report`, `oak conformance --record`), so the envelope can be gated without
 * touching them. Human output goes to stderr, where the rest of our prose already is, so
 * `--json`'s stdout stays a clean machine channel.
 */
function emit(
  argv: string[],
  result: Record<string, unknown>,
  human?: (r: Record<string, unknown>) => string[],
): void {
  if (has(argv, 'json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  for (const line of (human ?? summarize)(result)) process.stderr.write(line + '\n');
}

/** `oak deposit <prepare|publish|status>`, the Zenodo deposit verbs (slice 3). */
async function cmdDeposit(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const z = await import('./zenodo.js');
  const gh = await import('./gh.js');

  const mystPath = mystPathOf(rest);
  const instanceRoot = instanceRootOf(rest);
  const sandbox = has(rest, 'sandbox');
  const siteUrl = flag(rest, 'site-url') ?? process.env.SITE_URL;
  // The environment picks the secret, same as `oak release` ([R102]).
  // No cross-fallback: a sandbox run must not reach for the production token ([R133]).
  const token =
    flag(rest, 'token') ?? (sandbox ? process.env.ZENODO_TOKEN_SANDBOX : process.env.ZENODO_TOKEN);
  if (!token) {
    process.stderr.write(msg.workflow.depositNoToken(sandbox) + '\n');
    return 2;
  }
  const api = new z.ZenodoApi(z.createFetchTransport(), sandbox, token);

  if (sub === 'prepare') {
    const repo = flag(rest, 'repo') ?? process.env.GITHUB_REPOSITORY;
    if (!repo) {
      process.stderr.write(msg.workflow.depositNoRepo + '\n');
      return 2;
    }
    const out = await z.cmdPrepare({ mystPath, repo, siteUrl, api, instanceRoot });
    emit(rest, out.result);
    // Open the DOI PR over the working-tree myst.yml write ([R3]/§1d). Best-effort: a local
    // sandbox rehearsal with no gh/token just leaves the write for the human to PR.
    if (out.exitCode === 0 && !has(rest, 'no-pr') && process.env.GH_TOKEN) {
      try {
        const url = gh.openDoiPr(resolve(mystPath, '..'), {
          conceptDoi: String(out.result.concept_doi),
        });
        process.stderr.write(msg.workflow.depositDoiPrOpened(url) + '\n');
      } catch (e) {
        process.stderr.write(
          annotate('warning', msg.workflow.depositDoiPrFailed((e as Error).message)) + '\n',
        );
      }
    }
    return out.exitCode;
  }

  if (sub === 'publish') {
    const pdf = flag(rest, 'pdf');
    const tag = flag(rest, 'tag');
    if (!pdf || !tag) {
      process.stderr.write(msg.workflow.depositPublishArgs + '\n');
      return 2;
    }
    const out = await z.cmdPublish({
      mystPath,
      pdf: resolve(pdf),
      tag,
      siteUrl,
      bundleOut: resolve(flag(rest, 'bundle-out') ?? '_bundle'),
      api,
      git: gh.realGitContext,
      instanceRoot,
      engineRoot: engineRoot(),
    });
    emit(rest, out.result);
    return out.exitCode;
  }

  if (sub === 'status') {
    const out = await z.cmdStatus({ mystPath, siteUrl, api, instanceRoot });
    emit(rest, out.result);
    return out.exitCode;
  }

  process.stderr.write(msg.workflow.depositUsage + '\n');
  return 2;
}

/** Find the built PDF under `_build/exports` (the typst export). */
function findExportedPdf(paperRoot: string): string | null {
  const dir = join(paperRoot, '_build', 'exports');
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith('.pdf'));
  return hit ? join(dir, String(hit)) : null;
}

/** `oak release --tag vX`: build + deposit publish + attach the bundle to the tag Release,
 *  post a commit comment / failure issue via gh (§1e). Env is derived from the committed DOI. */
async function cmdRelease(argv: string[]): Promise<number> {
  const tag = flag(argv, 'tag');
  if (!tag) {
    process.stderr.write(msg.workflow.releaseNoTag + '\n');
    return 2;
  }
  const z = await import('./zenodo.js');
  const gh = await import('./gh.js');

  // Build in a CHILD process, not in-process: the myst HTML/site build calls process.exit(0)
  // on success, which (run in-process) kills `release` before its deposit half ever runs
  // (observed on CI: build succeeded, job exited 0, nothing deposited). The child isolates
  // that exit; the parent then reads the same working tree's _build/exports (PDF) and
  // _build/site/content (abstract) for the deposit. `oak build` ignores the extra release
  // flags (--tag/--bundle-out/--site-url).
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  execFileSync(process.execPath, [process.argv[1]!, 'build', ...argv], { stdio: 'inherit' });
  const mystPath = mystPathOf(argv);

  const doi = parseDocument(readFileSync(mystPath, 'utf8')).getIn(['project', 'doi']);
  if (typeof doi !== 'string' || !doi) {
    process.stderr.write(msg.workflow.releaseNoDoi + '\n');
    return 2;
  }
  const sandbox = z.isSandboxDoi(doi);
  const token =
    flag(argv, 'token') ?? (sandbox ? process.env.ZENODO_TOKEN_SANDBOX : process.env.ZENODO_TOKEN);
  if (!token) {
    process.stderr.write(msg.workflow.releaseNoToken(sandbox) + '\n');
    return 2;
  }

  const pdf = findExportedPdf(paperRoot);
  if (!pdf) {
    process.stderr.write(msg.workflow.releaseNoPdf + '\n');
    return 2;
  }

  const api = new z.ZenodoApi(z.createFetchTransport(), sandbox, token);
  const bundleOut = resolve(flag(argv, 'bundle-out') ?? '_bundle');
  const out = await z.cmdPublish({
    mystPath,
    pdf,
    tag,
    siteUrl: flag(argv, 'site-url') ?? process.env.SITE_URL,
    bundleOut,
    api,
    git: gh.realGitContext,
    instanceRoot: instanceRootOf(argv),
    engineRoot: engineRoot(),
  });
  emit(argv, out.result);

  if (out.exitCode === 0 && process.env.GH_TOKEN) {
    try {
      const files = readdirSync(bundleOut).map((f) => join(bundleOut, f));
      gh.uploadReleaseAsset(paperRoot, tag, files);
      const sha = await gh.realGitContext.headSha(paperRoot);
      gh.postCommitComment(
        paperRoot,
        sha,
        msg.workflow.releaseCommitComment(String(out.result.draft_url ?? out.result.version_doi)),
      );
    } catch (e) {
      process.stderr.write(
        annotate('warning', msg.workflow.releasePostStepsFailed((e as Error).message)) + '\n',
      );
    }
  } else if (out.exitCode !== 0 && process.env.GH_TOKEN) {
    try {
      gh.openFailureIssue(
        paperRoot,
        msg.workflow.releaseFailureIssue(tag),
        String(out.result.message ?? 'unknown error'),
      );
    } catch {
      /* best-effort */
    }
  }
  return out.exitCode;
}

/** `oak deploy-preview <site>`: deploy the inert Stage-1 artifact to Cloudflare Pages (or
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
      artifactRunId: process.env.PAPER_BUILD_RUN_ID,
      cf: {
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      },
      mystPath: mystPathOf(argv),
    },
    { deployer: gh.realPagesDeployer, gh: gh.realGhPr },
  );
  emit(argv, out.result);
  return out.exitCode;
}

/** `oak notify new-version [--pr N | --site <dir>]`, the standalone new-version reminder.
 *  deploy-preview runs the same logic internally ([R16]); this is the manual/testable entry.
 *  The PR number comes from `--pr` or a `.pr-number` in `--site` (read-only, deploy-preview
 *  owns the [R26] delete). */
async function cmdNotify(argv: string[]): Promise<number> {
  if (argv[0] !== 'new-version') {
    process.stderr.write(msg.workflow.notifyUsage + '\n');
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
    process.stderr.write(msg.workflow.notifyNoPr + '\n');
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
  emit(rest, out.result);
  return out.exitCode;
}

/** `oak validate`: run the journal-controlled checks (slice 4). Layer A (engine invariants,
 *  also the `oak build` pre-flight phase) + Layer B (journal-selected editorial checks). Emits
 *  the report to stdout and, with `--report <path>`, writes the full JSON envelope for the
 *  Stage-2 `oak check-post` job to post. Does NOT post to GitHub itself, all PR write-back is
 *  now uniform Stage-2 (the untrusted validate job holds no write token). */
/** The paper's declared edition, or null. `oak validate` must survive a paper with a missing
 *  or malformed engine coordinate (that is itself a finding), so this never throws. */
function readEditionQuietly(paperRoot: string): string | null {
  try {
    const v = parseDocument(readFileSync(join(paperRoot, 'myst.yml'), 'utf8')).getIn([
      'project',
      'options',
      'oaktree-sapling',
      'edition',
    ]);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * Write the `--report` envelope for a run that could NOT produce one. Stage 1's guard in the
 * frozen `check.yml` only asks `jq -e '.checkRun.conclusion'`, so a missing file is
 * indistinguishable from any other fault and the author is told "engine crash" and nothing
 * else. A validator is a reporter first ([R82]'s "a gate that crashes tells the author less
 * than one that says what it could not do"), so even a usage error or an unexpected throw
 * leaves a well-formed failing report, and Stage 2 posts the actual reason on the PR.
 * Best-effort: if even this write fails, the old "no valid report" path still catches it.
 */
function writeFailureReport(reportPath: string | undefined, title: string, message: string): void {
  if (!reportPath) return;
  try {
    writeFileSync(
      resolve(reportPath),
      JSON.stringify(
        {
          status: 'error',
          errors: [message],
          warnings: [],
          checks: [],
          notes: [],
          checkRun: {
            conclusion: 'failure',
            title,
            summary: `**${title}**\n\n${'```'}\n${message}\n${'```'}`,
            annotations: [],
          },
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort: the Stage-1 guard remains the backstop */
  }
}

/**
 * The human rendering of a validate run. Without `--json` the reader gets the verdict and
 * the findings that produced it, not the envelope: the envelope exists for `check-post`
 * (which reads `--report <path>`), and a terminal reader has no use for its `checkRun`
 * markdown. Every finding still appears; a shorter summary that DROPS findings would be a
 * different verdict, which is the one thing a validator may never do.
 */
function validateSummary(out: {
  status: string;
  errors: Array<{ check: string; message: string }>;
  warnings: Array<{ check: string; message: string }>;
  checks: Array<{ id: string; status: string; message?: string; optional?: boolean }>;
  notes: string[];
}): string[] {
  const passed = out.checks.filter((c) => String(c.status) === 'pass').length;
  const counts = [
    out.errors.length ? msg.validate.countErrors(out.errors.length) : '',
    out.warnings.length ? msg.validate.countWarnings(out.warnings.length) : '',
    out.checks.length ? msg.validate.countChecks(passed, out.checks.length) : '',
  ].filter(Boolean);
  const lines = [msg.validate.verdict(out.status === 'ok', counts)];
  for (const e of out.errors) lines.push(`  ✗ ${e.check}: ${e.message}`);
  for (const w of out.warnings) lines.push(`  ! ${w.check}: ${w.message}`);
  for (const c of out.checks) {
    if (String(c.status) === 'pass') continue;
    lines.push(`  ${c.optional ? '!' : '✗'} ${c.id}: ${c.message ?? String(c.status)}`);
  }
  for (const n of out.notes) lines.push(`  → ${n}`);
  return lines;
}

async function cmdValidate(argv: string[]): Promise<number> {
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  const reportPath = flag(argv, 'report');
  // Same shape check as `oak build`: without it, a validate typed in the journal clone dies on
  // the engine coordinate a journal repo never has, and reports it as an engine crash.
  if (isJournalRepo(paperRoot)) {
    const text = msg.validate.inJournalRepo(paperRoot);
    process.stderr.write(annotate('error', text) + '\n');
    writeFailureReport(reportPath, msg.workflow.validateCouldNotRun, text);
    return 2;
  }
  const resolved = resolveInstanceRoot(argv, paperRoot, 'validate');
  if ('error' in resolved) {
    process.stderr.write(annotate('error', resolved.error) + '\n');
    writeFailureReport(reportPath, msg.workflow.validateCouldNotRun, resolved.error);
    return 2;
  }
  const instanceRoot = resolved.root;
  const strict = has(argv, 'strict');

  const gh = await import('./gh.js');
  const repo = flag(argv, 'repo') ?? process.env.GITHUB_REPOSITORY ?? gh.originRepo(paperRoot);

  const { runValidate } = await import('./validate.js');
  const { createMystEdge } = await import('./myst.js');

  // myst-cli writes progress to STDOUT, the `📖/📚 Built…` logger lines AND a raw `console.debug`
  // from `new Session()` that bypasses its own logger, which would corrupt the JSON `emit()` puts
  // there. Forward every stdout write to stderr for the duration of the run (preserving myst's own
  // formatting), so stdout carries ONLY our machine-readable payload; restore before we emit.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let out;
  try {
    out = await runValidate(
      {
        // The SAME inputs `oak build` materializes from, taken from the SAME builder rather
        // than re-listed here. [R82] shared `materializeDerived` and claimed neither verb
        // could drift; the function was shared but its inputs were not, and validate stamped
        // a different `template:` than the build in the same tree. Spreading the builder is
        // what makes that structural: a field added for build reaches validate with it.
        // [R72] disjointness needs the engine layer + which edition file to compare; the
        // engine root + instance are ALSO what let validate compose ([R82]); without both it
        // degrades to the author's config and says so in the report.
        ...materializeInputFrom(argv, paperRoot, instanceRoot),
        edge: createMystEdge(),
        edition: readEditionQuietly(paperRoot),
      },
      { strict, repo, pathBase: process.env.GITHUB_WORKSPACE ?? paperRoot },
    );
  } catch (err) {
    // runValidate already guards the Layer-A/Layer-B faults it can name. Anything reaching
    // here is an ENGINE fault, and it must still leave a readable report: the alternative is
    // the bare "engine crash" Stage-1 line, which names neither the fault nor the file.
    process.stdout.write = realStdoutWrite;
    // A UserError is a paper that needs fixing, not a crash: report its sentence (and only its
    // sentence: a stack in a Check Run summary tells an author nothing they can act on).
    const userFault = err instanceof UserError;
    const message = userFault ? (err as Error).message : String((err as Error)?.stack ?? err);
    process.stderr.write(
      annotate('error', userFault ? message : msg.workflow.validateCrashLine(message)) + '\n',
    );
    writeFailureReport(
      reportPath,
      userFault ? msg.workflow.validateCouldNotRun : msg.workflow.validateCrashed,
      message,
    );
    return userFault ? 2 : 1;
  } finally {
    process.stdout.write = realStdoutWrite;
  }

  emit(
    argv,
    {
      status: out.status,
      errors: out.errors,
      warnings: out.warnings,
      checks: out.checks,
      // Only when there is something to say: a composed run is the normal case and stays quiet,
      // an UNCOMPOSED one must announce itself ([R82]); the report is the only place a reader
      // learns that these findings came from the author's config rather than the composed one.
      ...(out.notes.length ? { notes: out.notes } : {}),
      checkRun: out.checkRun,
    },
    () => validateSummary(out),
  );

  // `--report <path>`: write the FULL envelope (checkRun always included) for the Stage-2
  // `oak check-post` job, which reads it in trusted base context and posts the Check Run +
  // sticky comment. Stage 1 never posts (it holds no write token over fork content).
  if (reportPath) {
    writeFileSync(
      resolve(reportPath),
      JSON.stringify(
        {
          status: out.status,
          errors: out.errors,
          warnings: out.warnings,
          checks: out.checks,
          notes: out.notes,
          checkRun: out.checkRun,
        },
        null,
        2,
      ),
    );
  }
  return out.exitCode;
}

/** `oak check-post --report <path> --repo <o/r> --sha <headsha> [--pr <n>]`, Stage-2 write-back
 *  (slice 4b). Reads the precomputed `oak validate` report and posts a first-class Check Run on
 *  the PR HEAD sha plus, when a PR, an always-on sticky comment. Runs in trusted base context
 *  (checks:write + pull-requests:write); never re-runs validate or touches myst. Best-effort:
 *  a failing post degrades to a `::warning::`, never fails the job (needs GH_TOKEN). */
async function cmdCheckPost(argv: string[]): Promise<number> {
  const reportPath = flag(argv, 'report');
  const repo = flag(argv, 'repo') ?? process.env.GITHUB_REPOSITORY;
  const sha = flag(argv, 'sha');
  const pr = flag(argv, 'pr');
  // Frozen-shim advisory ([R83]): --base + --verified-head come from the workflow_run event
  // (GitHub-set, not the fork-controlled artifact), so a PR that edits `.github/`/`CODEOWNERS`
  // is flagged even if the artifact lies. Absent ⇒ no advisory (back-compat).
  const base = flag(argv, 'base');
  const verifiedHead = flag(argv, 'verified-head');
  if (!reportPath || !repo || !sha) {
    process.stderr.write(msg.workflow.checkPostArgs + '\n');
    return 2;
  }
  if (!existsSync(reportPath)) {
    process.stderr.write(msg.workflow.checkPostNoReport(reportPath) + '\n');
    return 2;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  const gh = await import('./gh.js');
  const { cmdCheckPost: run, frozenPathsTouched } = await import('./checks.js');
  const shimTouched =
    base && verifiedHead ? frozenPathsTouched(gh.changedFiles(repo, base, verifiedHead)) : [];
  const out = run(
    { report, repo, sha, pr, shimTouched },
    {
      checkRun: gh.realCheckRun,
      sticky: (root, prNum, header, body) => gh.realGhPr.sticky(root, prNum, header, body),
    },
  );
  emit(argv, { ...out });
  return 0;
}

/** Default engine home pin, matching readEngineRepo's fallback ([R56]). */
const ENGINE_REPO_DEFAULT = 'pollomarzo/whitelabel';

/** Confirm gate: print the plan to stderr, then honour --yes (required non-TTY) or prompt. */
function makeConfirm(argv: string[]): (plan: string[]) => Promise<boolean> {
  return async (plan) => {
    for (const line of plan) process.stderr.write(line + '\n');
    if (has(argv, 'yes')) return true;
    if (!process.stdin.isTTY) {
      process.stderr.write(msg.prompt.nonTty + '\n');
      return false;
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ans = (await rl.question(msg.prompt.proceed)).trim();
    rl.close();
    if (/^y/i.test(ans)) return true;
    // Every abort says WHY. A bare `{"status":"aborted"}` after a prompt that defaults to No
    // reads as the tool refusing, not as the answer being taken at its word.
    process.stderr.write(msg.prompt.declined(ans) + '\n');
    return false;
  };
}

function workdir(prefix: string): () => string {
  return () => mkdtempSync(join(tmpdir(), prefix));
}

function secretsFrom(argv: string[]) {
  return {
    zenodoToken: flag(argv, 'zenodo-token') ?? process.env.ZENODO_TOKEN,
    zenodoTokenSandbox: flag(argv, 'zenodo-token-sandbox') ?? process.env.ZENODO_TOKEN_SANDBOX,
    cfToken: flag(argv, 'cf-token') ?? process.env.CLOUDFLARE_API_TOKEN,
    cfAccount: flag(argv, 'cf-account') ?? process.env.CLOUDFLARE_ACCOUNT_ID,
  };
}

/** The typed secret flags, for the refusals that distinguish a typed one from an env value. */
const SECRET_FLAGS = ['zenodo-token', 'zenodo-token-sandbox', 'cf-token', 'cf-account'] as const;

/** `oak bootstrap <paper|journal>`: onboarding (slice 5). */
async function cmdBootstrap(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const gh = await import('./gh.js');
  const bootstrap = await import('./bootstrap.js');
  const paperTemplateRoot = bootstrap.paperTemplateRoot(engineRoot());
  const instanceTemplateRoot = bootstrap.instanceTemplateRoot(engineRoot());
  const siteTemplateRoot = bootstrap.siteTemplateRoot(engineRoot());
  const mystRange = bootstrap.engineMystRange(engineRoot());

  const repo = flag(rest, 'repo');
  if (!repo) {
    process.stderr.write(msg.workflow.bootstrapNoRepo + '\n');
    return 2;
  }
  // Argument-shape refusals come before any gh call ([R127]).
  const external = sub === 'journal' && has(rest, 'external');
  if (sub === 'journal') {
    if (external === has(rest, 'co-located')) {
      process.stderr.write(msg.workflow.bootstrapJournalTier + '\n');
      return 2;
    }
    // A typed secret flag sets nothing on the external tier; env values stay tolerated ([R127]).
    if (external && SECRET_FLAGS.some((f) => flag(rest, f))) {
      process.stderr.write(msg.workflow.bootstrapSecretsNeedPaper + '\n');
      return 2;
    }
  }
  gh.assertGhReady();
  const engineRepo = flag(rest, 'engine-repo') ?? ENGINE_REPO_DEFAULT;
  let engineVersion = flag(rest, 'engine-version');
  // How the version was arrived at is part of the plan, not a detail: "the newest release
  // right now" and "the tag you named" are different promises, and only one of them is
  // reproducible next month.
  const engineVersionFrom: 'flag' | 'latest-release' = engineVersion ? 'flag' : 'latest-release';
  if (!engineVersion) {
    try {
      engineVersion = gh.latestEngineRelease(engineRepo);
    } catch {
      process.stderr.write(msg.workflow.bootstrapNoRelease + '\n');
      return 2;
    }
  }
  const resolved = {
    engineVersionFrom,
    engineRepoFrom: (flag(rest, 'engine-repo') ? 'flag' : 'default') as 'flag' | 'default',
  };
  const deps = {
    prov: gh.realProvisioner,
    paperTemplateRoot,
    instanceTemplateRoot,
    siteTemplateRoot,
    mystRange,
    log: (m: string) => process.stderr.write(m + '\n'),
    confirm: makeConfirm(rest),
    workdir: workdir('oak-bootstrap-'),
  };

  if (sub === 'paper') {
    const out = await bootstrap.cmdBootstrapPaper(
      {
        repo,
        from: flag(rest, 'from'),
        sourceRef: flag(rest, 'source-ref'),
        instance: flag(rest, 'instance'),
        // NOT defaulted (unlike `bootstrap journal`, where the scaffold's own edition file is
        // named from the same value and so agrees with itself). A paper is joining a journal
        // that already has editions; a literal `edition` invented here matches none of them,
        // and the paper's CI fails on the missing edition file long after this command said ok.
        edition: flag(rest, 'edition'),
        engineVersion,
        engineRepo,
        owner: flag(rest, 'owner'),
        authedUser: gh.authedUser(),
        private: has(rest, 'private'),
        requireChecks: !has(rest, 'no-require-checks'),
        secrets: secretsFrom(rest),
        resolved,
      },
      deps,
    );
    emit(rest, out.result, narrated);
    return out.exitCode;
  }

  if (sub === 'journal') {
    const out = await bootstrap.cmdBootstrapJournal(
      {
        repo,
        tier: external ? 'external' : 'co-located',
        name: flag(rest, 'name'),
        // Defaulted (and declared in the plan): the scaffold NAMES its own edition file from
        // this value, so `edition` is self-consistent here, a placeholder the tenant renames,
        // not a claim about someone else's journal.
        edition: flag(rest, 'edition'),
        engineVersion,
        engineRepo,
        owner: flag(rest, 'owner'),
        authedUser: gh.authedUser(),
        requireChecks: !has(rest, 'no-require-checks'),
        site: !has(rest, 'no-site'),
        secrets: secretsFrom(rest),
        resolved,
      },
      deps,
    );
    emit(rest, out.result, narrated);
    return out.exitCode;
  }

  process.stderr.write(msg.workflow.bootstrapUsage + '\n');
  return 2;
}

/** `oak upgrade`: render-and-compare lifecycle (slice 5). */
async function cmdUpgrade(argv: string[]): Promise<number> {
  const gh = await import('./gh.js');
  const upgrade = await import('./upgrade.js');

  const paper = flag(argv, 'paper');
  const repo = flag(argv, 'repo');
  if (!paper && !repo) {
    process.stderr.write(msg.upgrade.missingTarget + '\n');
    return 2;
  }
  const mode: UpgradeMode = has(argv, 'version-only')
    ? 'version-only'
    : has(argv, 'files-only')
      ? 'files-only'
      : 'both';
  const repoRoot = paper ? resolve(paper) : gh.tempClone(repo!);

  const out = await upgrade.cmdUpgrade(
    { repoRoot, to: flag(argv, 'to'), mode },
    {
      resolveTarget: gh.latestEngineRelease,
      materializeTemplate: gh.materializeTemplate,
      pr: gh.realUpgradePr,
      log: (m) => process.stderr.write(m + '\n'),
      confirm: makeConfirm(argv),
    },
  );
  emit(argv, out.result, narrated);
  return out.exitCode;
}

/** `oak conformance`: the paper-CI conformance harness (plan-paper-ci-conformance.md). Slice
 *  C0: `reset` (idempotent teardown of a cert run's ephemeral state). */
async function cmdConformance(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const gh = await import('./gh.js');
  const conformance = await import('./conformance.js');
  const deps = { gh: gh.realConformanceGh, log: (m: string) => process.stderr.write(m + '\n') };

  if (sub === 'reset') {
    const repo = flag(rest, 'repo');
    if (!repo) {
      process.stderr.write(msg.workflow.conformanceResetArgs + '\n');
      return 2;
    }
    const out = await conformance.cmdConformanceReset({ repo }, deps);
    emit(rest, out.result);
    return out.exitCode;
  }

  if (sub === 'certify') {
    const repo = flag(rest, 'repo');
    const tag = flag(rest, 'tag');
    if (!repo || !tag) {
      process.stderr.write(msg.workflow.conformanceCertifyArgs + '\n');
      return 2;
    }
    const upgrade = await import('./upgrade.js');
    // Optional fork-PR preview phase: enabled only when a fork repo + its PAT are both present
    // (otherwise the phase self-skips, so certs keep working before the fork is provisioned).
    const forkRepo = flag(rest, 'fork-repo') ?? process.env.CONFORMANCE_FORK_REPO;
    const forkToken = process.env.CONFORMANCE_FORK_PAT;
    const out = await conformance.cmdConformanceCertify(
      { repo, tag, runId: flag(rest, 'run-id') },
      {
        ...deps,
        fork: forkRepo && forkToken ? { repo: forkRepo, token: forkToken } : null,
        sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
        probe: async (url) => {
          try {
            return (await fetch(url)).status;
          } catch {
            return 0;
          }
        },
        // Dogfood the migration path in-process: `oak upgrade --both` against a fresh clone.
        installEngine: async (r, t) => {
          const up = await upgrade.cmdUpgrade(
            { repoRoot: gh.tempClone(r), to: t, mode: 'both' },
            {
              resolveTarget: gh.latestEngineRelease,
              materializeTemplate: gh.materializeTemplate,
              pr: gh.realUpgradePr,
              log: deps.log,
              confirm: async () => true,
            },
          );
          const prUrl = (up.result.pr as string | null) ?? null;
          return {
            upToDate: Boolean(up.result.up_to_date),
            prUrl,
            prNumber: prUrl ? Number(prUrl.split('/').pop()) : null,
          };
        },
      },
    );
    emit(rest, out.result);
    // The tag-keyed cert record (the C5 promotion-gate seam): persist the verdict for a later
    // gate to read. `--record` writes it to a file the workflow can attach to the engine tag's
    // release: the FILE is the machine channel (stdout carries the envelope only under
    // `--json`), which is why the conformance workflow passes `--record` and parses nothing.
    const record = flag(rest, 'record');
    if (record) writeFileSync(resolve(record), JSON.stringify(out.result, null, 2) + '\n');
    return out.exitCode;
  }

  process.stderr.write(msg.workflow.conformanceUsage + '\n');
  return 2;
}

const VERBS: Verb[] = [
  'build',
  'start',
  'validate',
  'check-post',
  'deploy-preview',
  'deposit',
  'release',
  'notify',
  'bootstrap',
  'upgrade',
  'conformance',
];

/** Levenshtein distance: only ever run over two short command words. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The closest command to a typo, or null when nothing is close enough to suggest. */
function nearestVerb(word: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of VERBS) {
    const d = editDistance(word.toLowerCase(), v);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return bestD <= 3 ? best : null;
}

async function main(argv: string[]): Promise<number> {
  const verb = argv[0] as Verb | undefined;
  // One switch, read by gh.ts, so `--verbose` reaches the subprocess layer without threading
  // a parameter through every seam (and survives the child process `oak release` spawns).
  if (has(argv, 'verbose')) process.env.OAK_VERBOSE = '1';
  if (verb === 'build') return cmdBuild(argv.slice(1));
  if (verb === 'start') return cmdStart(argv.slice(1));
  if (verb === 'validate') return cmdValidate(argv.slice(1));
  if (verb === 'check-post') return cmdCheckPost(argv.slice(1));
  if (verb === 'deposit') return cmdDeposit(argv.slice(1));
  if (verb === 'release') return cmdRelease(argv.slice(1));
  if (verb === 'deploy-preview') return cmdDeployPreview(argv.slice(1));
  if (verb === 'notify') return cmdNotify(argv.slice(1));
  if (verb === 'bootstrap') return cmdBootstrap(argv.slice(1));
  if (verb === 'upgrade') return cmdUpgrade(argv.slice(1));
  if (verb === 'conformance') return cmdConformance(argv.slice(1));
  // A word we do not know is an ERROR, not an invitation to read the manual. Printing usage
  // alone answers a question nobody asked and hides the one that matters: a typo looks exactly
  // like a bare `oak`, so the reader assumes the command ran and did nothing.
  if (verb) {
    const near = nearestVerb(verb);
    process.stderr.write(msg.unknownCommand(verb, near) + '\n');
  }
  process.stderr.write(msg.usage());
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    // A UserError was WRITTEN for whoever typed the command: one sentence naming the file and
    // the fix, exit 2 (a usage failure), no stack; the UX test's worst moment was a missing
    // config line reported as a five-frame trace through the bundle. Anything else is an engine
    // bug, and the stack is the only useful thing we have.
    if (err instanceof UserError) {
      process.stderr.write(annotate('error', err.message) + '\n');
      process.exit(2);
    }
    process.stderr.write(annotate('error', msg.engineCrash(String(err?.stack ?? err))) + '\n');
    process.exit(1);
  },
);
