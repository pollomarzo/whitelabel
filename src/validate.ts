/**
 * validate.ts: `oak validate`, the journal-controlled check aggregator (slice 4).
 *
 * Two layers:
 *   A. Engine pre-flight INVARIANTS (pure): id sentinel/pattern/uniqueness ([R12]), the
 *      canonical layout ([R46]/[R50]), brand favicon/watermark resolvability
 *      ([R61]/[R62]) and the paper's thumbnail ([R81]). These are the engine's own contract (not tenant-editorial) and also
 *      run as the mandatory first phase of `oak build` (fail fast, [R21]).
 *   B. Journal-CONFIGURED editorial checks (checks.ts), selected by `journal.yml` `checks:`.
 *
 * IO (fs, loadConfig) is injected so the pure checks stay unit-testable; the real edge pulls
 * in myst-cli via myst.ts (kept the sole importer). No git here; the caller resolves the repo
 * (for registry-self exclusion) and passes it in, so validate stays pure/testable.
 */
import * as msg from './messages.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  JournalConfig,
  Registry,
  checkIdShape,
  checkIdUniqueness,
  type IdCheckResult,
} from './schema.js';
import { isAbsolute, join } from 'node:path';
import {
  resolveBrandAssetPath,
  isBrandAssetUrl,
  isInstanceRelativeTemplate,
} from './compose.js';
import { readBrandAssetOptions, readAuthorTypstTemplate, DERIVED_CONFIG_FILE } from './yaml-io.js';
import {
  runChecks,
  toCheckRun,
  CheckStatus,
  type EngineCheckResult,
  type CheckRun,
  type JournalCheck,
} from './checks.js';
import { materializeDerived, type MystEdge } from './materialize.js';
import type { ComposeInput } from './compose.js';

export interface FsProbes {
  existsProbe(path: string): boolean;
  /** All paths under a dir, recursive + relative (real impl: readdirSync recursive). */
  listTree(dir: string): string[];
}
const realFs: FsProbes = {
  existsProbe: (p) => existsSync(p),
  listTree: (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []),
};

/** Gate routing (id-gate-relocation): `structural` (missing index.md / stray myst.yml) blocks
 *  the build; `identity` (id present/shape/uniqueness), `brand` and `config` do NOT, identity is
 *  enforced at merge via the Journal-checks Check Run, so a fresh/placeholder-id paper still
 *  renders. `config` is instance-config hygiene ([R72] extends-layer overlap): it makes results
 *  non-deterministic rather than impossible, so it gates merge, not the build. */
export type FindingKlass = 'structural' | 'identity' | 'brand' | 'config';

export interface NamedFinding {
  check: string;
  severity: 'error' | 'warn';
  message: string;
  klass: FindingKlass;
}

/* ---- pure Layer-A checks ------------------------------------------------- */

/** index.md + myst.yml at the paper root, and NO stray secondary myst.yml under it (which
 *  would break the n=1 layout: [R50]). Returns only the problems (empty = clean). */
export function checkLayout(
  paperRoot: string,
  probes: FsProbes,
): Array<{ severity: 'error'; message: string }> {
  const out: Array<{ severity: 'error'; message: string }> = [];
  for (const f of ['index.md', 'myst.yml']) {
    if (!probes.existsProbe(join(paperRoot, f))) {
      out.push({ severity: 'error', message: msg.validate.missingFile(f) });
    }
  }
  const stray = probes
    .listTree(paperRoot)
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => {
      if (f === 'myst.yml' || !/(^|\/)myst\.yml$/.test(f)) return false;
      // Ignore infra dirs that tooling drops INTO the paper root; they aren't the author's
      // layout. Critically `.engine/`: the CI composite action checks the engine out there
      // (`path: .engine`), under the paper root, so its own fixture/template myst.yml files
      // would otherwise read as strays. Same for any dotdir (`.git`, `.github`), `_build/`,
      // and a nested `node_modules/`.
      const dirs = f.split('/').slice(0, -1);
      return !dirs.some((d) => d.startsWith('.') || d === '_build' || d === 'node_modules');
    });
  for (const s of stray) {
    out.push({
      severity: 'error',
      message: msg.validate.strayMystYml(s),
    });
  }
  return out;
}

/** Warn on a brand with no resolvable favicon: an unset/broken one fatally 500s the HTML
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
      message: msg.validate.brandNoFavicon,
    };
  }
  if (isBrandAssetUrl(favicon)) return { ok: true };
  const resolved = instanceRoot ? resolveBrandAssetPath(instanceRoot, favicon) : favicon;
  return probes.existsProbe(resolved)
    ? { ok: true }
    : { ok: false, severity: 'warn', message: msg.validate.brandFaviconUnresolved(favicon) };
}

/** Warn on a brand typst watermark (project.options.logo) that is absent, a URL (typst can't
 *  fetch, unlike the HTML favicon), or an unresolvable local file ([R62]/[R68]). */
export function checkBrandWatermark(
  input: { instanceRoot: string | null; logo?: string },
  probes: FsProbes,
): IdCheckResult {
  const { instanceRoot, logo } = input;
  if (!logo) {
    return {
      ok: false,
      severity: 'warn',
      message: msg.validate.brandNoWatermark,
    };
  }
  if (isBrandAssetUrl(logo)) {
    return {
      ok: false,
      severity: 'warn',
      message: msg.validate.brandWatermarkIsUrl(logo),
    };
  }
  const resolved = instanceRoot ? resolveBrandAssetPath(instanceRoot, logo) : logo;
  return probes.existsProbe(resolved)
    ? { ok: true }
    : { ok: false, severity: 'warn', message: msg.validate.brandWatermarkUnresolved(logo) };
}

/**
 * Warn on a `project.thumbnail` that names a file which isn't there.
 *
 * Pinning `thumbnail:` (which `paper-base.yml` does, so the gallery knows where to look) 
 * DISABLES myst's own fallback: `transformThumbnail` only searches the mdast for a first
 * content image when the value is *unset* (`transforms/images.ts:543-556`). So a broken path
 * is worse than no path: `saveImageInStaticFolder` returns null and the paper ships with **no
 * thumbnail at all**, silently, and its gallery card renders blank.
 *
 * A plain existence probe against the paper root is the right test. `thumbnail` is NOT rebased
 * by `resolveProjectConfigPaths` (`config.ts:389-430` rebases `bibliography`, `index` and
 * `plugins` only), and myst resolves it against the SOURCE FILE (`getSourceFolder`,
 * `links.ts:92`) (i.e. `<paperRoot>/index.md`'s folder) not against the extends layer that
 * declared it. No absolutizing, unlike brand assets ([R62]/[R68]) or `exports[].template` ([R74]).
 *
 * Absent → nothing to check: myst's first-image fallback is live again, which is a working
 * thumbnail, not a missing one. A URL passes; myst downloads it for the HTML build ([R80]).
 */
export function checkThumbnail(
  input: { paperRoot: string; thumbnail?: string },
  probes: FsProbes,
): IdCheckResult {
  const { paperRoot, thumbnail } = input;
  if (!thumbnail) return { ok: true };
  if (isBrandAssetUrl(thumbnail)) return { ok: true };
  return probes.existsProbe(join(paperRoot, thumbnail))
    ? { ok: true }
    : {
        ok: false,
        severity: 'warn',
        message: msg.validate.thumbnailUnresolved(thumbnail),
      };
}

/* ---- typst template hygiene ([R76]) -------------------------------------- */

/**
 * Does a template reference FLOAT: i.e. name a moving target whose bytes can change
 * without the reference changing? The [R5] hygiene lint, and the *only* place floating is
 * handled: it is never an error and never a runtime drop.
 *
 * Correcting a conflation worth naming: floating is not the same as REMOTE. A pinned
 * tag/release URL is remote and perfectly reproducible; a branch URL is the problem. And
 * DOI reproducibility does not actually rest on this check at all; the deposit archives
 * the RESOLVED template bytes (zenodo.ts), so a floating source still yields a reproducible
 * PDF. What floating costs you is the *living site* quietly re-rendering differently one
 * day, which is worth a warning and not worth a block (a floating template during template
 * development is entirely legitimate).
 *
 * Conservative by design: warn only on recognizably-floating forms, so a tenant hosting
 * `https://example.org/templates/mine-v1.zip` is not nagged about a pin we cannot see.
 */
export function isFloatingTemplate(value: string): boolean {
  if (isBrandAssetUrl(value)) {
    const [url, ref] = value.split('#');
    if (/\/refs\/heads\//.test(url!)) return true;
    if (/\/archive\/(main|master|HEAD|develop)\.(zip|tar\.gz)$/.test(url!)) return true;
    // A `.git` URL is floating unless it carries a pinned-looking ref (a sha or a version tag).
    if (/\.git$/.test(url!)) return !(ref && /^([0-9a-f]{7,40}|v?\d)/.test(ref));
    return false;
  }
  // A local path is bytes: committed and review-gated, not a moving pointer.
  if (isAbsolute(value) || isInstanceRelativeTemplate(value)) return false;
  // A bare myst template NAME resolves against the live template API: by-name = floating
  // (design §7). Reproducible PDFs still ride the deposit archive.
  return true;
}

/**
 * The typst-template findings, computed from the two layers a paper can see: the AUTHOR's
 * own `exports[].template` and the TENANT's `journal.yml: typst_template`. (The engine's
 * default needs no check: a local checkout is bytes, and its release-zip fallback is
 * pinned to the engine tag by construction.)
 *
 * The override finding is the feature's whole trust surface. compose warns too, but a build
 * log is not review: this is what puts "this paper reskins itself away from the journal" in
 * the Check Run and the sticky PR comment, where an editor decides. Deliberately a WARN:
 * whether to allow it is the tenant's editorial call, not the engine's.
 */
export function checkTemplates(
  input: { instanceRoot: string | null; authorTemplate?: string; tenantTemplate?: string },
  probes: FsProbes,
): NamedFinding[] {
  const { instanceRoot, authorTemplate, tenantTemplate } = input;
  const out: NamedFinding[] = [];
  const warn = (check: string, message: string) =>
    out.push({ check, severity: 'warn', message, klass: 'config' });

  if (authorTemplate && tenantTemplate) {
    warn(
      'template-override',
      msg.validate.templateOverride(authorTemplate, tenantTemplate),
    );
  }

  for (const [layer, value] of [
    ['author', authorTemplate],
    ['journal', tenantTemplate],
  ] as const) {
    if (!value || !isFloatingTemplate(value)) continue;
    warn(
      'template-floating',
      msg.validate.templateFloating(layer, value),
    );
  }

  // The path-vs-name ambiguity, made loud. Only `./`/`../` means "a path in my
  // instance-config", so a bare `templates/typst` goes to myst as a NAME and 404s against
  // the template API. That is invisible until the build fails weirdly, UNLESS a directory of
  // that name is sitting right there, which is exactly when the tenant meant a path.
  if (tenantTemplate && instanceRoot && !isBrandAssetUrl(tenantTemplate)) {
    const bare = !isAbsolute(tenantTemplate) && !isInstanceRelativeTemplate(tenantTemplate);
    if (bare && probes.existsProbe(join(instanceRoot, tenantTemplate))) {
      warn(
        'template-name-ambiguous',
        msg.validate.templateNameAmbiguous(tenantTemplate),
      );
    }
  }

  return out;
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
 *  repo (owner/repo). Without a repo we can't identify self, uniqueness then flags the paper's
 *  own entry as a clash, which the caller avoids by passing the repo (env or git origin). */
function findSelf(registry: Registry | null, repo: string | null): { slug: string } | undefined {
  if (!registry || !repo) return undefined;
  const e = registry.find((x) => x.location.repo === repo);
  return e ? { slug: e.slug } : undefined;
}

/* ---- extends-layer disjointness ([R72]) ---------------------------------- */

/**
 * Keys declared by ONE extends layer, as comparable coordinates.
 *
 * Granularity matters and differs per field: `site.options` / `project.options` merge
 * **field-wise** base-wins (`fillPageFrontmatter.js:22-25`, [R68]), so two layers may safely
 * own different keys inside them: compare at the LEAF (`site.options.logo`). Everything else
 * merges at the top-level key (and `exports` merges whole-entry by id, [R52]/[R53]), so compare
 * at the immediate key (`project.venue`). Comparing `site.options` as a unit would falsely flag
 * paper-base's `hide_toc` against brand's `logo`.
 */
export function declaredKeys(config: unknown): string[] {
  const out: string[] = [];
  const root = (config ?? {}) as Record<string, unknown>;
  for (const ns of ['project', 'site'] as const) {
    const section = root[ns] as Record<string, unknown> | undefined;
    if (!section || typeof section !== 'object') continue;
    for (const [key, value] of Object.entries(section)) {
      if (key === 'options' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const leaf of Object.keys(value as Record<string, unknown>)) {
          out.push(`${ns}.options.${leaf}`);
        }
      } else {
        out.push(`${ns}.${key}`);
      }
    }
  }
  return out;
}

/**
 * The extends layers must own DISJOINT keys ([R72]). myst folds `extends` entries under
 * `Promise.all` with a shared accumulator, so precedence follows *load-completion* order, not
 * declaration order: two layers declaring the same key is a race whose winner can change
 * between runs, not an override. Only the paper's own config (the derived base slot) wins
 * deterministically.
 *
 * Pure: takes already-parsed layer configs so it stays testable without fs.
 */
export function checkLayerDisjointness(
  layers: Array<{ name: string; config: unknown }>,
): Array<{ severity: 'error'; message: string }> {
  const seen = new Map<string, string>(); // key → first layer that declared it
  const clashes: string[] = [];
  for (const { name, config } of layers) {
    for (const key of declaredKeys(config)) {
      const prior = seen.get(key);
      if (prior && prior !== name) clashes.push(`${key} (${prior} vs ${name})`);
      else seen.set(key, name);
    }
  }
  if (!clashes.length) return [];
  return [
    {
      severity: 'error',
      message: msg.validate.layersOverlap(clashes.join(', ')),
    },
  ];
}

function readLayer(path: string, probes: FsProbes): unknown | null {
  if (!probes.existsProbe(path)) return null;
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // a malformed layer is another check's problem, not this one's
  }
}

/* ---- Layer A aggregate --------------------------------------------------- */

export function runLayerA(
  input: {
    paperRoot: string;
    instanceRoot: string | null;
    /** The COMPOSED project ([R82]): author config + extends chain, i.e. what ships. Only
     *  fields no engine layer stamps are read here; the author's typst `template:` is
     *  raw-lifted separately (see below), because for that one value the PROVENANCE is the
     *  point and the composed view has lost it.
     *
     *  Specifically PASS 1, and deliberately so: it carries every layer-declared field but
     *  none of compose's pass-2 stamps. `oak build` cannot hand over anything else: its
     *  [R21] pre-flight runs BETWEEN the passes, so a structurally broken paper never
     *  reaches compose. Pass 1 is therefore the one view both callers can share, at the cost
     *  of Layer B reading pass 2 (it takes the derived FILE) while Layer A reads pass 1.
     *  Today nothing overlaps: the stamps are `output`, `template`, `site.template` and the
     *  absolutized brand assets, and Layer A reads the brand raw from `brand.yml`. A future
     *  Layer-A check that wants a STAMPED field is the signal to revisit this, not to reach
     *  for the derived file here. */
    project: { id?: string; thumbnail?: string };
    repo: string | null;
    /** Engine checkout, for the [R72] extends-layer disjointness check. Omitted → skipped. */
    engineRoot?: string | null;
    /** Edition id, to locate the right `editions/<edition>.yml` layer. Omitted → skipped. */
    edition?: string | null;
  },
  probes: FsProbes = realFs,
): NamedFinding[] {
  const { paperRoot, instanceRoot, project, repo, engineRoot, edition } = input;
  const findings: NamedFinding[] = [];
  const add = (check: string, klass: FindingKlass, r: IdCheckResult) => {
    if (!r.ok) findings.push({ check, severity: r.severity, message: r.message, klass });
  };

  const journal = loadJournal(instanceRoot, probes);
  const registry = loadRegistry(instanceRoot, probes);

  if (!project.id) {
    findings.push({ check: 'id-present', severity: 'error', message: msg.validate.idMissing, klass: 'identity' });
  } else {
    add('id-shape', 'identity', checkIdShape(project.id, { id_sentinel: journal.id_sentinel, id_pattern: journal.id_pattern }));
    add(
      'id-uniqueness',
      'identity',
      checkIdUniqueness(project.id, registry, findSelf(registry, repo), { selfIdentifiable: repo != null }),
    );
  }

  for (const r of checkLayout(paperRoot, probes)) {
    findings.push({ check: 'layout', severity: r.severity, message: r.message, klass: 'structural' });
  }

  // A missing thumbnail is `structural` (it is the paper's own layout, not brand or identity)
  // but only a WARN, so it never blocks the build, only `error` + `structural` does. A
  // mid-draft paper that hasn't made one yet should still render; the thumbnail becomes
  // mandatory at REGISTRATION, where a *registered* paper without one hard-fails the journal
  // site build under `--strict` ([R80]) with an editor in the loop.
  add('thumbnail', 'structural', checkThumbnail({ paperRoot, thumbnail: project.thumbnail }, probes));

  // [R72]: the three extends layers must own disjoint keys, or precedence is a race.
  if (engineRoot && instanceRoot && edition) {
    const layers = [
      { name: 'paper-base.yml', path: join(engineRoot, 'paper-base.yml') },
      { name: `editions/${edition}.yml`, path: join(instanceRoot, 'editions', `${edition}.yml`) },
      { name: 'brand/brand.yml', path: join(instanceRoot, 'brand', 'brand.yml') },
    ]
      .map((l) => ({ name: l.name, config: readLayer(l.path, probes) }))
      .filter((l) => l.config != null);
    for (const r of checkLayerDisjointness(layers)) {
      findings.push({ check: 'extends-disjoint', severity: r.severity, message: r.message, klass: 'config' });
    }
  }

  const brand = instanceRoot ? readBrandAssetOptions(instanceRoot) : { site: {}, project: {} };
  add('brand-favicon', 'brand', checkBrandFavicon({ instanceRoot, favicon: brand.site.favicon }, probes));
  add('brand-watermark', 'brand', checkBrandWatermark({ instanceRoot, logo: brand.project.logo }, probes));

  // The author's template comes from a RAW LIFT of their own myst.yml, never from `project`
  // ([R82]). Digging it out of the composed `exports` would find compose's pass-2 stamp
  // (`flag ?? author ?? tenant ?? engine`), so `template-override` would fire on every paper
  // and `template-floating` would misattribute the layer. Same discipline as the brand assets
  // ([R68]) and the tenant's own template ([R79]): a value whose provenance is the point is
  // read outside the merge.
  findings.push(
    ...checkTemplates(
      {
        instanceRoot,
        authorTemplate: readAuthorTypstTemplate(paperRoot),
        tenantTemplate: journal.typst_template,
      },
      probes,
    ),
  );

  return findings;
}

/* ---- Layer-B preconditions ----------------------------------------------- */

/** The one catalog check that needs BUILD ARTIFACTS, not just a loaded project. */
const EXPORTS_EXIST = 'exports-exist';

/**
 * Split off the selected checks whose precondition is unmet, reporting them instead of
 * running them ([R82] §5).
 *
 * `exports-exist` compares each collected export's `output` against the filesystem, and
 * `oak validate` does not build. Under the composed view it now collects the REAL typst
 * export ([R53]), so left to run it would report a hard "Missing export" on every unbuilt
 * paper: a true statement about a file validate never promised to produce.
 * `CheckStatus` has no `skip`; `error` is documented as *"the check could not be run"*,
 * which is exactly the situation and already how we report an unloadable project.
 *
 * Not solved by building first: `check.yml` is deliberately a separate, secretless Stage-1
 * workflow from `ci.yml`, and building there would either couple the merge gate to build
 * success or build every PR twice.
 *
 * ALWAYS `optional`, whatever the journal said. `optional` is what keeps a result out of
 * `blockingCheckFail`, and an unmet precondition must not gate: in CI `_build/exports` is
 * NEVER present (gitignored, fresh checkout, no build step), so a plain selection of this id
 * would fail the Check Run on every PR of every paper, with nothing any AUTHOR could do
 * about it, since only the tenant can edit `journal.yml`. It would also pass locally, where
 * a previous `oak build` left the directory behind. The tenant still sees the result and its
 * cause in the summary table; it just cannot brick the merge gate.
 */
export function splitUnrunnableChecks(
  journalChecks: JournalCheck[],
  paperRoot: string,
  probes: FsProbes,
): { runnable: JournalCheck[]; unrunnable: EngineCheckResult[] } {
  if (probes.existsProbe(join(paperRoot, '_build', 'exports'))) {
    return { runnable: journalChecks, unrunnable: [] };
  }
  return {
    runnable: journalChecks.filter((c) => c.id !== EXPORTS_EXIST),
    unrunnable: journalChecks
      .filter((c) => c.id === EXPORTS_EXIST)
      .map(() => ({
        id: EXPORTS_EXIST,
        status: CheckStatus.error,
        message: msg.validate.needsBuildArtifacts,
        cause: 'missing-build-artifacts',
        optional: true,
      })),
  };
}

/* ---- the verb ------------------------------------------------------------ */

export interface ValidateResult {
  status: 'ok' | 'error';
  errors: NamedFinding[];
  warnings: NamedFinding[];
  checks: EngineCheckResult[];
  checkRun: CheckRun;
  /** Info-level notes about HOW the run happened, today, that it ran uncomposed ([R82]).
   *  Never gates: when composing was possible and FAILED, the `compose` finding above is what
   *  gates; a note only ever explains. They ride into `checkRun.summary`, so the Check Run and
   *  the sticky comment both show them; a difference visible only in stdout is still the
   *  [R71] mistake, since the PR UI is where anyone actually reads a verdict. */
  notes: string[];
  exitCode: number;
}

export async function runValidate(
  input: {
    paperRoot: string;
    instanceRoot: string | null;
    edge: MystEdge;
    /** Engine checkout + edition, for the [R72] disjointness check AND the composed view. */
    engineRoot?: string | null;
    edition?: string | null;
    /** `engine_repo` pin, only so compose can build its fallback asset URLs. Never read by a
     *  check here (the author's template is raw-lifted ([R82])) so a default is harmless. */
    engineRepo?: string;
    /** The dev/CI-from-checkout asset overrides `oak build` passes. Must be the SAME ones:
     *  both verbs materialize one `myst.oak.yml`, and compose resolves the engine template
     *  from these, so differing inputs make the shared function emit differing files. */
    assetOverrides?: ComposeInput['assetOverrides'];
  },
  opts: { strict?: boolean; repo?: string | null; pathBase?: string } = {},
  probes: FsProbes = realFs,
): Promise<ValidateResult> {
  const repo = opts.repo ?? null;
  const notes: string[] = [];

  // --- The view: COMPOSED when there is something to compose ([R82]) ----------------
  // Validate must read the config that SHIPS, not the author's own file: `paper-base.yml`'s
  // pinned `thumbnail` and its complete typst export exist only post-`extends`, so on the
  // author's view those checks silently pass ([R81]). Materialization is SHARED with `oak
  // build` so the two cannot drift: that drift is exactly what [R71] was about.
  //
  // Degrading is deliberate, not a fallback of last resort: a bare local `oak validate` or
  // `--no-instance` has nothing to compose (dec. 20 soft-warn precedent). And we GUARD the
  // materialization for the same reason the Layer-B call is guarded, validate is a REPORTER,
  // and a gate that crashes tells the author less than a gate that says what it could not do.
  let project: { id?: string; exports?: Array<Record<string, unknown>>; thumbnail?: string };
  let configFile: string | undefined;
  let composeFailure: string | undefined;
  const composable = !!input.engineRoot && !!input.instanceRoot;
  if (composable) {
    try {
      const materialized = await materializeDerived({
        paperRoot: input.paperRoot,
        engineRoot: input.engineRoot!,
        instanceRoot: input.instanceRoot,
        engineRepo: input.engineRepo ?? 'unknown/engine',
        baseUrl: '', // no site is built here; compose only needs it for the build env
        assetOverrides: input.assetOverrides,
        edge: input.edge,
      });
      project = materialized.resolvedProject;
      configFile = DERIVED_CONFIG_FILE;
    } catch (e) {
      // A throw HERE is a finding, not just a note. We had an engine checkout AND an
      // instance-config (everything compose needs) so the failure is a defect in the
      // paper's own config (a typo'd `edition:`, a missing/mismatched engine coordinate,
      // the [R36] cross-check), and `oak build` will hit the identical throw on `main`.
      // Reporting it as a note alone let a paper whose build provably crashes come back
      // `status: ok`, exit 0, Check Run success: the merge gate green on a broken paper.
      // Still guarded rather than rethrown: the rest of the report is worth more than a
      // stack trace, and this way the author gets the whole fix-list at once.
      composeFailure = (e as Error).message;
      notes.push(msg.validate.noteComposeFailed(composeFailure));
    }
  } else {
    notes.push(msg.validate.noteUncomposed);
  }
  project ??= (await input.edge.loadProject(input.paperRoot)) as typeof project;

  // Layer A: engine invariants
  const layerA = runLayerA(
    {
      paperRoot: input.paperRoot,
      instanceRoot: input.instanceRoot,
      project,
      repo,
      engineRoot: input.engineRoot ?? null,
      edition: input.edition ?? null,
    },
    probes,
  );
  // `config`, not `structural`: structural errors short-circuit Layer B, and the author is
  // better served seeing the editorial fix-list in the same run (id-gate-relocation). Those
  // Layer-B results are read off the author's config, so some may be vacuous, which is what
  // the note says, and why this finding is the one that gates.
  if (composeFailure) {
    layerA.push({
      check: 'compose',
      severity: 'error',
      message: msg.validate.composeFailed(composeFailure),
      klass: 'config',
    });
  }
  const errors = layerA.filter((f) => f.severity === 'error');
  const warnings = layerA.filter((f) => f.severity === 'warn');

  // Layer B: journal-configured editorial checks, provided by @curvenote/check-implementations.
  // They read the myst store, so we run them inside a loaded+processed project session (the edge
  // keeps myst-cli confined to myst.ts), pointed at the DERIVED config when we have one, i.e.
  // the post-pass-2 file, stamps and all ([R82]), unlike Layer A above which reads pass 1.
  //
  // A blocking Layer-A finding (missing index.md, a stray secondary myst.yml, a bad id) means the
  // project can't be processed: `withProjectSession` would THROW and take the whole report down,
  // hiding the very Layer-A finding that explains the failure. So we short-circuit: skip Layer B
  // when Layer A already blocks. And even when Layer A is clean we GUARD the Layer-B call, so an
  // unexpected myst/curvenote throw degrades to a reported check error, never a crashed gate.
  const journal = loadJournal(input.instanceRoot, probes);
  let checks: EngineCheckResult[] = [];
  // Only STRUCTURAL Layer-A errors (missing index.md / stray myst.yml) stop myst from
  // processing → skip Layer B. A bad id (identity) does NOT stop processing, so editorial
  // checks still run and the author sees the full fix-list at once (id-gate-relocation).
  const structuralErrors = errors.filter((f) => f.klass === 'structural');
  // A selected check whose precondition is unmet is REPORTED, not run ([R82] §5), today only
  // `exports-exist`, which under the composed view collects the real typst export and would
  // hard-fail on a paper validate never promised to build.
  const { runnable, unrunnable } = splitUnrunnableChecks(
    (journal.checks ?? []) as JournalCheck[],
    input.paperRoot,
    probes,
  );
  checks = unrunnable;
  if (structuralErrors.length === 0) {
    try {
      checks = [
        ...unrunnable,
        ...(await input.edge.withProjectSession(
          input.paperRoot,
          (session) => runChecks(session, runnable),
          configFile, // the COMPOSED config when we have one ([R82])
        )),
      ];
    } catch (e) {
      checks = [
        ...unrunnable,
        {
          id: 'editorial-checks',
          status: CheckStatus.error,
          message: msg.validate.editorialLoadFailed((e as Error).message),
        },
      ];
    }
  }

  // Combined results for the Check Run: Layer-A findings as synthetic results (errors gate,
  // warns are optional) + the Layer-B editorial results.
  const layerAResults: EngineCheckResult[] = layerA.map((f) => ({
    id: f.check,
    status: CheckStatus.fail,
    message: f.message,
    optional: f.severity === 'warn',
  }));
  // Relativize curvenote's (sometimes absolute) annotation paths against the repo checkout root
  // so GitHub can resolve them; default to the paper root (== repo root in the n=1 model).
  const checkRun = toCheckRun([...layerAResults, ...checks], opts.pathBase ?? input.paperRoot, notes);

  const blockingCheckFail = checks.some((c) => (c.status === CheckStatus.fail || c.status === CheckStatus.error) && !c.optional);
  const hasError = errors.length > 0 || blockingCheckFail;
  const exitCode = hasError ? 1 : opts.strict && warnings.length ? 1 : 0;

  return { status: hasError ? 'error' : 'ok', errors, warnings, checks, checkRun, notes, exitCode };
}
