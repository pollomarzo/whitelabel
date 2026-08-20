/**
 * assets.ts — version-matched asset URLs the committed paper/instance files never carry.
 *
 * compose() injects these so the single `options.oaktree-sapling.version` coordinate is
 * the only knob (design §6, §7). Two of them fix live bugs:
 *  - Typst template: today the *edition* config hardcodes a floating git URL
 *    (isp-micropublication-2025.yml:12, `…isp-lapreprint-typst.git` @ default branch) —
 *    finding 2 / [R5]. The engine owns it as a zip attached to each engine tag; the
 *    edition config drops `template:` and compose sets it here.
 *  - Theme zip: the myst-theme fork, kept for now (design §7), referenced by its own
 *    pinned release. That pin rides the engine tag (an engine-external dep the engine
 *    version selects), so it lives here as an engine constant, not in tenant files.
 */

/** myst-theme fork release pinned by THIS engine version (design §7 — dropped once
 *  upstream book-theme color customization lands). The fork currently lives at
 *  `impact-scholars/myst-theme` (the only real release zip, per the website's nexus.yml);
 *  a neutral home is TBD with the fork drop. Bump on an engine release. */
export const THEME_REPO = 'impact-scholars/myst-theme';
export const THEME_VERSION = 'v0.2.0';

/**
 * Where the tenant-facing documentation is published. The ONE place a docs URL is written
 * down: everything else names a TOPIC (`docs-links.ts`) and builds the URL from this base,
 * so moving the site — or a fork pointing at its own — is a one-line edit and never a grep.
 *
 * A URL printed by the CLI or stamped into a seeded file outlives the engine that wrote it,
 * so treat these paths as a published interface: pages may be rewritten, but the path and
 * its anchors should keep resolving. No trailing slash (`docsUrl` adds the separator).
 */
export const DOCS_BASE = 'https://scholar.nexus/oaktree-sapling';

/** Typst template zip attached to each engine release (design dec. 2, §7). */
export function typstTemplateUrl(engineRepo: string, engineVersion: string): string {
  return `https://github.com/${engineRepo}/releases/download/${engineVersion}/typst-template.zip`;
}

/** book-theme zip from the pinned fork release (design §7). */
export function themeZipUrl(
  themeRepo: string = THEME_REPO,
  themeVersion: string = THEME_VERSION,
): string {
  return `https://github.com/${themeRepo}/releases/download/${themeVersion}/book-theme.zip`;
}
