/**
 * gallery.test.ts: the journal site's `paper-cards` plugin ([R80]).
 *
 * The plugin is a standalone `.mjs` myst loads at runtime by URL, not engine TypeScript,
 * so vitest imports it directly. The directive/transform shell is deliberately thin and the
 * decisions are exported as PURE helpers, which is what makes them testable here with no
 * myst session and no network.
 *
 * There is no offline canary for the rendered gallery: an HTML build needs the network theme
 * ([R60]), so "the card actually renders" is a live check, not a unit one.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs consumed by myst at runtime; no types by design.
import {
  selectEntries,
  paperUrls,
  cardFrom,
  loadRegistry,
  fetchPaperConfig,
  REGISTRY_PATH,
} from '../plugins/gallery.mjs';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'j-2026-alpha',
  slug: 'alpha',
  location: { repo: 'me/alpha-paper', path: '.' },
  edition: 'ed-2026',
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  project: { title: 'An Alpha Paper', keywords: ['neuro', 'imaging'], ...over },
});

/* -------------------------------------------------------------------------- */

describe('selectEntries', () => {
  const registry = [
    entry({ slug: 'a', edition: 'ed-2026' }),
    entry({ slug: 'b', edition: 'ed-2025' }),
    entry({ slug: 'c', edition: 'ed-2026' }),
  ];

  it('returns EVERY paper when :edition: is omitted (the scaffold single-page case)', () => {
    expect(selectEntries(registry).map((e: { slug: string }) => e.slug)).toEqual(['a', 'b', 'c']);
    expect(selectEntries(registry, {}).map((e: { slug: string }) => e.slug)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('filters by edition when given', () => {
    expect(
      selectEntries(registry, { edition: 'ed-2026' }).map((e: { slug: string }) => e.slug),
    ).toEqual(['a', 'c']);
  });

  it('preserves REGISTRY FILE ORDER: the editor controls sequence by insertion point', () => {
    const reversed = [...registry].reverse();
    expect(selectEntries(reversed).map((e: { slug: string }) => e.slug)).toEqual(['c', 'b', 'a']);
  });
});

describe('paperUrls', () => {
  it('derives the Pages URL from location.repo when site_url is absent', () => {
    const u = paperUrls(entry());
    expect(u.siteUrl).toBe('https://me.github.io/alpha-paper');
    expect(u.configUrl).toBe('https://raw.githubusercontent.com/me/alpha-paper/HEAD/myst.yml');
    expect(u.thumbUrl).toBe(
      'https://raw.githubusercontent.com/me/alpha-paper/HEAD/thumbnails/thumbnail.png',
    );
  });

  it('honors site_url (custom domain / non-Pages hosting) without touching the raw URLs', () => {
    const u = paperUrls(entry({ site_url: 'https://journal.example.org/alpha' }));
    expect(u.siteUrl).toBe('https://journal.example.org/alpha');
    expect(u.configUrl).toBe('https://raw.githubusercontent.com/me/alpha-paper/HEAD/myst.yml');
  });

  it('respects location.path: what keeps the n>1 tier reachable', () => {
    const u = paperUrls(entry({ location: { repo: 'me/journal', path: 'papers/alpha' } }));
    expect(u.configUrl).toBe(
      'https://raw.githubusercontent.com/me/journal/HEAD/papers/alpha/myst.yml',
    );
    expect(u.thumbUrl).toBe(
      'https://raw.githubusercontent.com/me/journal/HEAD/papers/alpha/thumbnails/thumbnail.png',
    );
  });

  it('uses HEAD, not main, so a differently-named default branch still resolves', () => {
    expect(paperUrls(entry()).configUrl).toContain('/HEAD/');
    expect(paperUrls(entry()).configUrl).not.toContain('/main/');
  });

  it('throws naming the entry when location.repo is missing or malformed', () => {
    expect(() => paperUrls(entry({ location: { path: '.' } }))).toThrow(/alpha/);
    expect(() => paperUrls(entry({ location: { repo: 'nope' } }))).toThrow(/location\.repo/);
  });
});

describe('cardFrom', () => {
  const kinds = (card: { children: Array<{ type: string }> }) => card.children.map((c) => c.type);

  it('renders title + thumbnail + keywords, linked to the paper site', () => {
    const card = cardFrom(entry(), config());
    expect(card.type).toBe('card');
    expect(card.url).toBe('https://me.github.io/alpha-paper');
    expect(kinds(card)).toEqual(['header', 'image', 'paragraph']);
    expect(card.children[0].children[0].value).toBe('An Alpha Paper');
    expect(card.children[1].url).toContain('thumbnails/thumbnail.png');
    expect(card.children[2].children[0].value).toBe('neuro | imaging');
  });

  it('renders the DOI as TEXT, never a link (a DOI link becomes a citation)', () => {
    const card = cardFrom(entry({ doi: '10.5281/zenodo.123' }), config());
    expect(kinds(card)).toContain('footer');
    const node = card.children.at(-1).children[0].children[0];
    expect(node.type).toBe('text');
    expect(node.value).toBe('DOI: 10.5281/zenodo.123');
    // Regression guard for the first live run: myst turns any link whose url is a DOI into a
    // `cite` (dois.ts:239-242), which renders a citation label + a bibliography on the card
    // and costs a rate-limited doi.org fetch per paper; one bad DOI reddens the journal.
    expect(JSON.stringify(card)).not.toContain('doi.org');
  });

  it('omits keywords and DOI when there are none', () => {
    const card = cardFrom(entry(), config({ keywords: undefined }));
    expect(kinds(card)).toEqual(['header', 'image']);
  });

  it('falls back to the slug when the fetched config has no title', () => {
    expect(cardFrom(entry(), { project: {} }).children[0].children[0].value).toBe('alpha');
  });

  it('does NOT fetch the thumbnail itself; myst downloads the emitted URL (stage: document)', () => {
    // The card carries a REMOTE image url; transformImagesToDisk localizes it later, which
    // is also what makes a broken thumbnail an error-kind warning under --strict.
    expect(cardFrom(entry(), config()).children[1].url).toMatch(/^https:\/\//);
  });
});

describe('fetchPaperConfig: failure is HARD (a broken registry must be fixed)', () => {
  it('throws with the offending slug AND url; the fix is a registry edit, so name it', async () => {
    const notFound = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchPaperConfig(entry(), notFound)).rejects.toThrow(
      /alpha.*raw\.githubusercontent\.com\/me\/alpha-paper\/HEAD\/myst\.yml.*404/s,
    );
    await expect(fetchPaperConfig(entry(), notFound)).rejects.toThrow(REGISTRY_PATH);
  });

  it('throws on a network error too, not just a bad status', async () => {
    const boom = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    await expect(fetchPaperConfig(entry(), boom)).rejects.toThrow(/ENOTFOUND/);
  });

  it('parses the fetched YAML on success', async () => {
    const ok = async () => ({ ok: true, text: async () => 'project:\n  title: Fetched\n' });
    expect(await fetchPaperConfig(entry(), ok)).toEqual({ project: { title: 'Fetched' } });
  });
});

describe('loadRegistry', () => {
  it('reads a list of entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oak-reg-'));
    const file = join(dir, 'papers.yml');
    writeFileSync(file, '- id: x\n  slug: x\n  edition: e\n  location:\n    repo: me/x\n');
    expect(loadRegistry(file)).toEqual([
      { id: 'x', slug: 'x', edition: 'e', location: { repo: 'me/x' } },
    ]);
  });

  it('an empty registry is a valid empty list (the directive renders "No papers found.")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oak-reg-'));
    const file = join(dir, 'papers.yml');
    writeFileSync(file, '[]\n');
    expect(loadRegistry(file)).toEqual([]);
  });

  it('a missing registry is FATAL, not an empty gallery', () => {
    expect(() => loadRegistry('/nonexistent/registry/papers.yml')).toThrow(/cannot read/);
  });

  it('a non-list registry is fatal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oak-reg-'));
    const file = join(dir, 'papers.yml');
    writeFileSync(file, 'papers: []\n');
    expect(() => loadRegistry(file)).toThrow(/must be a LIST/);
  });
});

describe('the plugin name is load-bearing', () => {
  it('is exactly what the site workflow greps for', async () => {
    // The site workflow asserts `Paper Gallery.*loaded` in the build log, because a plugin
    // that fails to load does not fail `myst build --strict` (verified on a live run, [R80]).
    // Renaming the plugin silently disarms that guard, so pin the name here.
    const plugin = (await import('../plugins/gallery.mjs')).default as { name: string };
    expect(plugin.name).toBe('Paper Gallery');
  });
});
