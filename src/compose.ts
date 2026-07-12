/**
 * compose.ts — the pure heart of the engine (design §3, §12).
 *
 * Wires the engine/edition/brand `extends:` chain (all LOCAL paths — no network at
 * build) and computes the version-matched asset overrides the committed files never
 * carry. myst resolves the rest. This function is PURE: (paper, engine, instance, env,
 * resolved-project) → a plan. All IO (loadConfig, the two working-tree YAML round-trips,
 * running the build) lives at the CLI edge, so this stays unit-testable against the
 * fixtures with no toolchain.
 *
 * MECHANISM (corrected against the mystmd oracle — [R52]). MyST merges `exports` by
 * `id`, whole-entry, with `base` winning and NO field-level merge
 * (myst-frontmatter fillPageFrontmatter.ts:241-250). In `loadConfig` the paper's OWN
 * config is the final `base` (deterministic), but extends-vs-extends precedence runs
 * under `Promise.all` (config.ts:207-231) → non-deterministic. So we do NOT emit a
 * trailing `_composed.yml` extends fragment (design §3 step 4 would race the edition's
 * same-id typst export). Instead compose emits `ownOverride`, merged into the paper's
 * OWN working-tree config — where base-wins is deterministic. Because exports don't
 * field-merge, the engine's typst entry must be COMPLETE: it carries `articles` (read
 * from the resolved edition export) alongside the engine-pinned `template:` (finding 2:
 * the engine owns the template; the migrated edition config drops it).
 *
 * Two-pass at the edge: (1) write `extends:` = extendsChain → loadConfig → resolved
 * exports (now carry the edition's `articles`); (2) compose(resolved) → ownOverride →
 * write into the working-tree own project/site → build. Neither write is committed.
 */
import { readEngineOptions } from './schema.js';
import { typstTemplateUrl, themeZipUrl } from './assets.js';

/** The subset of a myst-resolved `project` (from loadConfig) that compose reads.
 *  We depend only on myst's field NAMES, never a shape we define (design §12). */
export interface ResolvedProject {
  id?: string;
  title?: string;
  options?: Record<string, unknown>;
  exports?: Array<Record<string, unknown>>;
}

export interface ComposeInput {
  /** Absolute/relative path to the paper project root (holds myst.yml). */
  paperRoot: string;
  /** Path to the checked-out engine root (holds paper-base.yml / nexus-base.yml). */
  engineRoot: string;
  /** Path to instance-config (cloned sibling or the repo root); null = --no-instance. */
  instanceRoot: string | null;
  /** The paper's myst-resolved project (loadConfig().project) — read-only. */
  resolvedProject: ResolvedProject;
  /** Engine ref + repo, from the raw shim read of pins.yml + options (used for URLs). */
  engineRepo: string;
  engineVersion: string;
  /** Per-paper edition (raw shim read of options); selects editions/<edition>.yml. */
  edition: string;
  /** '/<repo>' in CI (Pages subpath) or '' locally / for previews (design §12a). */
  baseUrl: string;
  /** 'paper' (default) extends paper-base; 'site' extends nexus-base (website, slice 4). */
  buildKind?: 'paper' | 'site';
  /** Override the version-matched asset URLs. Defaults resolve to the engine tag's
   *  release zips (which only exist once a tag is cut); dev/CI-from-checkout and tests
   *  pass local paths, and `siteTemplate: null` omits the override so myst uses its
   *  default book-theme (needed until the fork release exists). */
  assetOverrides?: {
    typstTemplate?: string;
    /** string → use it; null → omit site.template (myst default); undefined → release zip. */
    siteTemplate?: string | null;
  };
}

export interface OwnOverride {
  /** Merged into the working-tree own `project` (deterministic base-wins by id). */
  project?: { exports: Array<Record<string, unknown>> };
  /** Merged into the working-tree own `site`. */
  site?: { template: string };
}

export interface ComposeResult {
  /** Ordered `extends:` entries (local paths) written into the working-tree myst.yml. */
  extendsChain: string[];
  /** Engine overrides merged into the paper's OWN working-tree config ([R52]); wins
   *  deterministically over the extends chain by myst's base-wins-by-id rule. */
  ownOverride: OwnOverride;
  /** Env the build must run with (myst reads BASE_URL from env, not config). */
  env: { BASE_URL: string };
  warnings: string[];
}

/** The extends chain (local paths) — a pure function of the LAYOUT, independent of the
 *  resolved config. The two-pass build (§12a, [R52]) needs the chain BEFORE it can
 *  resolve, so this is split out from compose(). Returns warnings for --no-instance. */
export function extendsChainFor(input: {
  engineRoot: string;
  instanceRoot: string | null;
  edition: string;
  buildKind?: 'paper' | 'site';
}): { extendsChain: string[]; warnings: string[] } {
  const { engineRoot, instanceRoot, edition, buildKind = 'paper' } = input;
  const warnings: string[] = [];
  const base =
    buildKind === 'site' ? `${engineRoot}/nexus-base.yml` : `${engineRoot}/paper-base.yml`;
  const extendsChain: string[] = [base];
  if (instanceRoot === null) {
    warnings.push(
      '--no-instance: building unbranded (no edition/brand). Not CI-faithful; ' +
        'brand assets (logo, watermark) and edition frontmatter are absent.',
    );
  } else {
    extendsChain.push(`${instanceRoot}/editions/${edition}.yml`);
    extendsChain.push(`${instanceRoot}/brand/brand.yml`);
  }
  return { extendsChain, warnings };
}

export function compose(input: ComposeInput): ComposeResult {
  const {
    engineRoot,
    instanceRoot,
    resolvedProject,
    engineRepo,
    engineVersion,
    edition,
    baseUrl,
    buildKind = 'paper',
    assetOverrides = {},
  } = input;

  // --- R36 cross-check: the shim reads options RAW (pre-extends via yq); the CLI reads
  // them RESOLVED (post-extends via loadConfig). A stray project.options in an extended
  // edition config could make the two disagree — assert they don't. ------------------
  const resolved = readEngineOptions(resolvedProject.options);
  if (resolved.version !== engineVersion || resolved.edition !== edition) {
    throw new Error(
      `options.oaktree-sapling mismatch: shim read {version:${engineVersion}, edition:${edition}} ` +
        `but resolved config has {version:${resolved.version}, edition:${resolved.edition}}. ` +
        `An extended config is likely overriding project.options.`,
    );
  }

  const { extendsChain, warnings } = extendsChainFor({
    engineRoot,
    instanceRoot,
    edition,
    buildKind,
  });

  // --- ownOverride: engine overrides merged into the paper's OWN config ([R52]) -----
  const ownOverride: OwnOverride = {};

  // Typst export — engine owns `template:` authoritatively (finding 2 / [R5]). Because
  // myst merges exports by id WHOLE-ENTRY (no field merge), the winning entry must be
  // complete: spread the resolved export (carries the edition's `articles`) and set the
  // engine-pinned template. Placed in own config so base-wins is deterministic.
  const typst = (resolvedProject.exports ?? []).find(
    (e) => e['format'] === 'typst' || e['id'] === 'typst-pdf',
  );
  if (typst) {
    const template =
      assetOverrides.typstTemplate ?? typstTemplateUrl(engineRepo, engineVersion);
    ownOverride.project = { exports: [{ ...typst, template }] };
  } else {
    warnings.push(
      'no typst export found in the resolved config; PDF export + Zenodo deposit will be skipped',
    );
  }

  // Theme — the pinned book-theme fork zip (design §7), version-matched to the engine.
  // `siteTemplate: null` omits the override so myst falls back to its default theme.
  const siteTemplate =
    assetOverrides.siteTemplate === undefined ? themeZipUrl() : assetOverrides.siteTemplate;
  if (siteTemplate !== null) {
    ownOverride.site = { template: siteTemplate };
  }

  return {
    extendsChain,
    ownOverride,
    env: { BASE_URL: baseUrl },
    warnings,
  };
}
