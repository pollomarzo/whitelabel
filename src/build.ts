/**
 * build.ts — `oak build`, the two-pass orchestrator ([R52], design §12a).
 *
 * Pass 1: write the `extends:` chain into the working-tree myst.yml → loadConfig →
 *         resolved project (its typst export now carries the edition's `articles`).
 * Pass 2: compose(resolved) → ownOverride → write the complete engine typst entry +
 *         theme `site.template` into the working-tree own config → build.
 *
 * The myst edge (loadConfig + build) is injected as `MystEdge` so this orchestration is
 * unit-testable with a fake — the real edge (myst.ts) pulls in the bundled myst-cli.
 */
import { join } from 'node:path';
import { compose, extendsChainFor, type ResolvedProject, type ComposeInput } from './compose.js';
import { readDoc, writeDoc, setExtends, applyOwnOverride, readEngineCoordinateRaw } from './yaml-io.js';

export interface BuildOpts {
  all?: boolean;
  html?: boolean;
  /** Build only the typst export, no HTML site — the offline canary path (site HTML
   *  needs a network theme zip; validated live in CI instead). */
  exportsOnly?: boolean;
}

/** The seam to mystmd (myst.ts implements it with the bundled myst-cli). */
export interface MystEdge {
  /** loadConfig(session, dir).project — the resolved project frontmatter. */
  loadProject(dir: string): Promise<ResolvedProject>;
  /** build(session, [], opts) from within `dir`. */
  build(dir: string, opts: BuildOpts): Promise<void>;
}

export interface RunBuildInput {
  paperRoot: string;
  engineRoot: string;
  instanceRoot: string | null;
  engineRepo: string;
  baseUrl: string;
  buildKind?: 'paper' | 'site';
  assetOverrides?: ComposeInput['assetOverrides'];
  /** Defaults to a full build (HTML + exports). HTML-only is useful until the pinned
   *  typst-template release zip exists (exports would 404 fetching it). */
  buildOpts?: BuildOpts;
  edge: MystEdge;
}

export interface RunBuildResult {
  resolvedProject: ResolvedProject;
  extendsChain: string[];
  warnings: string[];
}

export async function runBuild(input: RunBuildInput): Promise<RunBuildResult> {
  const {
    paperRoot,
    engineRoot,
    instanceRoot,
    engineRepo,
    baseUrl,
    buildKind = 'paper',
    assetOverrides,
    buildOpts = { all: true, html: true },
    edge,
  } = input;

  const mystPath = join(paperRoot, 'myst.yml');
  const doc = readDoc(mystPath);

  // Raw, pre-extends read of the engine coordinate (the local `yq` equivalent, §6a).
  const { version: engineVersion, edition } = readEngineCoordinateRaw(doc);

  // --- Pass 1: inject the extends chain, then resolve --------------------------------
  const { extendsChain } = extendsChainFor({ engineRoot, instanceRoot, edition, buildKind });
  setExtends(doc, extendsChain);
  writeDoc(mystPath, doc);

  const resolvedProject = await edge.loadProject(paperRoot);

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
    buildKind,
    assetOverrides,
  });

  // --- Pass 2: apply the engine override to the OWN config, then build --------------
  applyOwnOverride(doc, result.ownOverride);
  writeDoc(mystPath, doc);

  if (baseUrl) process.env.BASE_URL = baseUrl;
  await edge.build(paperRoot, buildOpts);

  return { resolvedProject, extendsChain, warnings: result.warnings };
}
