/**
 * build.ts — `oak build`, the two-pass orchestrator ([R52], design §12a).
 *
 * The author's `myst.yml` is READ-ONLY ([R71]); both passes write the DERIVED config
 * (`myst.oak.yml`) beside it, and myst is pointed there via `Session({ configFiles })`.
 *
 * Pass 1: author config + `extends:` chain → derived → loadConfig → resolved project
 *         (its typst export now carries the edition's `articles`).
 * Pass 2: compose(resolved) → ownOverride → write the complete engine typst entry +
 *         theme `site.template` into the derived config → build.
 *
 * Both passes live in `materializeDerived`, which `oak validate` calls too ([R82]) — one
 * materialization, so what validate checks cannot drift from what the build renders.
 *
 * The myst edge (loadConfig + build) is injected as `MystEdge` so this orchestration is
 * unit-testable with a fake — the real edge (myst.ts) pulls in the bundled myst-cli.
 */
import { join } from 'node:path';
import type { ISession } from 'myst-cli';
import { compose, extendsChainFor, type ResolvedProject, type ComposeInput } from './compose.js';
import { runLayerA } from './validate.js';
import { originRepo } from './gh.js';
import {
  readDoc,
  writeDerivedDoc,
  setExtends,
  applyOwnOverride,
  readEngineCoordinateRaw,
  readBrandAssetOptions,
  readTenantTypstTemplate,
  DERIVED_CONFIG_FILE,
} from './yaml-io.js';

export interface BuildOpts {
  all?: boolean;
  html?: boolean;
  /** Build only the typst export, no HTML site — the offline canary path (site HTML
   *  needs a network theme zip; validated live in CI instead). */
  exportsOnly?: boolean;
}

/** The `myst start` options `oak start` passes through (myst's own names, `cli/start.js`). */
export interface StartOpts {
  port?: number;
  serverPort?: number;
  headless?: boolean;
  keepHost?: boolean;
  template?: string;
  baseurl?: string;
}

/**
 * The seam to mystmd (myst.ts implements it with the bundled myst-cli).
 *
 * `configFile` selects WHICH config in `dir` myst reads, via `new Session({ configFiles })`
 * ([R71]). Omitted → myst's default (`myst.yml`/`myst.yaml`), i.e. the author's own config —
 * which is only what a DEGRADED `oak validate` reads (nothing to compose, [R82]). `build` and a
 * composed `validate` both pass the derived config. Sessions are cached per config name in the
 * real edge.
 */
export interface MystEdge {
  /** loadConfig(session, dir).project — the resolved project frontmatter. */
  loadProject(dir: string, configFile?: string): Promise<ResolvedProject>;
  /** build(session, [], opts) from within `dir`. */
  build(dir: string, opts: BuildOpts, configFile?: string): Promise<void>;
  /**
   * startServer(session, opts) from within `dir` — the dev server behind `oak start`.
   * Resolves once the server is UP (myst's own contract) and leaves it running, so the
   * caller must not let the process exit afterwards.
   */
  start(dir: string, opts: StartOpts, configFile?: string): Promise<void>;
  /**
   * Load AND process the project at `dir` (config + current-project pointer + mdast), then run
   * `fn` against the myst Session with the current project set — so the curvenote Layer-B checks
   * can read the store (`selectCurrentProjectConfig` needs the pointer, [R59]; `abstract-exists`
   * reads processed mdast). Frontmatter/abstract checks need this, NOT a full build/export.
   */
  withProjectSession<T>(
    dir: string,
    fn: (session: ISession) => Promise<T>,
    configFile?: string,
  ): Promise<T>;
}

export interface MaterializeInput {
  paperRoot: string;
  engineRoot: string;
  instanceRoot: string | null;
  engineRepo: string;
  baseUrl: string;
  assetOverrides?: ComposeInput['assetOverrides'];
  edge: MystEdge;
}

export interface MaterializeResult {
  /** The pass-1 resolved project — the author's config with the `extends:` chain merged in.
   *  It carries every layer-declared field (`thumbnail`, venue, license…) but NOT compose's
   *  pass-2 stamps; those live in the derived FILE, which is what a myst session reads. */
  resolvedProject: ResolvedProject;
  /** The derived config on disk (`<paperRoot>/myst.oak.yml`) — point myst at it. */
  derivedPath: string;
  extendsChain: string[];
  /** The edition read RAW from the author's config (pre-extends, the shim's `yq` read). */
  edition: string;
  /** compose's warnings (which include `extendsChainFor`'s --no-instance warning). */
  warnings: string[];
}

/**
 * The two-pass derived-config materialization ([R71]) — shared by `oak build` and
 * `oak validate` ([R82]) so neither can drift from what actually ships. Writes
 * `<paperRoot>/myst.oak.yml` and leaves it there (myst's `process.exit(0)` defeats cleanup;
 * the frozen paper template gitignores it).
 *
 * `preflight` runs BETWEEN the passes, on the pass-1 resolved project, and may throw:
 * `oak build` gates itself there ([R21]) so a structurally broken paper never reaches compose
 * or pass 2. Keeping the hook inside rather than after preserves exactly which error a
 * doubly-broken paper reports — compose throws too (the R36 coordinate cross-check).
 */
export async function materializeDerived(
  input: MaterializeInput,
  preflight?: (project: ResolvedProject, ctx: { edition: string }) => void,
): Promise<MaterializeResult> {
  const { paperRoot, engineRoot, instanceRoot, engineRepo, baseUrl, assetOverrides, edge } = input;

  // The author's config is an INPUT — read, never written ([R71]). Everything the engine
  // injects goes to the DERIVED config beside it, which is what myst is pointed at.
  const authorPath = join(paperRoot, 'myst.yml');
  const derivedPath = join(paperRoot, DERIVED_CONFIG_FILE);
  const doc = readDoc(authorPath);

  // Raw, pre-extends read of the engine coordinate (the local `yq` equivalent, §6a). The path
  // goes in so a missing coordinate names the file the author has to edit.
  const { version: engineVersion, edition } = readEngineCoordinateRaw(doc, authorPath);

  // --- Pass 1: materialize author config + extends chain into the derived config -----
  // The author's frontmatter lands in the derived file's BASE slot, where myst's base-wins is
  // deterministic; the engine layers stay `extends:`. Deriving by `extends:`-ing the author's
  // myst.yml instead would demote it to a racing sibling ([R72]) and make author-overrides-venue
  // precedence non-deterministic.
  const { extendsChain } = extendsChainFor({ engineRoot, instanceRoot, edition });
  setExtends(doc, extendsChain);
  writeDerivedDoc(derivedPath, doc);

  const resolvedProject = await edge.loadProject(paperRoot, DERIVED_CONFIG_FILE);

  preflight?.(resolvedProject, { edition });

  // Raw brand asset fields ([R62]) — read from brand.yml directly (not the merged config)
  // so compose absolutizes only brand-declared assets against `<instanceRoot>/brand`.
  const brandAssets = instanceRoot ? readBrandAssetOptions(instanceRoot) : undefined;

  // The tenant's own typst template ([R76]) — same raw-lift discipline, from journal.yml.
  const tenantTypstTemplate = instanceRoot ? readTenantTypstTemplate(instanceRoot) : undefined;

  // --- compose over the resolved config (runs the R36 cross-check) -------------------
  const result = compose({
    paperRoot,
    engineRoot,
    instanceRoot,
    resolvedProject,
    engineRepo,
    engineVersion,
    edition,
    baseUrl,
    assetOverrides,
    brandAssets,
    tenantTypstTemplate,
  });

  // --- Pass 2: apply the engine override to the derived config ----------------------
  // This is the pass that stamps `template` AND `output` ([R71-out]) — without it a myst
  // session reading the derived config would resolve the export to myst's default path,
  // derived from the DECLARING file, which the build never writes.
  applyOwnOverride(doc, result.ownOverride);
  writeDerivedDoc(derivedPath, doc);

  return { resolvedProject, derivedPath, extendsChain, edition, warnings: result.warnings };
}

export interface RunBuildInput extends MaterializeInput {
  /** Defaults to a full build (HTML + exports). HTML-only is useful until the pinned
   *  typst-template release zip exists (exports would 404 fetching it). */
  buildOpts?: BuildOpts;
}

export interface RunBuildResult {
  resolvedProject: ResolvedProject;
  extendsChain: string[];
  warnings: string[];
}

export async function runBuild(input: RunBuildInput): Promise<RunBuildResult> {
  const { paperRoot, instanceRoot, engineRoot, baseUrl, buildOpts = { all: true, html: true }, edge } =
    input;

  const layerAWarnings: string[] = [];
  const { resolvedProject, extendsChain, warnings } = await materializeDerived(
    input,
    (project, { edition }) => {
      // --- Pre-flight validate (Layer A): the engine's own invariants gate the build ([R21]).
      // A sentinel/malformed id, broken layout, or (soft) brand issue is caught before the
      // expensive myst build. Editorial (Layer B) checks are the PR check job's concern.
      const layerA = runLayerA({
        paperRoot,
        instanceRoot,
        project,
        repo: process.env.GITHUB_REPOSITORY ?? originRepo(paperRoot),
        engineRoot,
        edition,
      });
      // Only STRUCTURAL invariants (missing index.md / stray myst.yml) gate the build. Identity
      // errors (a placeholder/invalid/duplicate id) do NOT stop the build — the id is enforced at
      // merge via the Journal-checks Check Run, so a fresh repo still renders a preview to look at
      // (id-gate-relocation). They surface as warnings alongside the brand warns.
      const blocking = layerA.filter((f) => f.severity === 'error' && f.klass === 'structural');
      if (blocking.length) {
        throw new Error(
          'oak build: pre-flight validation failed:\n' +
            blocking.map((f) => `  - [${f.check}] ${f.message}`).join('\n'),
        );
      }
      layerAWarnings.push(
        ...layerA
          .filter((f) => f.severity === 'warn' || (f.severity === 'error' && f.klass !== 'structural'))
          .map((f) => `[${f.check}] ${f.message}`),
      );
    },
  );

  if (baseUrl) process.env.BASE_URL = baseUrl;
  await edge.build(paperRoot, buildOpts, DERIVED_CONFIG_FILE);

  return { resolvedProject, extendsChain, warnings: [...warnings, ...layerAWarnings] };
}

export interface RunStartInput extends MaterializeInput {
  startOpts?: StartOpts;
}

/**
 * `oak start` — compose exactly as `oak build` does, then hand the DERIVED config to myst's
 * dev server. The point is that a local preview and the CI build read the same file: an author
 * previewing with a bare `myst start` sees their own myst.yml, without the journal's branding,
 * edition or export settings, and only finds out at PR time.
 *
 * No Layer-A pre-flight here, unlike `runBuild`: a preview is for looking at work in progress,
 * and a placeholder id or a missing thumbnail must not stand between an author and their draft.
 * `oak validate` is the verb that judges; the PR check is the gate.
 */
export async function runStart(input: RunStartInput): Promise<MaterializeResult> {
  const { paperRoot, startOpts = {}, edge } = input;
  const materialized = await materializeDerived(input);
  await edge.start(paperRoot, startOpts, DERIVED_CONFIG_FILE);
  return materialized;
}
