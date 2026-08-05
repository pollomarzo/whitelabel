import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDoc,
  setExtends,
  applyOwnOverride,
  readEngineCoordinateRaw,
  readBrandAssetOptions,
  readTenantTypstTemplate,
} from '../src/yaml-io.js';

const fixturePaper = fileURLToPath(new URL('./fixture-paper/myst.yml', import.meta.url));
const fixtureInstance = fileURLToPath(new URL('./fixture-instance', import.meta.url));

describe('readEngineCoordinateRaw (local yq equivalent, §6a)', () => {
  it('reads version + edition from the raw doc, pre-extends', () => {
    const c = readEngineCoordinateRaw(readDoc(fixturePaper));
    expect(c).toEqual({ version: 'v0.3.0', edition: 'fixture-edition' });
  });

  it('throws clearly when the coordinate is absent — naming the file and the fix', () => {
    const doc = parseDocument('version: 1\nproject:\n  id: x\n');
    // A tenant-facing sentence (printed without a stack), not a bare internal message.
    expect(() => readEngineCoordinateRaw(doc, '/papers/one/myst.yml')).toThrow(
      /\/papers\/one\/myst\.yml has no engine version/,
    );
    expect(() => readEngineCoordinateRaw(doc, '/papers/one/myst.yml')).toThrow(
      /project\.options\.oaktree-sapling/,
    );
  });
});

describe('working-tree injection preserves author content ([R3])', () => {
  it('sets extends + overrides without disturbing options.youtube or comments', () => {
    const doc = readDoc(fixturePaper);
    setExtends(doc, ['.engine/paper-base.yml', '.instance/editions/fixture-edition.yml']);
    applyOwnOverride(doc, {
      project: {
        exports: [
          {
            id: 'typst-pdf',
            format: 'typst',
            articles: [{ file: 'index.md', level: 0 }],
            template: 'https://example.org/typst-template.zip',
          },
        ],
      },
      site: { template: 'https://example.org/book-theme.zip' },
    });

    const out = parseDocument(doc.toString());
    expect(out.getIn(['extends', 0])).toBe('.engine/paper-base.yml');
    expect(out.getIn(['project', 'exports', 0, 'template'])).toBe(
      'https://example.org/typst-template.zip',
    );
    expect(out.getIn(['site', 'template'])).toBe('https://example.org/book-theme.zip');
    // finding 3: the sibling option key is untouched
    expect(out.getIn(['project', 'options', 'youtube'])).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
    // and the engine coordinate the shim reads still resolves
    expect(readEngineCoordinateRaw(out)).toEqual({
      version: 'v0.3.0',
      edition: 'fixture-edition',
    });
    // a comment from the original file survived the round-trip
    expect(doc.toString()).toContain('# Fixture paper');
  });

  it('applies brand asset overrides as individual site+project option keys, leaving siblings ([R62])', () => {
    const doc = readDoc(fixturePaper);
    applyOwnOverride(doc, {
      project: { options: { logo: '/abs/instance/brand/logo-watermark.svg' } },
      site: {
        template: 'https://example.org/book-theme.zip',
        options: { logo: '/abs/instance/brand/logo.svg', favicon: '/abs/instance/brand/f.svg' },
      },
    });

    const out = parseDocument(doc.toString());
    expect(out.getIn(['site', 'template'])).toBe('https://example.org/book-theme.zip');
    expect(out.getIn(['site', 'options', 'logo'])).toBe('/abs/instance/brand/logo.svg');
    expect(out.getIn(['site', 'options', 'favicon'])).toBe('/abs/instance/brand/f.svg');
    // the typst watermark lands in project.options.logo
    expect(out.getIn(['project', 'options', 'logo'])).toBe(
      '/abs/instance/brand/logo-watermark.svg',
    );
    // the author's sibling project options are never clobbered (finding 3)
    expect(out.getIn(['project', 'options', 'youtube'])).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(out.getIn(['project', 'options', 'oaktree-sapling', 'version'])).toBe('v0.3.0');
  });
});

describe('readBrandAssetOptions ([R62])', () => {
  it('lifts the declared asset fields per namespace from the instance brand.yml', () => {
    // the fixture brand declares relative site logo/favicon + a typst watermark
    expect(readBrandAssetOptions(fixtureInstance)).toEqual({
      site: { logo: './logo.svg', favicon: './favicon.svg' },
      project: { logo: './logo-watermark.svg' },
    });
  });

  it('returns empty maps when the instance has no brand.yml', () => {
    expect(readBrandAssetOptions('/no/such/instance')).toEqual({ site: {}, project: {} });
  });
});

describe('readTenantTypstTemplate ([R76])', () => {
  /** A throwaway instance-config; the shared fixture deliberately declares NO tenant
   *  template, so the fixture builds keep rendering with the engine's. */
  function instanceWithJournal(body: string): string {
    const root = mkdtempSync(join(tmpdir(), 'oak-journal-'));
    writeFileSync(join(root, 'journal.yml'), body);
    return root;
  }

  it('lifts the journal.yml value raw — never through the extends merge', () => {
    const root = instanceWithJournal('name: J\ntypst_template: ./typst-template\n');
    expect(readTenantTypstTemplate(root)).toBe('./typst-template');
  });

  it('returns undefined when the journal declares none (the common case)', () => {
    expect(readTenantTypstTemplate(instanceWithJournal('name: J\n'))).toBeUndefined();
    expect(readTenantTypstTemplate(fixtureInstance)).toBeUndefined();
  });

  it('returns undefined when there is no journal.yml at all', () => {
    expect(readTenantTypstTemplate('/no/such/instance')).toBeUndefined();
  });
});
