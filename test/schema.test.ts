import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  OaktreeSaplingOptions,
  readEngineOptions,
  JournalConfig,
  Registry,
  Pins,
  checkIdShape,
  checkIdUniqueness,
  ENGINE_ID_SENTINEL,
  toJsonSchemas,
} from '../src/schema.js';

const read = (rel: string) =>
  parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

describe('OaktreeSaplingOptions', () => {
  it('parses a valid coordinate', () => {
    const opt = OaktreeSaplingOptions.parse({ version: 'v0.3.0', edition: 'e' });
    expect(opt).toEqual({ version: 'v0.3.0', edition: 'e' });
  });

  it('rejects a missing version', () => {
    expect(() => OaktreeSaplingOptions.parse({ edition: 'e' })).toThrow();
  });

  it('tolerates a future engine option key (additive-only)', () => {
    expect(() =>
      OaktreeSaplingOptions.parse({ version: 'v1', edition: 'e', future: true }),
    ).not.toThrow();
  });
});

describe('readEngineOptions (finding 3: sibling options coexist)', () => {
  it('extracts the engine key without tripping on a sibling youtube option', () => {
    const projectOptions = {
      youtube: 'https://youtu.be/x',
      'oaktree-sapling': { version: 'v0.3.0', edition: 'fixture-edition' },
    };
    expect(readEngineOptions(projectOptions)).toEqual({
      version: 'v0.3.0',
      edition: 'fixture-edition',
    });
  });

  it('throws a clear error when the engine key is absent', () => {
    expect(() => readEngineOptions({ youtube: 'x' })).toThrow(/missing/);
  });
});

describe('fixtures parse against the schemas', () => {
  it('fixture journal.yml is a valid JournalConfig', () => {
    const j = JournalConfig.parse(read('./fixture-instance/journal.yml'));
    expect(j.name).toBe('Fixture Journal');
    expect(j.preview.provider).toBe('artifact');
    expect(j.zenodo.community).toBe('fixture-community');
  });

  it('fixture registry is a valid Registry with distinct id/slug/location', () => {
    const r = Registry.parse(read('./fixture-instance/registry/papers.yml'));
    expect(r).toHaveLength(1);
    const e = r[0]!;
    expect(e.id).toBe('fixture-2026-sample-paper');
    expect(e.slug).toBe('fixture-sample-paper'); // slug ≠ id
    expect(e.location.repo).toBe('open-scholar-nexus/fixture-sample-paper');
  });

  it('fixture paper options round-trip through readEngineOptions', () => {
    const paper = read('./fixture-paper/myst.yml');
    expect(readEngineOptions(paper.project.options)).toEqual({
      version: 'v0.3.0',
      edition: 'fixture-edition',
    });
  });
});

describe('JournalConfig additive-only (dec. 24)', () => {
  it('ignores an unknown top-level key instead of rejecting', () => {
    const j = JournalConfig.parse({ name: 'X', future_field: 42 });
    expect(j.name).toBe('X');
  });
});

describe('checkIdShape (check A: catches the live geetha bug [R12])', () => {
  const policy = {
    id_sentinel: 'fixture-template-placeholder',
    id_pattern: '^fixture-\\d{4}-[a-z0-9-]+$',
  };

  it('rejects the template sentinel id', () => {
    const r = checkIdShape('fixture-template-placeholder', policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('error');
  });

  it('rejects an id that violates the pattern', () => {
    const r = checkIdShape('NotMatching', policy);
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed unique id', () => {
    expect(checkIdShape('fixture-2026-sample-paper', policy).ok).toBe(true);
  });

  it("rejects the engine's own placeholder under an EMPTY policy ([R119]a)", () => {
    // A tenant deleting id_sentinel + id_pattern must not turn the engine's contract off.
    expect(checkIdShape(ENGINE_ID_SENTINEL, {}).ok).toBe(false);
    expect(checkIdShape(ENGINE_ID_SENTINEL, policy).ok).toBe(false);
    expect(checkIdShape('fixture-2026-sample-paper', {}).ok).toBe(true);
  });

  it('is the id the paper template actually ships', () => {
    const template = read('../templates/paper/myst.yml');
    expect(template.project.id).toBe(ENGINE_ID_SENTINEL);
  });
});

describe('checkIdUniqueness (check B, needs the registry)', () => {
  const registry = Registry.parse(read('./fixture-instance/registry/papers.yml'));

  it('flags a duplicate id owned by another paper', () => {
    const r = checkIdUniqueness('fixture-2026-sample-paper', registry, {
      slug: 'a-different-paper',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('error');
  });

  it('does not flag a paper against its own registry entry', () => {
    const r = checkIdUniqueness('fixture-2026-sample-paper', registry, {
      slug: 'fixture-sample-paper',
    });
    expect(r.ok).toBe(true);
  });

  it('soft-warns when the registry is unavailable (bare local validate)', () => {
    const r = checkIdUniqueness('anything', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('warn');
  });

  it('downgrades a clash to a warning when self is not identifiable (no repo context)', () => {
    // Offline/local build: no GITHUB_REPOSITORY, temp checkout; the paper's own entry
    // cannot be distinguished from a real duplicate, so it must not hard-gate.
    const r = checkIdUniqueness('fixture-2026-sample-paper', registry, undefined, {
      selfIdentifiable: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('warn');
  });
});

describe('Pins', () => {
  it('defaults instance_repo to "." when omitted (co-located repo=journal)', () => {
    const p = Pins.parse({ engine_repo: 'open-scholar-nexus/oaktree-sapling' });
    expect(p.instance_repo).toBe('.');
  });
});

describe('JSON Schema export', () => {
  it('emits schemas for author-editor autocomplete', () => {
    const s = toJsonSchemas();
    expect(s.journal).toHaveProperty('type', 'object');
    expect(s.oaktreeSaplingOptions).toHaveProperty('properties');
  });
});
