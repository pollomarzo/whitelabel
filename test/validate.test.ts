import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  checkLayout,
  checkBrandFavicon,
  checkBrandWatermark,
  runValidate,
  type FsProbes,
} from '../src/validate.js';
import type { MystEdge } from '../src/build.js';

const instanceRoot = fileURLToPath(new URL('./fixture-instance', import.meta.url));
const allTrue: FsProbes = { existsProbe: () => true, listTree: () => [] };
const allFalse: FsProbes = { existsProbe: () => false, listTree: () => [] };

function edgeReturning(project: unknown): MystEdge {
  return {
    async loadProject() {
      return project as never;
    },
    async build() {},
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

  it('bare --no-instance warns but does not fail; --strict flips it', async () => {
    const base = { paperRoot: '/paper', instanceRoot: null, edge: edgeReturning(goodProject) };
    const lax = await runValidate(base, { repo: null }, allTrue);
    expect(lax.exitCode).toBe(0);
    expect(lax.warnings.length).toBeGreaterThan(0);
    const strict = await runValidate(base, { repo: null, strict: true }, allTrue);
    expect(strict.exitCode).toBe(1);
  });
});
