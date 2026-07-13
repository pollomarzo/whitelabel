import { describe, it, expect } from 'vitest';
import { compose, type ComposeInput, type ResolvedProject } from '../src/compose.js';
import { typstTemplateUrl, themeZipUrl } from '../src/assets.js';

const ENGINE = '.engine';
const INSTANCE = '.instance';
const ENGINE_REPO = 'open-scholar-nexus/oaktree-sapling';
const VERSION = 'v0.3.0';
const EDITION = 'fixture-edition';

/** What loadConfig().project would return AFTER resolving paper-base + edition:
 *  the typst export carries `articles` (from the edition) and NO template (the edition
 *  no longer declares one — finding 2). Plus a sibling `youtube` option (finding 3). */
const resolvedProject: ResolvedProject = {
  id: 'fixture-2026-sample-paper',
  title: 'A Fixture Paper',
  options: {
    youtube: 'https://youtu.be/x',
    'oaktree-sapling': { version: VERSION, edition: EDITION },
  },
  exports: [
    { id: 'typst-pdf', format: 'typst', articles: [{ file: 'index.md', level: 0 }] },
  ],
};

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  paperRoot: '.',
  engineRoot: ENGINE,
  instanceRoot: INSTANCE,
  resolvedProject,
  engineRepo: ENGINE_REPO,
  engineVersion: VERSION,
  edition: EDITION,
  baseUrl: '/fixture-sample-paper',
  ...over,
});

describe('compose — extends chain', () => {
  it('assembles engine ‹ edition ‹ brand (no trailing fragment — [R52])', () => {
    const r = compose(base());
    expect(r.extendsChain).toEqual([
      `${ENGINE}/paper-base.yml`,
      `${INSTANCE}/editions/${EDITION}.yml`,
      `${INSTANCE}/brand/brand.yml`,
    ]);
  });

  it('--no-instance builds unbranded with only paper-base + a warning', () => {
    const r = compose(base({ instanceRoot: null }));
    expect(r.extendsChain).toEqual([`${ENGINE}/paper-base.yml`]);
    expect(r.warnings.join(' ')).toMatch(/no-instance/);
  });

  it("site build extends nexus-base instead of paper-base", () => {
    const r = compose(base({ buildKind: 'site' }));
    expect(r.extendsChain[0]).toBe(`${ENGINE}/nexus-base.yml`);
  });
});

describe('compose — asset overrides on own config (finding 2 / [R5], [R52])', () => {
  it('emits a COMPLETE typst entry (articles + engine template), not a partial', () => {
    const r = compose(base());
    const exp = r.ownOverride.project!.exports[0]!;
    expect(exp.template).toBe(typstTemplateUrl(ENGINE_REPO, VERSION));
    expect(exp.articles).toEqual([{ file: 'index.md', level: 0 }]); // carried, since no field-merge
    expect(exp.id).toBe('typst-pdf');
  });

  it('sets the version-matched theme zip as site.template', () => {
    const r = compose(base());
    expect(r.ownOverride.site!.template).toBe(themeZipUrl());
  });

  it('warns (not throws) when the resolved config has no typst export', () => {
    const r = compose(base({ resolvedProject: { ...resolvedProject, exports: [] } }));
    expect(r.ownOverride.project).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/no typst export/);
  });
});

describe('compose — brand asset absolutization ([R62])', () => {
  const brandAssets = {
    logo: './logo.svg',
    favicon: 'favicon.svg', // bare relative (no ./) also absolutized
    logo_dark: 'https://cdn.example.org/logo-dark.svg', // URL untouched
    style: '/already/absolute.css', // absolute untouched
  };

  it('rewrites instance-relative paths to <instanceRoot>/brand/<x>', () => {
    const r = compose(base({ brandAssets }));
    expect(r.ownOverride.site!.options).toMatchObject({
      logo: `${INSTANCE}/brand/logo.svg`,
      favicon: `${INSTANCE}/brand/favicon.svg`,
    });
  });

  it('passes URLs and already-absolute paths through untouched', () => {
    const r = compose(base({ brandAssets }));
    expect(r.ownOverride.site!.options!.logo_dark).toBe(
      'https://cdn.example.org/logo-dark.svg',
    );
    expect(r.ownOverride.site!.options!.style).toBe('/already/absolute.css');
  });

  it('still carries the theme site.template alongside the asset options', () => {
    const r = compose(base({ brandAssets }));
    expect(r.ownOverride.site!.template).toBe(themeZipUrl());
  });

  it('emits asset options even when the theme override is omitted (siteTemplate: null)', () => {
    const r = compose(base({ brandAssets, assetOverrides: { siteTemplate: null } }));
    expect(r.ownOverride.site!.template).toBeUndefined();
    expect(r.ownOverride.site!.options!.logo).toBe(`${INSTANCE}/brand/logo.svg`);
  });

  it('no brandAssets → no site.options (only the template)', () => {
    const r = compose(base());
    expect(r.ownOverride.site!.options).toBeUndefined();
  });

  it('--no-instance emits no asset options', () => {
    const r = compose(base({ instanceRoot: null, brandAssets }));
    expect(r.ownOverride.site?.options).toBeUndefined();
  });
});

describe('compose — finding 3: never clobber sibling options', () => {
  it('ownOverride touches only exports + site.template, never project.options', () => {
    const r = compose(base());
    expect(r.ownOverride.project).toEqual({
      exports: [expect.objectContaining({ id: 'typst-pdf' })],
    });
    expect(r.ownOverride.project).not.toHaveProperty('options');
  });
});

describe('compose — BASE_URL edge (design §12a)', () => {
  it('passes /<repo> in CI and "" locally', () => {
    expect(compose(base({ baseUrl: '/fixture-sample-paper' })).env.BASE_URL).toBe(
      '/fixture-sample-paper',
    );
    expect(compose(base({ baseUrl: '' })).env.BASE_URL).toBe('');
  });
});

describe('compose — R36 cross-check (shim raw vs loader resolved)', () => {
  it('throws when an extended config overrides project.options.oaktree-sapling', () => {
    const skewed: ResolvedProject = {
      ...resolvedProject,
      options: { 'oaktree-sapling': { version: 'v9.9.9', edition: EDITION } },
    };
    expect(() => compose(base({ resolvedProject: skewed }))).toThrow(/mismatch/);
  });
});
