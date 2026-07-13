import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { readFileSync } from 'node:fs';
import {
  readDoc,
  setExtends,
  applyOwnOverride,
  readEngineCoordinateRaw,
  readBrandAssetOptions,
} from '../src/yaml-io.js';

const fixturePaper = fileURLToPath(new URL('./fixture-paper/myst.yml', import.meta.url));
const fixtureInstance = fileURLToPath(new URL('./fixture-instance', import.meta.url));

describe('readEngineCoordinateRaw (local yq equivalent, §6a)', () => {
  it('reads version + edition from the raw doc, pre-extends', () => {
    const c = readEngineCoordinateRaw(readDoc(fixturePaper));
    expect(c).toEqual({ version: 'v0.3.0', edition: 'fixture-edition' });
  });

  it('throws clearly when the coordinate is absent', () => {
    const doc = parseDocument('version: 1\nproject:\n  id: x\n');
    expect(() => readEngineCoordinateRaw(doc)).toThrow(/missing/);
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

  it('applies brand asset overrides as individual site.options keys, leaving siblings ([R62])', () => {
    const doc = readDoc(fixturePaper);
    applyOwnOverride(doc, {
      site: {
        template: 'https://example.org/book-theme.zip',
        options: { logo: '/abs/instance/brand/logo.svg', favicon: '/abs/instance/brand/f.svg' },
      },
    });

    const out = parseDocument(doc.toString());
    expect(out.getIn(['site', 'template'])).toBe('https://example.org/book-theme.zip');
    expect(out.getIn(['site', 'options', 'logo'])).toBe('/abs/instance/brand/logo.svg');
    expect(out.getIn(['site', 'options', 'favicon'])).toBe('/abs/instance/brand/f.svg');
    // the author's project options are never touched by the site override
    expect(out.getIn(['project', 'options', 'youtube'])).toBe('https://youtu.be/dQw4w9WgXcQ');
  });
});

describe('readBrandAssetOptions ([R62])', () => {
  it('lifts the declared asset fields from the instance brand.yml', () => {
    // the fixture brand declares relative logo + favicon (the values compose() absolutizes)
    expect(readBrandAssetOptions(fixtureInstance)).toEqual({
      logo: './logo.svg',
      favicon: './favicon.svg',
    });
  });

  it('returns {} when the instance has no brand.yml', () => {
    expect(readBrandAssetOptions('/no/such/instance')).toEqual({});
  });
});
