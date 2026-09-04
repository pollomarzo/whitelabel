/**
 * docs-links.test.ts: the guard that keeps a printed documentation URL resolving.
 *
 * `messages.ts` prints these URLs to tenants, and a URL that has been printed is a published
 * interface: the page it names outlives the release that named it. Two things can silently
 * break one, and neither shows up in a type check or in the docs build:
 *
 *   1. A page or a `(label)=` target in `docs/` is renamed, and `docs-links.ts` still names the
 *      old one. The docs build only checks links written INSIDE docs/; it cannot see this
 *      table, so the anchor goes on resolving for MyST while the CLI sends people to a 404.
 *   2. Someone writes a docs URL as a literal instead of going through `docsUrl(DOCS.x)`,
 *      putting the domain back in a second place and escaping check 1 entirely.
 *
 * Both are cheap to assert and expensive to notice in the field, which is the whole argument
 * for this file. It reads the table as source text rather than importing it, so a topic that
 * is not yet referenced by any message is still checked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, docsUrl } from '../src/docs-links.js';
import { DOCS_BASE } from '../src/assets.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const docsDir = join(root, 'docs');
const srcDir = join(root, 'src');

describe('every documentation topic resolves', () => {
  for (const [symbol, topic] of Object.entries(DOCS)) {
    const [page, anchor] = topic.split('#');
    it(`DOCS.${symbol} → ${topic}`, () => {
      const file = join(docsDir, `${page}.md`);
      expect(existsSync(file), `no docs page at docs/${page}.md`).toBe(true);
      if (!anchor) return;
      // An explicit target, not a heading slug: a heading reworded in a docs-only PR would
      // otherwise move the anchor with it, and this table would not notice.
      const md = readFileSync(file, 'utf8');
      expect(
        md.includes(`(${anchor})=`),
        `docs/${page}.md has no "(${anchor})=" target, either restore it or repoint DOCS.${symbol}`,
      ).toBe(true);
    });
  }

  it('the table is the only place a topic path is written', () => {
    // `docsUrl` is what turns a topic into a URL; a literal that skips it is a second copy of
    // both the domain and the path, and check 1 above cannot see it.
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (extname(name) !== '.ts' || name === 'docs-links.ts' || name === 'assets.ts') continue;
      const src = readFileSync(join(srcDir, name), 'utf8');
      for (const m of src.matchAll(new RegExp(`${DOCS_BASE}\\S*`, 'g'))) {
        offenders.push(`${name}: ${m[0]}`);
      }
    }
    expect(offenders, `write docsUrl(DOCS.<topic>) instead:\n  ${offenders.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('every DOCS.<symbol> named in source is a real key', () => {
    // A code reference is typechecked; a `DOCS.foo` in a COMMENT is not, so a renamed symbol
    // leaves the comment pointing at nothing. This is check 1 for the comment side.
    const keys = new Set(Object.keys(DOCS));
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (extname(name) !== '.ts' || name === 'docs-links.ts') continue;
      const src = readFileSync(join(srcDir, name), 'utf8');
      for (const m of src.matchAll(/\bDOCS\.([A-Za-z_$][\w$]*)/g)) {
        if (!keys.has(m[1]!)) offenders.push(`${name}: DOCS.${m[1]}`);
      }
    }
    expect(offenders, `no such key in DOCS:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('docsUrl joins with exactly one slash, whatever the base looks like', () => {
    expect(docsUrl('guide/checks', 'https://example.org/docs')).toBe(
      'https://example.org/docs/guide/checks',
    );
    expect(docsUrl('guide/checks', 'https://example.org/docs/')).toBe(
      'https://example.org/docs/guide/checks',
    );
  });
});
