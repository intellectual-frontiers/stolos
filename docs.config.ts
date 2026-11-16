/**
 * The engine's documentation site (specs 055-documentation, 070-docs-in-code, 096-bun-runtime
 * FR-009): the configuration IFC Docs reads (`ifc-docs build` and `ifc-docs check`, commons
 * 0011-documentation FR-023), a `DocsConfig` of commons' package. The engine keeps no `about.ts`,
 * so its one package and its areas are given here (commons 0011-documentation FR-027), read from
 * the folders of `src/` themselves:
 *
 * - `overview`: `src/mod.ts`, the architecture in diagrams, first;
 * - one area for each guide that is not its folder's `mod.ts` (`src/releasing.ts`,
 *   `src/archon/install/workstation-guide.ts`, ...), so that its module comment is the area's
 *   overview;
 * - one area for each folder: `src/archon-boot/`, `src/stolos/`, the files of `src/archon/`
 *   itself, and each folder under `src/archon/` with its subfolders, `mod.ts` first, so that a
 *   guide written in a folder's `mod.ts` is that area's overview.
 *
 * An area's name is `docsArea` of `core/guides.ts`, which is also how `stolos docs` links to a
 * guide's page (`api/<area>/index.html`). Every module of `src/` but a test is in exactly one area,
 * so `ifc-docs check` holds every export to its TSDoc.
 *
 * @module
 */
import type { AboutArea, DocsConfig } from "@intellectual-frontiers/commons/docs";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { docsArea, GUIDES } from "./src/archon/core/guides.ts";

const ROOT = path.dirname(path.fromFileUrl(import.meta.url));

/** The guides that are not their folder's `mod.ts`: each opens an area of its own. */
const OWN: readonly string[] = GUIDES.map((g) => g.module).filter(
  (m) => m === "src/mod.ts" || !m.endsWith("/mod.ts"),
);

/** A guide's title by its module, where the module is a guide. */
const titleOf = (module: string): string | undefined =>
  GUIDES.find((g) => g.module === module)?.title;

/**
 * The modules of a folder, from the repository's root: `mod.ts` first, then the others in order,
 * with its subfolders when `deep`, leaving out tests and the guides that open an area of their own.
 */
async function modulesOf(dir: string, deep: boolean): Promise<string[]> {
  const files = deep
    ? (await fs.walkFiles(path.join(ROOT, dir))).map((f) => f.replace(/\\/g, "/"))
    : fs
        .readDirSync(path.join(ROOT, dir))
        .filter((e) => e.isFile)
        .map((e) => e.name);
  const names = files
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => `${dir}/${n}`)
    .filter((m) => !OWN.includes(m))
    .sort();
  const mod = `${dir}/mod.ts`;
  return [...names.filter((m) => m === mod), ...names.filter((m) => m !== mod)];
}

/** A folder's area: its name from its `mod.ts`, its title the guide's where `mod.ts` is one. */
async function folderArea(dir: string, title: string, deep: boolean): Promise<AboutArea> {
  const mod = `${dir}/mod.ts`;
  return {
    title: titleOf(mod) ?? title,
    slug: docsArea(mod),
    entryPoints: await modulesOf(dir, deep),
  };
}

const archonFolders = fs
  .readDirSync(path.join(ROOT, "src", "archon"))
  .filter((e) => e.isDirectory)
  .map((e) => e.name)
  .sort();

const areas: AboutArea[] = [
  { title: "Overview", slug: docsArea("src/mod.ts"), entryPoints: ["src/mod.ts"] },
  ...OWN.filter((m) => m !== "src/mod.ts").map((m) => ({
    title: titleOf(m) ?? m,
    slug: docsArea(m),
    entryPoints: [m],
  })),
  await folderArea("src/stolos", "The stolos command", false),
  await folderArea("src/archon", "The archon command", false),
  await folderArea("src/archon-boot", "The boot server", true),
  ...(await Promise.all(
    archonFolders.map((d) => folderArea(`src/archon/${d}`, `archon ${d}`, true)),
  )),
].filter((a) => a.entryPoints.length > 0);

/** The engine's site: one package (the engine, by area), its spec kit and constitution. */
export const config: DocsConfig = {
  name: "Stolos",
  subject: "the engine",
  repository: "https://github.com/intellectual-frontiers/stolos",
  home: {
    dir: ".",
    about: {
      title: "Stolos",
      summary:
        "Stolos, the fleet engine: the `archon` command, the boot server, and everything general " +
        "about turning bare metal into a converged, verified Ubuntu host. A fleet repository " +
        "depends on it by Git at a tag (spec 096-bun-runtime). Start with the guides: each is the " +
        "overview of the area of the code it explains (spec 070-docs-in-code).",
    },
  },
  packages: [
    {
      dir: ".",
      slug: "engine",
      about: {
        title: "The engine",
        summary:
          "The engine's modules, by folder of `src/`; each guide is the overview of its area.",
        areas,
      },
    },
  ],
  specKits: [{ layout: "spec-kit", dir: "specs" }],
  citations: {
    prefix: "stolos",
    digits: 3,
    linked: [
      { repo: "commons", site: "https://intellectual-frontiers.github.io/.github/", digits: 4 },
    ],
    text: ["erga", "archon", "thyra"],
  },
  out: "out/docs",
};

export default config;
