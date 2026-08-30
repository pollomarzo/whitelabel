/**
 * build.ts: `oak build`, the two-pass orchestrator ([R52], design §12a).
 *
 * The author's `myst.yml` is READ-ONLY ([R71]); both passes write the DERIVED config
 * (`myst.oak.yml`) beside it, and myst is pointed there via `Session({ configFiles })`.
 *
 * Pass 1: author config + `extends:` chain → derived → loadConfig → resolved project
 *         (its typst export now carries the edition's `articles`).
 * Pass 2: compose(resolved) → ownOverride → write the complete engine typst entry +
 *         theme `site.template` into the derived config → build.
 *
 * Both passes live in `materializeDerived` (`materialize.ts`), which `oak validate` calls too
 * ([R82]), one
 * materialization, so what validate checks cannot drift from what the build renders.
 *
 * The myst edge (loadConfig + build) is injected as `MystEdge` so this orchestration is
 * unit-testable with a fake: the real edge (myst.ts) pulls in the bundled myst-cli.
 */
import { join } from 'node:path';
import type { ISession } from 'myst-cli';
import { compose, extendsChainFor, type ResolvedProject, type ComposeInput } from './compose.js';
import { runLayerA } from './validate.js';
import {
  materializeDerived,
  type MaterializeInput,
  type MaterializeResult,
  type BuildOpts,
  type StartOpts,
} from './materialize.js';
import * as msg from './messages.js';
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
      // errors (a placeholder/invalid/duplicate id) do NOT stop the build; the id is enforced at
      // merge via the Journal-checks Check Run, so a fresh repo still renders a preview to look at
      // (id-gate-relocation). They surface as warnings alongside the brand warns.
      const blocking = layerA.filter((f) => f.severity === 'error' && f.klass === 'structural');
      if (blocking.length) {
        throw new Error(
          msg.build.preflightFailed(blocking.map((f) => `  - [${f.check}] ${f.message}`).join('\n')),
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
 * `oak start`: compose exactly as `oak build` does, then hand the DERIVED config to myst's
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
