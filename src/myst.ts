/**
 * myst.ts — the mystmd edge. The ONE module that imports the (bundled) myst-cli, so the
 * rest of the engine stays testable without the toolchain. Programmatic invocation
 * (design §0/§7a, [R51]): `new Session()` → `loadConfig` / `build`, no shell-out.
 *
 * The spike (whitelabel/bundling-test) proved `loadConfig`, `build`, and typst export all
 * run from a single esbuild CJS bundle on Node 24. `build()` reads the project from the
 * cwd, so we chdir into the paper root for the build call (as the spike's test6 did).
 */
import { Session, loadConfig, build } from 'myst-cli';
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
        await build(session, [], { all: opts.all, html: opts.html });
      } finally {
        process.chdir(prev);
      }
    },
  };
}
