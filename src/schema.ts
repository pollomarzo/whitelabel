/**
 * schema.ts: the engine's data contracts (zod).
 *
 * Scope discipline (design §12, decisions 12/24):
 *  - We validate ONLY the engine-owned coordinates: the `oaktree-sapling` key inside
 *    myst's `project.options` passthrough, plus the two engine-owned instance files
 *    (`journal.yml`, `registry/papers.yml`) and the CI/local pins (`pins.yml`).
 *  - We NEVER model the myst config shape. myst is the config oracle (loadConfig).
 *  - Engine-owned instance files are parsed ADDITIVE-ONLY (unknown keys ignored, never
 *    rejected) so a newer instance-config field can't break a paper pinned to an older
 *    engine ([R42], dec. 24). `.loose()` (zod v4) = passthrough of unknown keys.
 *
 * These schemas are the single source of truth reused by `oak validate`, by compose,
 * and exported to JSON Schema for author-editor autocomplete (see `toJsonSchemas`).
 */
import * as msg from './messages.js';
import { z } from 'zod';

/* --------------------------------------------------------------------------
 * 1. The engine coordinate: project.options["oaktree-sapling"]
 * ------------------------------------------------------------------------ */

/**
 * The one knob (design §6). Rides in myst's untyped `options` passthrough at
 * `project.options["oaktree-sapling"]`, so it coexists with sibling option keys
 * a paper already uses (e.g. `options.youtube`, live in suheylgulenc); we must
 * validate this subkey without touching its siblings.
 *
 * `.loose()` tolerates future engine option keys on a paper pinned to a newer
 * engine; a paper is always read by its matched engine, but the resilience is free.
 */
export const OaktreeSaplingOptions = z
  .object({
    /** Engine ref: a released tag (`vX.Y.Z`), the engine default branch, a SHA, or
     *  a `refs/pull/N/merge` (the last two gated to non-fork/allowlist, see ref.ts). */
    version: z.string().min(1),
    /** Per-paper edition coordinate (dec. 22): selects `editions/<edition>.yml`.
     *  Required in the repo=paper (n=1) path we build first; a repo=journal build
     *  reads the version from `journal.yml` but still carries `edition` per paper. */
    edition: z.string().min(1),
  })
  .loose();
export type OaktreeSaplingOptions = z.infer<typeof OaktreeSaplingOptions>;

/** Pull + validate the engine key out of a myst `project.options` bag without
 *  disturbing sibling keys. Returns the parsed coordinate; throws on a bad/missing key. */
export function readEngineOptions(
  projectOptions: Record<string, unknown> | undefined,
): OaktreeSaplingOptions {
  const raw = projectOptions?.['oaktree-sapling'];
  if (raw === undefined) {
    throw new Error(msg.build.coordinateMissingFromResolved);
  }
  return OaktreeSaplingOptions.parse(raw);
}

/* --------------------------------------------------------------------------
 * 2. journal.yml: the instance manifest (engine-owned, additive-only)
 * ------------------------------------------------------------------------ */

export const PreviewConfig = z
  .object({
    /** 'cloudflare' | 'artifact': 'artifact' degrades to a build-artifact link when
     *  the tenant has no Cloudflare secrets ([R6], the hidden 4th human-floor item). */
    provider: z.enum(['cloudflare', 'artifact']).default('artifact'),
    cf_project_name: z.string().optional(),
    /** Preview branch naming; `{repo}` / `{pr}` placeholders ([R27]). */
    branch_pattern: z.string().default('paper-{repo}-{pr}'),
  })
  .loose();
export type PreviewConfig = z.infer<typeof PreviewConfig>;

export const ZenodoConfig = z
  .object({
    /** Optional Zenodo community identifier; a fresh tenant has none ([R19]). */
    community: z.string().optional(),
    /** Optional description paragraph appended to every deposit ([R19]); the ISP
     *  "created as part of the Neuromatch Impact Scholars Program" blurb lived
     *  hardcoded in zenodo-deposit.py:207 and moves here. */
    description_blurb: z.string().optional(),
  })
  .loose();
export type ZenodoConfig = z.infer<typeof ZenodoConfig>;

/**
 * A journal-selected check (slice 4 "Layer B"). The JOURNAL picks which editorial checks run
 * (by id) + per-check options; the paper author cannot weaken the set (it lives in
 * instance-config, a repo the author doesn't control). `optional: true` -> advisory: annotates
 * but never gates merge. `.loose()` carries per-check option keys.
 */
export const Check = z
  .object({
    id: z.string().min(1),
    optional: z.boolean().optional(),
  })
  .loose();
export type Check = z.infer<typeof Check>;

export const JournalConfig = z
  .object({
    name: z.string().min(1),
    url: z.string().optional(),
    /** Granularity tier (design §9). Only 'paper' is built now; the field is a
     *  forward contract so a repo=journal instance is detected, not assumed. */
    tier: z.enum(['paper', 'edition', 'journal']).default('paper'),
    /** The template's placeholder `id:` that `oak validate` must reject on real
     *  papers (finding 1: the sentinel is instance-defined, not a global constant:
     *  ISP's is `isp-micropublication-template`). */
    id_sentinel: z.string().optional(),
    /** Anchored regex a paper `id:` must match (SciPy-style id-pattern, [R7]). */
    id_pattern: z.string().optional(),
    /** The journal's own typst template ([R76]), `name | path | URL`, where only a
     *  `./`/`../` value is a path relative to the instance-config root. Sits between the
     *  author's own `exports[].template` (which outranks it, with a warning) and the
     *  engine's default. Absent → the engine's template, as before. */
    typst_template: z.string().optional(),
    preview: PreviewConfig.prefault({}),
    zenodo: ZenodoConfig.prefault({}),
    /** Journal-selected editorial checks run by `oak validate` (slice 4 Layer B). */
    checks: z.array(Check).default([]),
  })
  .loose();
export type JournalConfig = z.infer<typeof JournalConfig>;

/* --------------------------------------------------------------------------
 * 3. registry/papers.yml: the paper registry (engine-owned, additive-only)
 *
 * Finding 1: `id`, `slug`, and `location` are THREE distinct coordinates, not one.
 * Real ids are `isp-`-prefixed and sometimes semantic (suheylgulenc →
 * `isp-micropublication-decisive-times`), never the repo slug. Today's gallery
 * conflates all three into the repo name (paper-gallery.mjs:12); the target splits:
 *   - id       → the deposit/dedup key (myst-native project.id) ([R7])
 *   - slug     → the `/<slug>/` URL path + thumbnail location
 *   - location → {repo, path} where the paper actually lives (multi-per-repo, §9)
 * ------------------------------------------------------------------------ */

export const PaperLocation = z
  .object({
    /** owner/repo on GitHub. */
    repo: z.string().min(1),
    /** path within the repo to the paper project root; '.' for repo=paper. */
    path: z.string().default('.'),
  })
  .loose();

export const RegistryEntry = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    location: PaperLocation,
    /** Concept DOI; absent until the paper is deposited. */
    doi: z.string().optional(),
    /**
     * Where the paper is PUBLISHED, when it isn't where we'd guess. The gallery
     * (`plugins/gallery.mjs`) otherwise derives `https://<owner>.github.io/<name>` from
     * `location.repo`; set this for a custom domain or non-Pages hosting. Optional and
     * additive (dec. 24): the registry stays a thin pointer list ([S4]), so display
     * metadata (title, keywords) is still fetched per paper, never cached here.
     */
    site_url: z.string().optional(),
    edition: z.string().min(1),
  })
  .loose();
export type RegistryEntry = z.infer<typeof RegistryEntry>;

export const Registry = z.array(RegistryEntry);
export type Registry = z.infer<typeof Registry>;

/* --------------------------------------------------------------------------
 * 4. pins.yml: the trust boundary (design §6a, dec. 21, [R37])
 * Read by BOTH the CI shim (yq) and local `oak`, so they can't drift.
 * ------------------------------------------------------------------------ */

export const Pins = z
  .object({
    /** owner/repo the engine is checked out from; only the *ref* floats. */
    engine_repo: z.string().min(1),
    /** owner/repo of instance-config; '.' or omitted when co-located (repo=journal). */
    instance_repo: z.string().default('.'),
  })
  .loose();
export type Pins = z.infer<typeof Pins>;

/* --------------------------------------------------------------------------
 * 5. Paper-id validation (design dec. 20, two checks, different locality)
 * ------------------------------------------------------------------------ */

export type IdCheckResult =
  { ok: true } | { ok: false; severity: 'error' | 'warn'; message: string };

/**
 * Check A: sentinel + id-pattern. A pure function of the paper's own id and the
 * journal's policy; hard-fails everywhere, needs no registry. This is the check
 * that catches the live geetha bug (`id: isp-micropublication-template`, [R12]).
 */
export function checkIdShape(
  id: string,
  policy: { id_sentinel?: string; id_pattern?: string },
): IdCheckResult {
  if (policy.id_sentinel && id === policy.id_sentinel) {
    return {
      ok: false,
      severity: 'error',
      message: msg.validate.idPlaceholder(id),
    };
  }
  if (policy.id_pattern) {
    const re = new RegExp(policy.id_pattern);
    if (!re.test(id)) {
      return {
        ok: false,
        severity: 'error',
        message: msg.validate.idPatternMismatch(id, policy.id_pattern),
      };
    }
  }
  return { ok: true };
}

/**
 * Check B: registry uniqueness. Needs `registry/papers.yml`, so it hard-fails in
 * CI and any local build (instance present) and soft-warns in a bare local validate
 * with no instance (dec. 20). `self` is the paper's own registry slug, excluded so a
 * paper doesn't collide with its own entry.
 */
export function checkIdUniqueness(
  id: string,
  registry: Registry | null,
  self?: { slug?: string },
  opts: { selfIdentifiable?: boolean } = {},
): IdCheckResult {
  if (registry === null) {
    return {
      ok: false,
      severity: 'warn',
      message: msg.validate.idRegistryUnavailable(id),
    };
  }
  const clash = registry.find((e) => e.id === id && e.slug !== self?.slug);
  if (clash) {
    // Self-exclusion keys off the paper's repo (findSelf). Without a repo context, an
    // offline/local build with no GITHUB_REPOSITORY and a temp or non-origin checkout, we
    // cannot tell our OWN registry entry from a real duplicate, so we must not hard-gate:
    // downgrade to a warning. CI always sets GITHUB_REPOSITORY, so the gate stays hard there.
    if (opts.selfIdentifiable === false) {
      return {
        ok: false,
        severity: 'warn',
        message: msg.validate.idMaybeOwnEntry(id, clash.location.repo, clash.slug),
      };
    }
    return {
      ok: false,
      severity: 'error',
      message: msg.validate.idTaken(id, clash.location.repo, clash.slug),
    };
  }
  return { ok: true };
}

/* --------------------------------------------------------------------------
 * 6. JSON Schema export (author-editor autocomplete, design §12)
 * ------------------------------------------------------------------------ */

export function toJsonSchemas() {
  return {
    oaktreeSaplingOptions: z.toJSONSchema(OaktreeSaplingOptions),
    journal: z.toJSONSchema(JournalConfig),
    registry: z.toJSONSchema(Registry),
    pins: z.toJSONSchema(Pins),
  };
}
