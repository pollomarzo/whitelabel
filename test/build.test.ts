import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { runBuild, type MystEdge } from '../src/build.js';
import type { ResolvedProject } from '../src/compose.js';
import { typstTemplateUrl, themeZipUrl } from '../src/assets.js';

const fixturePaper = fileURLToPath(new URL('./fixture-paper/myst.yml', import.meta.url));

/** A copy of the fixture paper in a temp dir so the two-pass writes don't mutate it. */
function tmpPaper(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oak-build-'));
  copyFileSync(fixturePaper, join(dir, 'myst.yml'));
  writeFileSync(join(dir, 'index.md'), '# Fixture\n');
  return dir;
}

/** Fake edge: loadProject returns what loadConfig WOULD return post-extends (typst export
 *  with articles from the edition, youtube sibling), and records the build call. */
function fakeEdge(): { edge: MystEdge; calls: string[] } {
  const calls: string[] = [];
  const resolved: ResolvedProject = {
    id: 'fixture-2026-sample-paper',
    title: 'A Fixture Paper',
    options: {
      youtube: 'https://youtu.be/x',
      'oaktree-sapling': { version: 'v0.3.0', edition: 'fixture-edition' },
    },
    exports: [
      { id: 'typst-pdf', format: 'typst', articles: [{ file: 'index.md', level: 0 }] },
    ],
  };
  return {
    calls,
    edge: {
      async loadProject() {
        calls.push('load');
        return resolved;
      },
      async build(_dir, opts) {
        calls.push(`build:${opts.all}:${opts.html}`);
      },
    },
  };
}

describe('runBuild — the two-pass orchestrator ([R52])', () => {
  it('injects extends, then writes the engine override to the OWN config, then builds', async () => {
    const paperRoot = tmpPaper();
    const { edge, calls } = fakeEdge();

    const res = await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'open-scholar-nexus/oaktree-sapling',
      baseUrl: '/fixture-sample-paper',
      edge,
    });

    // order: resolve (pass 1) BEFORE build (pass 2)
    expect(calls).toEqual(['load', 'build:true:true']);

    const doc = parseDocument(readFileSync(join(paperRoot, 'myst.yml'), 'utf8'));
    // extends chain written in pass 1
    expect(doc.getIn(['extends', 0])).toBe('.engine/paper-base.yml');
    expect(doc.getIn(['extends', 1])).toBe('.instance/editions/fixture-edition.yml');
    expect(doc.getIn(['extends', 2])).toBe('.instance/brand/brand.yml');
    // complete typst entry on own config (release URL, articles carried)
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe(
      typstTemplateUrl('open-scholar-nexus/oaktree-sapling', 'v0.3.0'),
    );
    expect(doc.getIn(['project', 'exports', 0, 'articles', 0, 'file'])).toBe('index.md');
    // theme override + sibling option preserved. NB the author's ORIGINAL youtube
    // survives — the override pass never touches options, and loadConfig's resolved
    // value ('…/x') is never written back to the working tree (finding 3).
    expect(doc.getIn(['site', 'template'])).toBe(themeZipUrl());
    expect(doc.getIn(['project', 'options', 'youtube'])).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );

    expect(res.resolvedProject.id).toBe('fixture-2026-sample-paper');
  });

  it('honors assetOverrides (local typst template, omitted site template)', async () => {
    const paperRoot = tmpPaper();
    const { edge } = fakeEdge();
    await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'x/y',
      baseUrl: '',
      assetOverrides: { typstTemplate: '/local/typst', siteTemplate: null },
      edge,
    });
    const doc = parseDocument(readFileSync(join(paperRoot, 'myst.yml'), 'utf8'));
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe('/local/typst');
    expect(doc.getIn(['site', 'template'])).toBeUndefined(); // omitted → myst default theme
  });
});
