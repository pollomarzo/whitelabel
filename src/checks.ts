/**
 * checks.ts: the journal-controlled editorial check layer (slice 4 "Layer B").
 *
 * The editorial checks themselves are provided by the MIT-licensed
 * `@curvenote/check-implementations` (the runnable catalog) + `@curvenote/check-definitions`
 * (the contract types + check definitions), a dependency, credited in engine/README.md.
 *
 * This module supplies the journal-driven RUNNER (`runChecks`, the journal's `journal.yml`
 * `checks:` selects which catalog checks run + marks them optional; the paper author cannot
 * weaken the set) and the GitHub Check-Run REPORTER (`toCheckRun`, pure). MyST `error_rules`
 * is NOT used for the gate: it is author-overridable, so it can't be the journal's contract.
 */
import { basename, isAbsolute, relative } from 'node:path';
import { DERIVED_CONFIG_FILE } from './yaml-io.js';
import * as messages from './messages.js';
import { annotate } from './messages.js';
import type { ISession } from 'myst-cli';
import {
  checks as CURVENOTE_DEFINITIONS,
  CheckStatus,
  type Check,
  type CheckDefinition,
  type CheckResult,
  type CheckTags,
} from '@curvenote/check-definitions';

// The RUNNABLE catalog (`@curvenote/check-implementations`) transitively loads myst-cli, which
// crashes unbundled on Node 24 (the docx interop bug, [R51]). So it is imported DYNAMICALLY, only
// when checks actually run (through the esbuild bundle), keeping the pure reporter + Layer-A unit
// tests free of the toolchain, exactly as `@curvenote/check-definitions` (types + ids) is safe to
// import statically.
type CheckInterface = CheckDefinition & {
  validate: (
    session: ISession,
    options: Check,
  ) => Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
};
async function curvenoteChecks(): Promise<CheckInterface[]> {
  const mod = await import('@curvenote/check-implementations');
  return mod.checks as CheckInterface[];
}

// Re-export the curvenote contract so the rest of the engine has one import site for the shape.
export { CheckStatus };
export type { Check, CheckDefinition, CheckResult, CheckTags };

/** Their `CheckResult` carries no `id` (it is keyed by the check that produced it); we stamp
 *  the journal-selected id on so the reporter can render + group results. */
export type EngineCheckResult = CheckResult & { id: string };

/** The ids the engine can run: the full curvenote catalog (a journal selects any subset). */
export const CHECK_CATALOG_IDS = CURVENOTE_DEFINITIONS.map((c) => c.id);

export interface JournalCheck {
  id: string;
  optional?: boolean;
  [k: string]: unknown;
}

/**
 * Run the journal's selected curvenote checks against a loaded+processed myst Session (see
 * `MystEdge.withProjectSession`). For each journal check `{id, optional?, ...options}` we find
 * the matching `CheckInterface` in their catalog, `await validate(session, check)`, flatten the
 * results, stamp the id (and `optional` when the journal marked it so, an optional fail never
 * gates). An unknown id surfaces as a `status:'error'` result (a journal misconfig, surfaced,
 * not silently skipped).
 */
export async function runChecks(
  session: ISession,
  journalChecks: JournalCheck[],
): Promise<EngineCheckResult[]> {
  const catalog = await curvenoteChecks();
  const out: EngineCheckResult[] = [];
  for (const jc of journalChecks) {
    const impl = catalog.find((c) => c.id === jc.id);
    if (!impl) {
      out.push({
        id: jc.id,
        status: CheckStatus.error,
        message: messages.pr.unknownCheckId(jc.id),
      });
      continue;
    }
    const { optional, ...check } = jc;
    const res = await impl.validate(session, check as Check);
    for (const r of Array.isArray(res) ? res : [res]) {
      out.push({ ...r, id: jc.id, ...(optional ? { optional: true } : {}) });
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Reporting: the GitHub Check-Run payload (pure, OURS). The CI step POSTs this via gh.ts.
 * ------------------------------------------------------------------------ */

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'failure' | 'warning' | 'notice';
  message: string;
}

export interface CheckRun {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  annotations: CheckRunAnnotation[];
}

/** GitHub caps annotations at 50 per check-run API request. */
const GITHUB_MAX_ANNOTATIONS = 50;

/**
 * Map check results → a GitHub Check-Run payload. A non-optional fail/error → `failure`
 * conclusion (gates merge); optional findings annotate as warnings and never gate. Results
 * carrying `file`+`position` become inline annotations (capped at 50).
 *
 * GitHub's Checks API keys annotations off REPO-RELATIVE paths; a path it can't resolve is
 * dropped (a batch of them 422s the whole POST). curvenote is inconsistent, some checks emit
 * an absolute `file` (`selectCurrentProjectFile`), others a relative one (`loadProjectFromDisk`
 * → `index.md`). So `pathBase` (the repo checkout root, `GITHUB_WORKSPACE`, else the paper
 * root) relativizes ONLY the absolute paths; already-relative ones pass through untouched.
 *
 * A finding anchored to the DERIVED config never annotates. Since [R82] the session reads
 * `myst.oak.yml`, so curvenote's config-anchored results (`getFrontmatter` returns
 * `selectCurrentProjectFile`) now name a generated, gitignored file: GitHub cannot resolve
 * the path, and rewriting it to `myst.yml` would be worse: the derived file has a banner, an
 * injected `extends:` block and compose's stamps, so its line numbers are not the author's.
 * A confident annotation on an unrelated line beats no annotation for nobody. The finding
 * still lands in the summary table and the sticky comment; only the inline pin is dropped.
 */
export function toCheckRun(
  results: EngineCheckResult[],
  pathBase?: string,
  notes: string[] = [],
): CheckRun {
  const failed = results.filter(
    (r) => r.status === CheckStatus.fail || r.status === CheckStatus.error,
  );
  const blocking = failed.filter((r) => !r.optional);
  const passed = results.filter((r) => r.status === CheckStatus.pass);

  const conclusion: CheckRun['conclusion'] = blocking.length ? 'failure' : 'success';
  const title = messages.pr.checkRunTitle(passed.length, failed.length);

  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const rows = results
    .map(
      (r) =>
        `| ${esc(r.id)} | ${r.status}${r.optional ? ' (optional)' : ''} | ${esc(r.message ?? '')} |`,
    )
    .join('\n');
  const table = `${messages.pr.checkTableHeader}\n${rows}`;
  // Notes describe HOW the run happened, never WHETHER it passed; they must not touch
  // `conclusion`. But they have to be VISIBLE: a run that could not compose reads the
  // author's config, so some of the passes below mean less than they look like they do, and
  // the Check Run is where a reviewer actually looks. Above the table, not below it.
  const summary = notes.length
    ? `${notes.map((n) => `> ⚠️ ${n}`).join('\n>\n')}\n\n${table}`
    : table;

  const annotations: CheckRunAnnotation[] = failed
    .filter((r) => r.file && r.position && basename(r.file) !== DERIVED_CONFIG_FILE)
    .slice(0, GITHUB_MAX_ANNOTATIONS)
    .map((r) => ({
      path: pathBase && isAbsolute(r.file!) ? relative(pathBase, r.file!) : r.file!,
      start_line: r.position!.start.line,
      end_line: (r.position!.end ?? r.position!.start).line,
      annotation_level: (r.optional ? 'warning' : 'failure') as 'warning' | 'failure',
      message: [r.message, r.help].filter(Boolean).join('; '),
    }));

  return { conclusion, title, summary, annotations };
}

/* --------------------------------------------------------------------------
 * Stage-2 PR write-back: the sticky comment + Check Run poster (slice 4b).
 *
 * All PR write-back moves to the trusted Stage-2 `workflow_run` job (base context): the
 * untrusted `pull_request` job that runs `oak validate` over fork content holds no write
 * token. Stage 1 writes the report file; Stage 2 runs `oak check-post`, which reads that
 * precomputed report and posts BOTH a first-class Check Run (gates + annotates) AND an
 * always-on sticky PR comment (visibility, authors rarely click the Check Run "Details").
 * Never re-runs validate / rebuilds paper content.
 * ------------------------------------------------------------------------ */

/** Sticky-comment header for the journal-checks PR comment (stable identifier, do not rename;
 *  the upsert key `<!-- oak-sticky: oak-journal-checks -->` is baked into posted comments). */
export const STICKY_CHECKS = 'oak-journal-checks';

/** The `oak validate --report` payload check-post reads. Only `checkRun` is load-bearing here
 *  (the rest of the validate envelope is carried for completeness / debugging). */
export interface ChecksReport {
  status?: 'ok' | 'error';
  checkRun: CheckRun;
  /** `oak validate`'s info-level notes ([R82]), for anything reading the report directly.
   *  Stage 2 does not re-render them: `toCheckRun` already embedded them in `checkRun.summary`,
   *  which both the Check Run and the sticky comment print, so a DEGRADED run is visibly
   *  different from a composed one in the PR UI without check-post knowing they exist. */
  notes?: string[];
  [k: string]: unknown;
}

/**
 * Render the always-on sticky PR comment from a checks report (pure). Opens with the sticky
 * marker so `sticky()` upserts it in place; a headline from the Check-Run conclusion + title
 * ("N passed, M failed"), then the same markdown table the Check Run carries, then a footer.
 */
export function checksComment(report: ChecksReport, shimTouched: string[] = []): string {
  const { conclusion, title, summary } = report.checkRun;
  const banner = shimTouched.length ? [shimWarning(shimTouched), ''] : [];
  return [
    messages.stickyMarker(STICKY_CHECKS),
    ...banner,
    messages.pr.checksHeadline(conclusion === 'success', title),
    '',
    summary,
    '',
    messages.pr.checksFooter,
  ].join('\n');
}

/** Frozen-shim paths (design §6a): everything under `.github/` plus `CODEOWNERS`. A PR that
 *  touches any of these can change how the checks themselves run, so a report produced under it
 *  cannot be fully trusted: check-post surfaces that as an advisory ([R83]). */
export function frozenPathsTouched(changed: string[]): string[] {
  return changed.filter((p) => p === 'CODEOWNERS' || p.startsWith('.github/'));
}

/** The advisory banner for a PR that edits the frozen shim: a warning, not a gate (it never
 *  changes the Check-Run conclusion): legitimate engine-upgrade PRs edit these files too, so
 *  blocking would be wrong. Renders in both the sticky comment and the Check-Run summary. */
export function shimWarning(touched: string[]): string {
  const shown = touched
    .slice(0, 5)
    .map((f) => `\`${f}\``)
    .join(', ');
  const more = touched.length > 5 ? `, +${touched.length - 5} more` : '';
  return messages.pr.shimWarning(shown, more);
}

/** Seams for `cmdCheckPost`: structurally satisfied by `gh.realCheckRun` and
 *  `gh.realGhPr.sticky`, injected as fakes in unit tests. */
export interface CheckPostDeps {
  checkRun: { create(repo: string, headSha: string, name: string, run: CheckRun): void };
  sticky(repoRoot: string, prNumber: string, header: string, body: string): void;
}

export interface CheckPostOutcome {
  status: 'ok' | 'error';
  checkRunPosted: boolean;
  commentPosted: boolean;
  warnings: string[];
}

/**
 * `oak check-post` orchestration: post the precomputed report's Check Run on the PR HEAD sha
 * and, when a PR number is given, upsert the always-on sticky comment. Best-effort: each post
 * is guarded so a failing seam (e.g. a read-only token) degrades to a `::warning::` and never
 * crashes the Stage-2 job. Posting needs `GH_TOKEN` in the real `gh` seams.
 */
export function cmdCheckPost(
  input: { report: ChecksReport; repo: string; sha: string; pr?: string; shimTouched?: string[] },
  deps: CheckPostDeps,
): CheckPostOutcome {
  const { report, repo, sha, pr } = input;
  const shimTouched = input.shimTouched ?? [];
  const warnings: string[] = [];
  let checkRunPosted = false;
  let commentPosted = false;

  // Advisory only: prefix the Check-Run title + summary so the warning is visible on the check
  // itself, but leave `conclusion` untouched; this must not gate merge (legit upgrade PRs edit
  // the shim too; CODEOWNERS is the real gate). [R83]
  const checkRunToPost = shimTouched.length
    ? {
        ...report.checkRun,
        title: messages.pr.checkRunTitleShimTouched(report.checkRun.title),
        summary: `${shimWarning(shimTouched)}\n\n${report.checkRun.summary}`,
      }
    : report.checkRun;

  try {
    deps.checkRun.create(repo, sha, 'Journal checks', checkRunToPost);
    checkRunPosted = true;
  } catch (e) {
    const msg = messages.workflow.checkPostCheckRunFailed((e as Error).message);
    warnings.push(msg);
    process.stderr.write(annotate('warning', msg) + '\n');
  }

  if (pr) {
    try {
      deps.sticky('.', pr, STICKY_CHECKS, checksComment(report, shimTouched));
      commentPosted = true;
    } catch (e) {
      const msg = messages.workflow.checkPostCommentFailed((e as Error).message);
      warnings.push(msg);
      process.stderr.write(annotate('warning', msg) + '\n');
    }
  }

  // The Check Run IS the merge gate, so failing to post it leaves the PR blocked with nothing
  // said. A comment failure stays cosmetic: the check carries the verdict ([R144]).
  return {
    status: checkRunPosted ? 'ok' : 'error',
    checkRunPosted,
    commentPosted,
    warnings,
  };
}
