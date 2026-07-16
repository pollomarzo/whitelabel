/**
 * checks.ts — the journal-controlled editorial check layer (slice 4 "Layer B").
 *
 * The JOURNAL (instance-config `journal.yml` `checks:`) selects which checks run + their
 * options; the paper author cannot weaken the set (it lives in a repo the author doesn't
 * control). Each check is a PURE function of the RESOLVED myst project frontmatter (what myst
 * sees post-extends) — no AST, no network for this MVP — so results carry a position the CI
 * reporter can render as GitHub Check-Run annotations.
 *
 * The CheckResult / CheckDefinition contract deliberately mirrors curvenote's MIT
 * `@curvenote/check-definitions` SHAPE (for interoperability) but we implement the checks
 * ourselves rather than depend on that package (a competitor product component — see the
 * slice-4 scope doc). MyST `error_rules` is NOT used: it is author-overridable, so it can't be
 * the journal's gate.
 */

export type CheckStatus = 'pass' | 'fail' | 'error';

export interface CheckDefinition {
  id: string;
  title: string;
  tags?: string[];
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  message?: string;
  /** A short "how to fix" for a failure (rendered into the annotation). */
  help?: string;
  /** Source file the finding points at (annotation path). */
  file?: string;
  /** 1-based location, when known (annotation line). */
  position?: { line: number; column?: number };
  /** Set when the journal marked the check optional — an optional fail never gates merge. */
  optional?: boolean;
}

/** The subset of resolved myst frontmatter the editorial checks read. */
export interface ProjectFrontmatter {
  title?: string;
  abstract?: string;
  keywords?: string[];
  authors?: Array<{ name?: string; orcid?: string; roles?: string[]; [k: string]: unknown }>;
  /** myst normalizes a frontmatter `abstract:` (or an `{part: abstract}` block) into
   *  `parts.abstract` — a non-empty array of block references — and drops the top-level
   *  `abstract` field. So the abstract check must look here, not only at `abstract`. */
  parts?: Record<string, unknown>;
  [k: string]: unknown;
}

/** True when the resolved project carries a non-empty myst `part` of the given name. */
const hasPart = (p: ProjectFrontmatter, name: string): boolean => {
  const v = p.parts?.[name];
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return v != null;
};

interface CheckImpl {
  def: CheckDefinition;
  run(project: ProjectFrontmatter): CheckResult | CheckResult[];
}

const pass = (id: string, message?: string): CheckResult => ({ id, status: 'pass', message });
const fail = (id: string, message: string, help?: string): CheckResult => ({
  id,
  status: 'fail',
  message,
  help,
});
const who = (name: string | undefined, i: number) => name ?? `author ${i + 1}`;

/** The MVP catalog — frontmatter-only, offline. Each check is journal-selectable by id. */
const CATALOG: Record<string, CheckImpl> = {
  'authors-exist': {
    def: { id: 'authors-exist', title: 'Authors are defined', tags: ['authors'] },
    run: (p) =>
      p.authors && p.authors.length
        ? pass('authors-exist')
        : fail('authors-exist', 'no authors defined', 'Add project.authors in myst.yml'),
  },
  'authors-have-orcid': {
    def: { id: 'authors-have-orcid', title: 'Each author has an ORCID', tags: ['authors'] },
    run: (p) => {
      const authors = p.authors ?? [];
      if (!authors.length) return fail('authors-have-orcid', 'no authors defined');
      return authors.map((a, i) =>
        a.orcid
          ? pass('authors-have-orcid', `${who(a.name, i)} has an ORCID`)
          : fail('authors-have-orcid', `${who(a.name, i)} has no ORCID`, 'Add an orcid to this author'),
      );
    },
  },
  'authors-have-credit-roles': {
    def: { id: 'authors-have-credit-roles', title: 'Each author has CRediT roles', tags: ['authors'] },
    run: (p) => {
      const authors = p.authors ?? [];
      if (!authors.length) return fail('authors-have-credit-roles', 'no authors defined');
      return authors.map((a, i) =>
        a.roles && a.roles.length
          ? pass('authors-have-credit-roles', `${who(a.name, i)} has CRediT roles`)
          : fail(
              'authors-have-credit-roles',
              `${who(a.name, i)} has no CRediT roles`,
              'Add roles: to this author',
            ),
      );
    },
  },
  'abstract-exists': {
    def: { id: 'abstract-exists', title: 'Abstract exists', tags: ['abstract'] },
    run: (p) =>
      (p.abstract && p.abstract.trim()) || hasPart(p, 'abstract')
        ? pass('abstract-exists')
        : fail('abstract-exists', 'no abstract', 'Add an abstract to index.md frontmatter'),
  },
  'keywords-defined': {
    def: { id: 'keywords-defined', title: 'Keywords are defined', tags: ['keywords'] },
    run: (p) =>
      p.keywords && p.keywords.length
        ? pass('keywords-defined')
        : fail('keywords-defined', 'no keywords', 'Add project.keywords in myst.yml'),
  },
};

/** The ids the engine ships an implementation for (a journal can select any subset). */
export const CHECK_CATALOG_IDS = Object.keys(CATALOG);

export interface JournalCheck {
  id: string;
  optional?: boolean;
  [k: string]: unknown;
}

/**
 * Run the journal's selected checks against the resolved project frontmatter. An unknown id
 * surfaces as a `status:'error'` result (a journal misconfig — surfaced, not silently skipped).
 * An `optional` check's results are stamped `optional` so the reporter keeps them off the gate.
 */
export function runChecks(project: ProjectFrontmatter, journalChecks: JournalCheck[]): CheckResult[] {
  const out: CheckResult[] = [];
  for (const jc of journalChecks) {
    const impl = CATALOG[jc.id];
    if (!impl) {
      out.push({ id: jc.id, status: 'error', message: `unknown check id "${jc.id}"` });
      continue;
    }
    const res = impl.run(project);
    for (const r of Array.isArray(res) ? res : [res]) {
      out.push(jc.optional ? { ...r, optional: true } : r);
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Reporting — the GitHub Check-Run payload (pure). The CI step POSTs this via gh.ts.
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
 */
export function toCheckRun(results: CheckResult[]): CheckRun {
  const failed = results.filter((r) => r.status === 'fail' || r.status === 'error');
  const blocking = failed.filter((r) => !r.optional);
  const passed = results.filter((r) => r.status === 'pass');

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
      start_line: r.position!.line,
      end_line: r.position!.line,
      annotation_level: (r.optional ? 'warning' : 'failure') as 'warning' | 'failure',
      message: [r.message, r.help].filter(Boolean).join(' — '),
    }));

  return { conclusion, title, summary, annotations };
}
