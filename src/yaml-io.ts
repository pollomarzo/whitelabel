/**
 * yaml-io.ts — working-tree myst.yml round-trips (design §12 "no sed/grep", [R3]).
 *
 * The two-pass build injects the `extends:` chain and then the engine `ownOverride` into
 * the paper's working-tree myst.yml. Both are YAML-lib round-trips through the `yaml`
 * Document API, which preserves the author's content, key order, and comments — never a
 * textual patch. Nothing here is committed; CI/local operate on the working tree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument, type Document } from 'yaml';
import type { OwnOverride } from './compose.js';

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

/** Pass 1: set the `extends:` chain (replaces any existing — the new-model committed
 *  paper carries none, but a migrating paper may still have URL pins we overwrite). */
export function setExtends(doc: Document, chain: string[]): void {
  if (chain.length === 0) doc.delete('extends');
  else doc.set('extends', chain);
}

/** Pass 2: merge the engine `ownOverride` into the working-tree own config. Only
 *  `project.exports` and `site.template` are touched — never `project.options`
 *  (finding 3: sibling option keys like `youtube` are left intact). */
export function applyOwnOverride(doc: Document, override: OwnOverride): void {
  if (override.project?.exports) {
    doc.setIn(['project', 'exports'], override.project.exports);
  }
  if (override.site?.template) {
    doc.setIn(['site', 'template'], override.site.template);
  }
}
