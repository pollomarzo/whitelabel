/**
 * validate.ts — `oak validate`, the journal-controlled check aggregator (slice 4).
 *
 * Two layers:
 *   A. Engine pre-flight INVARIANTS (pure): id sentinel/pattern/uniqueness ([R12]), the
 *      canonical layout ([R46]/[R50]), and brand favicon/watermark resolvability
 *      ([R61]/[R62]). These are the engine's own contract — not tenant-editorial — and also
 *      run as the mandatory first phase of `oak build` (fail fast, [R21]).
 *   B. Journal-CONFIGURED editorial checks (checks.ts), selected by `journal.yml` `checks:`.
 *
 * IO (fs, loadConfig) is injected so the pure checks stay unit-testable; the real edge pulls
 * in myst-cli via myst.ts (kept the sole importer). No git here — the caller resolves the repo
 * (for registry-self exclusion) and passes it in, so validate stays pure/testable.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  JournalConfig,
  Registry,
  checkIdShape,
  checkIdUniqueness,
  type IdCheckResult,
} from './schema.js';
import { resolveBrandAssetPath, isBrandAssetUrl } from './compose.js';
import { readBrandAssetOptions } from './yaml-io.js';
import {
  runChecks,
  toCheckRun,
  CheckStatus,
  type EngineCheckResult,
  type CheckRun,
  type JournalCheck,
} from './checks.js';
import type { MystEdge } from './build.js';

export interface FsProbes {
  existsProbe(path: string): boolean;
  /** All paths under a dir, recursive + relative (real impl: readdirSync recursive). */
  listTree(dir: string): string[];
}
const realFs: FsProbes = {
  existsProbe: (p) => existsSync(p),
  listTree: (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []),
};

export interface NamedFinding {
  check: string;
  severity: 'error' | 'warn';
  message: string;
}

/* ---- pure Layer-A checks ------------------------------------------------- */

/** index.md + myst.yml at the paper root, and NO stray secondary myst.yml under it (which
 *  would break the n=1 layout — [R50]). Returns only the problems (empty = clean). */
export function checkLayout(
  paperRoot: string,
  probes: FsProbes,
): Array<{ severity: 'error'; message: string }> {
  const out: Array<{ severity: 'error'; message: string }> = [];
  for (const f of ['index.md', 'myst.yml']) {
    if (!probes.existsProbe(join(paperRoot, f))) {
      out.push({ severity: 'error', message: `missing required file "${f}" at the paper root` });
    }
  }
  const stray = probes
    .listTree(paperRoot)
    .map((f) => f.replace(/\\/g, '/'))
    .filter(
      (f) =>
        f !== 'myst.yml' &&
        /(^|\/)myst\.yml$/.test(f) &&
        !f.startsWith('_build/') &&
        !f.startsWith('node_modules/'),
    );
  for (const s of stray) {
    out.push({
      severity: 'error',
      message: `stray secondary myst.yml at "${s}" breaks the n=1 paper layout`,
    });
  }
  return out;
}

/** Warn on a brand with no resolvable favicon — an unset/broken one fatally 500s the HTML
 *  prerender on /favicon.ico ([R61]). A URL resolves for HTML, so it passes. */
export function checkBrandFavicon(
  input: { instanceRoot: string | null; favicon?: string },
  probes: FsProbes,
): IdCheckResult {
  const { instanceRoot, favicon } = input;
  if (!favicon) {
    return {
      ok: false,
      severity: 'warn',
      message: 'brand declares no favicon; the HTML prerender fatally 500s on /favicon.ico ([R61])',
    };
  }
  if (isBrandAssetUrl(favicon)) return { ok: true };
  const resolved = instanceRoot ? resolveBrandAssetPath(instanceRoot, favicon) : favicon;
  return probes.existsProbe(resolved)
    ? { ok: true }
    : { ok: false, severity: 'warn', message: `brand favicon "${favicon}" does not resolve to a file` };
}

/** Warn on a brand typst watermark (project.options.logo) that is absent, a URL (typst can't
 *  fetch — unlike the HTML favicon), or an unresolvable local file ([R62]/[R68]). */
export function checkBrandWatermark(
  input: { instanceRoot: string | null; logo?: string },
  probes: FsProbes,
): IdCheckResult {
  const { instanceRoot, logo } = input;
  if (!logo) {
    return {
      ok: false,
      severity: 'warn',
      message: 'brand declares no typst watermark (project.options.logo); the PDF renders watermark-less ([R62])',
    };
  }
  if (isBrandAssetUrl(logo)) {
    return {
      ok: false,
      severity: 'warn',
      message: `brand typst watermark "${logo}" is a URL; typst cannot fetch — it must be a real local file ([R62])`,
    };
  }
  const resolved = instanceRoot ? resolveBrandAssetPath(instanceRoot, logo) : logo;
  return probes.existsProbe(resolved)
    ? { ok: true }
    : { ok: false, severity: 'warn', message: `brand typst watermark "${logo}" does not resolve to a file` };
}

/* ---- instance-config readers -------------------------------------------- */

function loadJournal(instanceRoot: string | null, probes: FsProbes): JournalConfig {
  if (instanceRoot) {
    const p = join(instanceRoot, 'journal.yml');
    if (probes.existsProbe(p)) return JournalConfig.parse(parse(readFileSync(p, 'utf8')));
  }
  return JournalConfig.parse({ name: 'unknown' });
}

function loadRegistry(instanceRoot: string | null, probes: FsProbes): Registry | null {
  if (instanceRoot) {
    const p = join(instanceRoot, 'registry', 'papers.yml');
    if (probes.existsProbe(p)) return Registry.parse(parse(readFileSync(p, 'utf8')));
  }
  return null;
}

/** The paper's OWN registry entry (excluded from the uniqueness check), keyed by its GitHub
 *  repo (owner/repo). Without a repo we can't identify self — uniqueness then flags the paper's
 *  own entry as a clash, which the caller avoids by passing the repo (env or git origin). */
function findSelf(registry: Registry | null, repo: string | null): { slug: string } | undefined {
  if (!registry || !repo) return undefined;
  const e = registry.find((x) => x.location.repo === repo);
  return e ? { slug: e.slug } : undefined;
}

/* ---- Layer A aggregate --------------------------------------------------- */

export function runLayerA(
  input: {
    paperRoot: string;
    instanceRoot: string | null;
    project: { id?: string };
    repo: string | null;
  },
  probes: FsProbes = realFs,
): NamedFinding[] {
  const { paperRoot, instanceRoot, project, repo } = input;
  const findings: NamedFinding[] = [];
  const add = (check: string, r: IdCheckResult) => {
    if (!r.ok) findings.push({ check, severity: r.severity, message: r.message });
  };

  const journal = loadJournal(instanceRoot, probes);
  const registry = loadRegistry(instanceRoot, probes);

  if (!project.id) {
    findings.push({ check: 'id-present', severity: 'error', message: 'project.id is missing' });
  } else {
    add('id-shape', checkIdShape(project.id, { id_sentinel: journal.id_sentinel, id_pattern: journal.id_pattern }));
    add(
      'id-uniqueness',
      checkIdUniqueness(project.id, registry, findSelf(registry, repo), { selfIdentifiable: repo != null }),
    );
  }

  for (const r of checkLayout(paperRoot, probes)) {
    findings.push({ check: 'layout', severity: r.severity, message: r.message });
  }

  const brand = instanceRoot ? readBrandAssetOptions(instanceRoot) : { site: {}, project: {} };
  add('brand-favicon', checkBrandFavicon({ instanceRoot, favicon: brand.site.favicon }, probes));
  add('brand-watermark', checkBrandWatermark({ instanceRoot, logo: brand.project.logo }, probes));

  return findings;
}

/* ---- the verb ------------------------------------------------------------ */

export interface ValidateResult {
  status: 'ok' | 'error';
  errors: NamedFinding[];
  warnings: NamedFinding[];
  checks: EngineCheckResult[];
  checkRun: CheckRun;
  exitCode: number;
}

export async function runValidate(
  input: { paperRoot: string; instanceRoot: string | null; edge: MystEdge },
  opts: { strict?: boolean; repo?: string | null } = {},
  probes: FsProbes = realFs,
): Promise<ValidateResult> {
  const project = (await input.edge.loadProject(input.paperRoot)) as { id?: string };
  const repo = opts.repo ?? null;

  // Layer A — engine invariants
  const layerA = runLayerA(
    { paperRoot: input.paperRoot, instanceRoot: input.instanceRoot, project, repo },
    probes,
  );

  // Layer B — journal-configured editorial checks, provided by @curvenote/check-implementations.
  // They read the myst store, so we run them inside a loaded+processed project session (the edge
  // keeps myst-cli confined to myst.ts). The paper's own frontmatter is enough — no two-pass.
  const journal = loadJournal(input.instanceRoot, probes);
  const checks = await input.edge.withProjectSession(input.paperRoot, (session) =>
    runChecks(session, (journal.checks ?? []) as JournalCheck[]),
  );

  const errors = layerA.filter((f) => f.severity === 'error');
  const warnings = layerA.filter((f) => f.severity === 'warn');

  // Combined results for the Check Run: Layer-A findings as synthetic results (errors gate,
  // warns are optional) + the Layer-B editorial results.
  const layerAResults: EngineCheckResult[] = layerA.map((f) => ({
    id: f.check,
    status: CheckStatus.fail,
    message: f.message,
    optional: f.severity === 'warn',
  }));
  const checkRun = toCheckRun([...layerAResults, ...checks]);

  const blockingCheckFail = checks.some((c) => (c.status === CheckStatus.fail || c.status === CheckStatus.error) && !c.optional);
  const hasError = errors.length > 0 || blockingCheckFail;
  const exitCode = hasError ? 1 : opts.strict && warnings.length ? 1 : 0;

  return { status: hasError ? 'error' : 'ok', errors, warnings, checks, checkRun, exitCode };
}
