/**
 * myst.ts — the mystmd edge. The ONE module that imports the (bundled) myst-cli, so the
 * rest of the engine stays testable without the toolchain. Programmatic invocation
 * (design §0/§7a, [R51]): `new Session()` → `loadConfig` / `build`, no shell-out.
 *
 * The spike (whitelabel/bundling-test) proved `loadConfig`, `build`, and typst export all
 * run from a single esbuild CJS bundle on Node 24. `build()` reads the project from the
 * cwd, so we chdir into the paper root for the build call (as the spike's test6 did).
 *
 * SITE POINTER (found in the first live shim run): `loadConfig` populates the store's
 * `sites`/`projects` maps but does NOT set `currentSitePath`/`currentProjectPath` — those
 * are what `myst build --html` builds. The `myst` CLI sets them via `findCurrent*AndLoad`;
 * a bare `loadConfig` leaves `currentSitePath` undefined, so `build()` prints "No site
 * configuration found" and skips HTML (PDF still renders). So before building we call
 * myst's own `findCurrentProjectAndLoad` + `findCurrentSiteAndLoad` (same helpers the CLI
 * uses) — they reload the final working-tree config (picking up the two-pass override,
 * since the raw config changed → loadConfig's cache is bypassed) and set both pointers.
 */
import {
  Session,
  loadConfig,
  build,
  findCurrentProjectAndLoad,
  findCurrentSiteAndLoad,
} from 'myst-cli';
import type { MystEdge, BuildOpts } from './build.js';
import type { ResolvedProject } from './compose.js';

export function createMystEdge(): MystEdge {
  const session = new Session();
  return {
    async loadProject(dir: string): Promise<ResolvedProject> {
      const res = await loadConfig(session, dir);
      return (res?.project ?? {}) as ResolvedProject;
    },
    async build(dir: string, opts: BuildOpts): Promise<void> {
      const prev = process.cwd();
      process.chdir(dir);
      try {
        // Set the current project + site pointers from the FINAL (post-two-pass) config,
        // the way the myst CLI does — otherwise `build --html` finds no current site.
        await findCurrentProjectAndLoad(session, dir);
        if (opts.exportsOnly) {
          // Offline canary: typst export only, no site (HTML needs a network theme zip).
          await build(session, [], { typst: true } as Parameters<typeof build>[2]);
        } else {
          await findCurrentSiteAndLoad(session, dir);
          await build(session, [], { all: opts.all, html: opts.html });
        }
      } finally {
        process.chdir(prev);
      }
    },
  };
}
