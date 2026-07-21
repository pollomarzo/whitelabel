import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  checkLayout,
  checkBrandFavicon,
  checkBrandWatermark,
  runValidate,
  type FsProbes,
  checkLayerDisjointness,
  declaredKeys,
} from '../src/validate.js';
import type { MystEdge } from '../src/build.js';

const instanceRoot = fileURLToPath(new URL('./fixture-instance', import.meta.url));
const allTrue: FsProbes = { existsProbe: () => true, listTree: () => [] };
const allFalse: FsProbes = { existsProbe: () => false, listTree: () => [] };

function edgeReturning(project: unknown, checkResults: unknown[] = []): MystEdge {
  return {
    async loadProject() {
      return project as never;
    },
    async build() {},
    // The real edge loads+processes a myst session and runs the curvenote checks; the fake just
    // returns canned Layer-B results so the exit-code/combination logic stays unit-testable.
    async withProjectSession() {
      return checkResults as never;
    },
  };
}

describe('checkLayout', () => {
  it('flags a missing index.md', () => {
    const probes: FsProbes = { existsProbe: (p) => p.endsWith('myst.yml'), listTree: () => [] };
    expect(checkLayout('/paper', probes).some((r) => r.message.includes('index.md'))).toBe(true);
  });
  it('flags a stray nested myst.yml', () => {
    const probes: FsProbes = { existsProbe: () => true, listTree: () => ['myst.yml', 'sub/myst.yml'] };
    expect(checkLayout('/paper', probes).some((r) => r.message.includes('stray'))).toBe(true);
  });
  it('passes a clean layout', () => {
    const probes: FsProbes = { existsProbe: () => true, listTree: () => ['myst.yml', 'index.md'] };
    expect(checkLayout('/paper', probes)).toHaveLength(0);
  });
  it('ignores infra dirs the CI shim drops in (.engine, .git, node_modules)', () => {
    const probes: FsProbes = {
      existsProbe: () => true,
      listTree: () => [
        'myst.yml',
        'index.md',
        '.engine/test/fixture-paper/myst.yml', // engine checkout under the paper root
        '.engine/copier-template/myst.yml',
        '.git/whatever',
        'node_modules/pkg/myst.yml',
      ],
    };
    expect(checkLayout('/paper', probes)).toHaveLength(0);
  });
});

describe('checkBrandFavicon ([R61])', () => {
  it('warns when no favicon is declared', () => {
    expect(checkBrandFavicon({ instanceRoot: '/i' }, allTrue).ok).toBe(false);
  });
  it('passes a URL favicon (resolves for HTML)', () => {
    expect(checkBrandFavicon({ instanceRoot: '/i', favicon: 'https://x/f.ico' }, allFalse).ok).toBe(true);
  });
  it('warns an unresolvable local favicon', () => {
    expect(checkBrandFavicon({ instanceRoot: '/i', favicon: './f.svg' }, allFalse).ok).toBe(false);
  });
  it('passes a resolvable local favicon', () => {
    expect(checkBrandFavicon({ instanceRoot: '/i', favicon: './f.svg' }, allTrue).ok).toBe(true);
  });
});

describe('checkBrandWatermark ([R62])', () => {
  it('warns a URL watermark (typst cannot fetch)', () => {
    expect(checkBrandWatermark({ instanceRoot: '/i', logo: 'https://x/w.svg' }, allTrue).ok).toBe(false);
  });
  it('passes a resolvable local watermark', () => {
    expect(checkBrandWatermark({ instanceRoot: '/i', logo: './w.svg' }, allTrue).ok).toBe(true);
  });
  it('warns when no watermark is declared', () => {
    expect(checkBrandWatermark({ instanceRoot: '/i' }, allTrue).ok).toBe(false);
  });
});

describe('runValidate — exit codes over the fixture instance', () => {
  const goodProject = {
    id: 'fixture-2026-sample-paper',
    authors: [{ name: 'Ada Fixture', orcid: '0000-0002-1825-0097', roles: ['software'] }],
    abstract: 'A plain-language abstract.',
    keywords: ['fixtures'],
  };

  it('passes a well-formed paper against the fixture journal (exit 0)', async () => {
    const out = await runValidate(
      { paperRoot: '/paper', instanceRoot, edge: edgeReturning(goodProject) },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      allTrue,
    );
    expect(out.exitCode).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.checkRun.conclusion).toBe('success');
  });

  it('fails on the sentinel id + missing editorial fields (exit 1)', async () => {
    const bad = { id: 'fixture-template-placeholder', authors: [], abstract: '', keywords: [] };
    const out = await runValidate(
      { paperRoot: '/paper', instanceRoot, edge: edgeReturning(bad) },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      allTrue,
    );
    expect(out.exitCode).toBe(1);
    expect(out.errors.some((e) => e.check === 'id-shape')).toBe(true);
    expect(out.checkRun.conclusion).toBe('failure');
  });

  it('a bad id (identity) does NOT short-circuit Layer B — editorial checks still run, id still gates (exit 1)', async () => {
    // id-gate-relocation: an id error is `identity`, not `structural`, so myst can still process
    // and the author gets the full fix-list. Old behavior skipped Layer B on any Layer-A error.
    const bad = { id: 'fixture-template-placeholder', authors: [], abstract: '', keywords: [] };
    const out = await runValidate(
      { paperRoot: '/paper', instanceRoot, edge: edgeReturning(bad, [{ id: 'abstract-exists', status: 'fail', message: 'no abstract' }]) },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      allTrue,
    );
    expect(out.exitCode).toBe(1);
    // Layer B RAN despite the bad id (the whole point of the relocation):
    expect(out.checks.some((c) => c.id === 'abstract-exists')).toBe(true);
    // and the id finding is an `identity`-class error that still gates the Check Run:
    expect(out.errors.find((e) => e.check === 'id-shape')?.klass).toBe('identity');
    expect(out.checkRun.conclusion).toBe('failure');
  });

  it('a blocking Layer-B editorial fail gates the run (exit 1, failure)', async () => {
    const out = await runValidate(
      {
        paperRoot: '/paper',
        instanceRoot,
        edge: edgeReturning(goodProject, [{ id: 'authors-have-orcid', status: 'fail', message: 'no ORCID' }]),
      },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      allTrue,
    );
    expect(out.exitCode).toBe(1);
    expect(out.checkRun.conclusion).toBe('failure');
    expect(out.checks.some((c) => c.id === 'authors-have-orcid' && c.status === 'fail')).toBe(true);
  });

  it('an OPTIONAL Layer-B fail annotates but does not gate (exit 0)', async () => {
    const out = await runValidate(
      {
        paperRoot: '/paper',
        instanceRoot,
        edge: edgeReturning(goodProject, [
          { id: 'authors-have-orcid', status: 'fail', message: 'no ORCID', optional: true },
        ]),
      },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      allTrue,
    );
    expect(out.exitCode).toBe(0);
    expect(out.checkRun.conclusion).toBe('success');
  });

  // The edge throws when Layer B runs — stands in for `processProject` failing on an unbuildable
  // project (e.g. a missing index.md). Regression guard for the crash where such a throw took the
  // whole validator down with no report.
  const edgeThrowingInLayerB = (project: unknown): MystEdge => ({
    async loadProject() {
      return project as never;
    },
    async build() {},
    async withProjectSession() {
      throw new Error('processProject boom: no valid files');
    },
  });

  it('a blocking Layer-A error short-circuits Layer B instead of crashing (exit 1)', async () => {
    // index.md missing -> layout error -> Layer B is SKIPPED (its edge would throw). The run must
    // still resolve with the layout finding reported, not reject.
    const probes: FsProbes = { existsProbe: (p) => p.endsWith('myst.yml'), listTree: () => ['myst.yml'] };
    const out = await runValidate(
      { paperRoot: '/paper', instanceRoot, edge: edgeThrowingInLayerB(goodProject) },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      probes,
    );
    expect(out.exitCode).toBe(1);
    expect(out.errors.some((e) => e.check === 'layout')).toBe(true);
    expect(out.checks).toHaveLength(0);
    expect(out.checkRun.conclusion).toBe('failure');
  });

  it('guards an unexpected Layer-B throw into a reported error (exit 1, not a crash)', async () => {
    // Layer A clean, but the myst session load throws -> degrade to a reported editorial-checks
    // error result; the gate must not crash.
    const out = await runValidate(
      { paperRoot: '/paper', instanceRoot, edge: edgeThrowingInLayerB(goodProject) },
      { repo: 'open-scholar-nexus/fixture-sample-paper' },
      allTrue,
    );
    expect(out.exitCode).toBe(1);
    expect(out.checks.some((c) => c.id === 'editorial-checks' && c.status === 'error')).toBe(true);
    expect(out.checkRun.conclusion).toBe('failure');
  });

  it('bare --no-instance warns but does not fail; --strict flips it', async () => {
    const base = { paperRoot: '/paper', instanceRoot: null, edge: edgeReturning(goodProject) };
    const lax = await runValidate(base, { repo: null }, allTrue);
    expect(lax.exitCode).toBe(0);
    expect(lax.warnings.length).toBeGreaterThan(0);
    const strict = await runValidate(base, { repo: null, strict: true }, allTrue);
    expect(strict.exitCode).toBe(1);
  });
});

describe('checkLayerDisjointness — extends layers must own disjoint keys ([R72])', () => {
  const paperBase = {
    project: { thumbnail: 'thumbnails/thumbnail.png', exports: [{ id: 'typst-pdf' }] },
    site: { options: { hide_toc: true } },
  };
  const edition = {
    project: { subject: 'Micropublication', venue: 'Fixture 2026', license: 'CC-BY-4.0' },
  };
  const brand = {
    site: { options: { logo: './logo.svg', favicon: './favicon.svg' }, nav: [] },
    project: { options: { logo: './logo-watermark.svg' } },
  };

  it("passes for today's engine layers (they are disjoint)", () => {
    expect(
      checkLayerDisjointness([
        { name: 'paper-base.yml', config: paperBase },
        { name: 'editions/x.yml', config: edition },
        { name: 'brand/brand.yml', config: brand },
      ]),
    ).toEqual([]);
  });

  it('does NOT flag site.options siblings — that map merges field-wise ([R68])', () => {
    // paper-base owns site.options.hide_toc, brand owns site.options.logo. Comparing
    // `site.options` as a unit (rather than per leaf) would falsely flag these.
    const out = checkLayerDisjointness([
      { name: 'paper-base.yml', config: paperBase },
      { name: 'brand/brand.yml', config: brand },
    ]);
    expect(out).toEqual([]);
  });

  it('flags a real overlap (edition overriding a paper-base default)', () => {
    const greedyEdition = { ...edition, site: { options: { hide_toc: false } } };
    const out = checkLayerDisjointness([
      { name: 'paper-base.yml', config: paperBase },
      { name: 'editions/x.yml', config: greedyEdition },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('error');
    expect(out[0]!.message).toContain('site.options.hide_toc');
    expect(out[0]!.message).toContain('paper-base.yml vs editions/x.yml');
  });

  it('flags a top-level project key declared twice', () => {
    const out = checkLayerDisjointness([
      { name: 'editions/x.yml', config: edition },
      { name: 'brand/brand.yml', config: { project: { license: 'MIT' } } },
    ]);
    expect(out[0]!.message).toContain('project.license');
  });

  it('declaredKeys splits options to leaves but keeps other keys at top level', () => {
    expect(declaredKeys(brand).sort()).toEqual([
      'project.options.logo',
      'site.nav',
      'site.options.favicon',
      'site.options.logo',
    ]);
    expect(declaredKeys(paperBase).sort()).toEqual([
      'project.exports',
      'project.thumbnail',
      'site.options.hide_toc',
    ]);
  });

  it('tolerates empty / malformed layers', () => {
    expect(checkLayerDisjointness([{ name: 'a', config: null }, { name: 'b', config: {} }])).toEqual([]);
    expect(declaredKeys(undefined)).toEqual([]);
    expect(declaredKeys({ project: 'not-an-object' })).toEqual([]);
  });
});
