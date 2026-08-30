/**
 * materialize-parity.test.ts: the guard that keeps `oak build` and `oak validate` composing
 * from the same inputs.
 *
 * [R82] made validate read the COMPOSED config by sharing `materializeDerived` with build, and
 * claimed on that basis that "neither verb can drift from the other". `implementation.md`
 * records that as false as shipped: the FUNCTION was shared, its INPUTS were not. `buildPaper`
 * passed `assetOverrides` (notably `engineTypstTemplate: <engineRoot>/templates/typst`, which
 * exists in every checkout including CI); `cmdValidate` passed none. So validate stamped the
 * release-zip URL where build stamped the local path: two different files under one name.
 * `readStampedTemplate` (`zenodo.ts`) reads that file as the record of what the build rendered
 * with, so a local build then validate then deposit archived the wrong provenance and could
 * throw after a build that did happen. Proven live on the `lai` pilot.
 *
 * The fix was `assetOverridesFrom`, called from both verbs. It shipped without a regression
 * test, and the type checker cannot be one: `MaterializeInput.assetOverrides` is OPTIONAL, so
 * dropping it from a call site compiles cleanly. That is the hole this file covers.
 *
 * It asserts the SOURCE-level invariant rather than the values, because the failure is a call
 * site that stops passing something, not a function returning the wrong thing. Every verb that
 * materializes must build its input from the one shared builder; then a field added for build
 * reaches validate and start whether or not anyone remembers them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');

/** Call sites of `name(`, ignoring its own `function name(` declaration. */
function callsTo(src: string, name: string): number {
  return src.split('\n').filter((l) => l.includes(`${name}(`) && !l.includes(`function ${name}(`)).length;
}

describe('build and validate materialize from the same inputs', () => {
  it('assetOverridesFrom is reached only through the shared builder', () => {
    // If this drops to 0 the builder stopped passing overrides; if it rises above 1 a verb has
    // started deriving its own, which is exactly the shape of the shipped bug.
    expect(callsTo(cli, 'assetOverridesFrom')).toBe(1);
    const builder = cli.slice(cli.indexOf('function materializeInputFrom'));
    expect(builder.slice(0, builder.indexOf('\n}')).includes('assetOverridesFrom(argv)')).toBe(true);
  });

  it('every verb that materializes spreads the shared builder', () => {
    // build, start and validate. Spreading rather than re-listing fields is the point: a new
    // MaterializeInput field is picked up by all three without being remembered three times.
    expect(callsTo(cli, 'materializeInputFrom')).toBe(3);
    expect(cli.match(/\.\.\.materializeInputFrom\(argv, paperRoot, /g)?.length).toBe(3);
  });

  it('validate does not rebuild the shared fields by hand', () => {
    // The pre-fix shape: cmdValidate listing paperRoot/engineRoot/engineRepo/assetOverrides
    // itself. Anything re-listed here can silently diverge from what the build passes.
    const call = cli.slice(cli.indexOf('await runValidate('));
    // Drop the builder call itself: `paperRoot` and `instanceRoot` are its ARGUMENTS there,
    // not fields validate re-lists.
    const body = call
      .slice(0, call.indexOf('\n      },'))
      .split('\n')
      .filter((l) => !l.includes('materializeInputFrom('))
      .join('\n');
    for (const field of ['engineRoot:', 'engineRepo:', 'assetOverrides:', 'baseUrl:', 'paperRoot,', 'instanceRoot,']) {
      expect(body, `runValidate re-lists ${field} instead of taking it from the builder`).not.toContain(field);
    }
  });
});
