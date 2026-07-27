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
  processProject,
  findCurrentProjectAndLoad,
  findCurrentSiteAndLoad,
} from 'myst-cli';
import type { ISession } from 'myst-cli';
import type { MystEdge, BuildOpts } from './build.js';
import type { ResolvedProject } from './compose.js';

export function createMystEdge(): MystEdge {
  /**
   * One Session per config filename ([R71]). `configFiles` is a first-class Session option
   * (`myst-cli/session/session.js:70`, default `['myst.yml','myst.yaml']`) and every lookup
   * routes through it — `configFromPath`, `defaultConfigFile`, `project/load.js`, `fromTOC.js`,
   * `fromPath.js` — so pointing it at the derived config makes myst ignore the author's
   * `myst.yml` entirely. Keyed cache rather than one session: `build` reads the derived config
   * while `validate` (which does not compose) still reads the author's.
   */
  const sessions = new Map<string, Session>();
  const sessionFor = (configFile?: string): Session => {
    const key = configFile ?? '';
    let s = sessions.get(key);
    if (!s) {
      s = configFile ? new Session({ configFiles: [configFile] }) : new Session();
      sessions.set(key, s);
    }
    return s;
  };

  return {
    async loadProject(dir: string, configFile?: string): Promise<ResolvedProject> {
      const res = await loadConfig(sessionFor(configFile), dir);
      return (res?.project ?? {}) as ResolvedProject;
    },
    async build(dir: string, opts: BuildOpts, configFile?: string): Promise<void> {
      const session = sessionFor(configFile);
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
    async withProjectSession<T>(dir: string, fn: (session: ISession) => Promise<T>): Promise<T> {
      // Author's config (default configFiles): `oak validate` does not compose, so there is no
      // derived config to read. FOLLOW-UP OWED ([R71]): the Layer-B editorial checks arguably
      // should see the COMPOSED config, since that is what actually gets published — deliberately
      // not changed here, because it can flip the Journal-checks merge verdict and needs its own
      // evaluation rather than riding a mechanical refactor.
      const session = sessionFor();
      const prev = process.cwd();
      process.chdir(dir);
      try {
        // Set the current-project pointer ([R59] — bare loadConfig leaves it unset) AND process
        // the project into mdast, both from the paper root (cwd). The curvenote checks read from
        // cwd/'.': `loadProjectFromDisk` defaults to cwd and `selectLocalProjectConfig(state,'.')`
        // is keyed off it, so they must run with cwd === the paper root. No file writes, no HTML
        // theme, no exports — far lighter than a build; enough for the frontmatter/abstract checks.
        await findCurrentProjectAndLoad(session, '.');
        await processProject(session, { path: '.' }, { writeFiles: false, writeTOC: false });
        return await fn(session);
      } finally {
        process.chdir(prev);
      }
    },
  };
}
