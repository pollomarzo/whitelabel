/**
 * checks.ts — the journal-controlled editorial check layer (slice 4 "Layer B").
 *
 * The editorial checks themselves are provided by the MIT-licensed
 * `@curvenote/check-implementations` (the runnable catalog) + `@curvenote/check-definitions`
 * (the contract types + check definitions) — a dependency, credited in engine/README.md.
 *
 * This module supplies the journal-driven RUNNER (`runChecks` — the journal's `journal.yml`
 * `checks:` selects which catalog checks run + marks them optional; the paper author cannot
 * weaken the set) and the GitHub Check-Run REPORTER (`toCheckRun`, pure). MyST `error_rules`
 * is NOT used for the gate: it is author-overridable, so it can't be the journal's contract.
 */
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
// when checks actually run (through the esbuild bundle) — keeping the pure reporter + Layer-A unit
// tests free of the toolchain, exactly as `@curvenote/check-definitions` (types + ids) is safe to
// import statically.
type CheckInterface = CheckDefinition & {
  validate: (session: ISession, options: Check) => Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
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

/** The ids the engine can run — the full curvenote catalog (a journal selects any subset). */
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
 * results, stamp the id (and `optional` when the journal marked it so — an optional fail never
 * gates). An unknown id surfaces as a `status:'error'` result (a journal misconfig — surfaced,
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
      out.push({ id: jc.id, status: CheckStatus.error, message: `unknown check id "${jc.id}"` });
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
 * Reporting — the GitHub Check-Run payload (pure, OURS). The CI step POSTs this via gh.ts.
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
 * carrying `file`+`position` become inline annotations (capped at 50). Note: curvenote emits
 * ABSOLUTE `file` paths — GitHub wants repo-relative, but the reporter stays pure (no repo
 * root here); the caller relativizes upstream when it matters.
 */
export function toCheckRun(results: EngineCheckResult[]): CheckRun {
  const failed = results.filter((r) => r.status === CheckStatus.fail || r.status === CheckStatus.error);
  const blocking = failed.filter((r) => !r.optional);
  const passed = results.filter((r) => r.status === CheckStatus.pass);

  const conclusion: CheckRun['conclusion'] = blocking.length ? 'failure' : 'success';
  const title = `${passed.length} passed, ${failed.length} failed`;

  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const rows = results
    .map(
      (r) => `| ${esc(r.id)} | ${r.status}${r.optional ? ' (optional)' : ''} | ${esc(r.message ?? '')} |`,
    )
    .join('\n');
  const summary = `| Check | Status | Detail |\n| --- | --- | --- |\n${rows}`;

  const annotations: CheckRunAnnotation[] = failed
    .filter((r) => r.file && r.position)
    .slice(0, GITHUB_MAX_ANNOTATIONS)
    .map((r) => ({
      path: r.file!,
      start_line: r.position!.start.line,
      end_line: (r.position!.end ?? r.position!.start).line,
      annotation_level: (r.optional ? 'warning' : 'failure') as 'warning' | 'failure',
      message: [r.message, r.help].filter(Boolean).join(' — '),
    }));

  return { conclusion, title, summary, annotations };
}
