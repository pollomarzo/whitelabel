/**
 * yaml-io.ts — working-tree myst.yml round-trips (design §12 "no sed/grep", [R3]).
 *
 * The two-pass build injects the `extends:` chain and then the engine `ownOverride` into
 * the paper's working-tree myst.yml. Both are YAML-lib round-trips through the `yaml`
 * Document API, which preserves the author's content, key order, and comments — never a
 * textual patch. Nothing here is committed; CI/local operate on the working tree.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { BRAND_ASSET_KEYS, type OwnOverride } from './compose.js';

export function readDoc(path: string): Document {
  return parseDocument(readFileSync(path, 'utf8'));
}

export function writeDoc(path: string, doc: Document): void {
  writeFileSync(path, doc.toString());
}

/** Raw read of the engine coordinate straight from the paper's own myst.yml — the local
 *  `oak` equivalent of the shim's `yq` read (design §6a): PRE-extends, so it can run
 *  before the engine/instance are even resolved. Mirrors the composite action exactly. */
export function readEngineCoordinateRaw(
  doc: Document,
): { version: string; edition: string } {
  const version = doc.getIn(['project', 'options', 'oaktree-sapling', 'version']);
  const edition = doc.getIn(['project', 'options', 'oaktree-sapling', 'edition']);
  if (typeof version !== 'string' || !version) {
    throw new Error('project.options["oaktree-sapling"].version missing from myst.yml');
  }
  if (typeof edition !== 'string' || !edition) {
    throw new Error('project.options["oaktree-sapling"].edition missing from myst.yml');
  }
  return { version, edition };
}

/** Raw read of the instance brand's asset fields ({@link BRAND_ASSET_KEYS}) straight from
 *  `<instanceRoot>/brand/brand.yml` — the values compose() absolutizes ([R62]). Read from
 *  brand.yml directly (not the merged config) so only brand-DECLARED assets are treated as
 *  brand-relative; a paper's own relative asset is never reinterpreted. Returns the fields
 *  per namespace (`site.options.*` for HTML, `project.options.logo` for the typst
 *  watermark). Absent file / keys → empty maps (compose emits nothing). */
export function readBrandAssetOptions(
  instanceRoot: string,
): { site: Record<string, string>; project: Record<string, string> } {
  const brandPath = join(instanceRoot, 'brand', 'brand.yml');
  const empty = { site: {}, project: {} };
  if (!existsSync(brandPath)) return empty;
  const doc = parseDocument(readFileSync(brandPath, 'utf8'));
  const lift = (namespace: 'site' | 'project', keys: readonly string[]) => {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = doc.getIn([namespace, 'options', key]);
      if (typeof value === 'string' && value) out[key] = value;
    }
    return out;
  };
  return {
    site: lift('site', BRAND_ASSET_KEYS.site),
    project: lift('project', BRAND_ASSET_KEYS.project),
  };
}

/** Pass 1: set the `extends:` chain (replaces any existing — the new-model committed
 *  paper carries none, but a migrating paper may still have URL pins we overwrite). */
export function setExtends(doc: Document, chain: string[]): void {
  if (chain.length === 0) doc.delete('extends');
  else doc.set('extends', chain);
}

/** Pass 2: merge the engine `ownOverride` into the working-tree own config. Touches
 *  `project.exports`, `site.template`, and individual `site.options.<asset>` /
 *  `project.options.<asset>` keys ([R62]). Asset keys are set individually (not by
 *  replacing the whole `options` map) so author sibling options — `youtube`, the
 *  `oaktree-sapling` coordinate — survive (finding 3). The only project option compose
 *  ever sets is the brand's typst watermark `logo`, a journal-owned asset. */
export function applyOwnOverride(doc: Document, override: OwnOverride): void {
  if (override.project?.exports) {
    doc.setIn(['project', 'exports'], override.project.exports);
  }
  if (override.project?.options) {
    for (const [key, value] of Object.entries(override.project.options)) {
      doc.setIn(['project', 'options', key], value);
    }
  }
  if (override.site?.template) {
    doc.setIn(['site', 'template'], override.site.template);
  }
  if (override.site?.options) {
    for (const [key, value] of Object.entries(override.site.options)) {
      doc.setIn(['site', 'options', key], value);
    }
  }
}
