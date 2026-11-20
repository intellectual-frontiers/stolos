/**
 * Spec 088: `stolos connector add | list | remove | test`, the connector
 * registry's commands, run in the fleet repository on your PC. Adding one is
 * like moving the engine's pin: checked first, then copied into the fleet
 * repository with its lock entry, then committed and pushed by you (pushing
 * is the approval).
 *
 * @module
 */
// Spec: 088-wave3-registry

import { sha256 } from "@intellectual-frontiers/crypto";
import { fs, http, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { VERSION } from "../version.ts";
import { PROBE_PREFIX } from "./registry-probe.ts";
import type { Declaration } from "./registry-contract.ts";
import {
  copyPath,
  declarationProblems,
  forgetRegistry,
  fromIndex,
  parseIndex,
  pinSource,
  registryEntries,
  type RegistryEntry,
  registryFile,
  registrySource,
} from "./registry.ts";

/** Where the commands work (default: the fleet repository and fleet this PC uses). */
export interface RegistryOptions {
  /** The fleet repository. */
  repo?: string;
  /** The fleet's folder (fleets/<fleet>). */
  fleetDir?: string;
  /** This engine's version (tests). */
  version?: string;
}

const where = (o: RegistryOptions): { repo: string; fleetDir: string; version: string } => ({
  repo: o.repo ?? P.repo,
  fleetDir: o.fleetDir ?? P.fleetDir,
  version: o.version ?? VERSION,
});

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** An Error's message, or the thrown value as text. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The environment variables the probe is given: only those the engine reads for its paths. */
const PROBE_ENV = [
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "ARCHON_SANDBOX",
  "ARCHON_REPO",
  "ARCHON_FLEET",
];

/** The probe's own file, beside this module (`.ts` from the sources, `.js` from the package). */
function probeFile(): string {
  const self = path.fromFileUrl(import.meta.url);
  return path.join(path.dirname(self), `registry-probe${path.extname(self)}`);
}

/**
 * Run the probe on a module (a file) in its own process, under the runtime
 * running this one: given only the environment variables the engine reads for
 * its paths, and no standard input. The module resolves the engine from the
 * folder it is in (a fleet repository's, or an author's own project's).
 */
export async function runProbe(repo: string, module: string): Promise<Declaration> {
  const env: Record<string, string> = {};
  for (const k of PROBE_ENV) {
    const v = proc.env.get(k);
    if (v !== undefined) env[k] = v;
  }
  const { runtimeCommand } = await import("../install/bun.ts");
  const r = await proc.run([...runtimeCommand(), probeFile(), module], {
    cwd: repo,
    env,
    clearEnv: true,
    stdin: "null",
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith(PROBE_PREFIX));
  if (!line) {
    const err = r.stderr.trim().split("\n").filter(Boolean);
    throw new Error(`the module does not load: ${err.slice(-3).join(" ") || `exit ${r.code}`}`);
  }
  // The probe writes a Declaration, or `{ error }` where the module does not load.
  const d = JSON.parse(line.slice(PROBE_PREFIX.length)) as Declaration & { error?: string };
  if (d.error) throw new Error(`the module does not load: ${d.error}`);
  return d;
}

/** A module's text: a file (a path or a file URL), or a GET over HTTP(S). */
async function fetchText(url: string): Promise<string> {
  if (url.startsWith("file:")) return await fs.readTextFile(path.fromFileUrl(url));
  if (!/^[a-z]+:/.test(url)) return await fs.readTextFile(url);
  const r = await http
    .liveTransport({ userAgent: "stolos" })
    .send({ method: "GET", url, headers: {} });
  if (r.kind === "err") throw new Error(`${url}: ${r.error.message}`);
  if (r.value.status >= 400) throw new Error(`${url}: HTTP ${r.value.status}`);
  return r.value.body;
}

async function builtInIds(): Promise<string[]> {
  return (await import("./commands.ts")).CONNECTORS.map((c) => c.id);
}

async function scfIds(): Promise<Set<string>> {
  return new Set((await import("../compliance/scf.ts")).SCF.map((c) => c.id));
}

/** What `connector add` and `connector test` find for one module. */
export interface Checked {
  /** The declaration, when the module loads. */
  declaration?: Declaration;
  /** The module's text, as fetched and checked. */
  text?: string;
  /** The module's SHA-256. */
  sha256?: string;
  /** What is wrong (none: it may be added). */
  problems: string[];
}

/**
 * Fetch, probe, and check one module against the engine and the fleet's other
 * connectors. A module fetched over HTTP(S) is probed from a file in the
 * fleet's `connectors/` folder (so it resolves the engine the fleet
 * installs), removed after; a local module is probed where it is.
 */
export async function checkModule(
  repo: string,
  fleetDir: string,
  module: string,
  others: string[],
  version: string,
): Promise<Checked> {
  let text: string;
  let hash: string;
  try {
    text = await fetchText(module);
    hash = await sha256(text);
  } catch (e) {
    return { problems: [messageOf(e)] };
  }
  const local = !/^https?:/.test(module);
  const file = local
    ? module.startsWith("file:")
      ? path.fromFileUrl(module)
      : path.resolve(module)
    : path.join(fleetDir, "connectors", `.check-${hash.slice(0, 16)}.ts`);
  let d: Declaration;
  try {
    if (!local) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeTextFile(file, text);
    }
    d = await runProbe(repo, file);
  } catch (e) {
    return { text, sha256: hash, problems: [messageOf(e)] };
  } finally {
    if (!local) await fs.remove(file).catch(() => undefined);
  }
  const problems = declarationProblems(d, {
    builtIns: await builtInIds(),
    others,
    version,
    scf: await scfIds(),
  });
  return { declaration: d, text, sha256: hash, problems };
}

/** `stolos connector add <source>@<ref> [--index <url>]`. */
export async function connectorAdd(
  spec: string,
  o: RegistryOptions & { index?: string; today?: string } = {},
): Promise<number> {
  const { repo, fleetDir, version } = where(o);
  const p = ui.phase("Connector");
  let pinned;
  try {
    const source = o.index ? fromIndex(parseIndex(await fetchText(o.index)), spec) : spec;
    pinned = pinSource(source);
  } catch (e) {
    p.fail(messageOf(e), "bun run stolos connector add https://github.com/<owner>/<repo>@v1.0.0");
    return fail();
  }
  const file = registryFile(fleetDir);
  const before = await fs.readTextOr(file);
  let entries: RegistryEntry[];
  try {
    entries = registryEntries(before);
  } catch (e) {
    p.fail(`${file}: ${messageOf(e)}`, "restore it from Git: git checkout -- " + file);
    return fail();
  }
  p.status(`checking ${pinned.module}`);
  const source = pinned.source;
  const same = (e: RegistryEntry): boolean => e.source === source;
  const c = await checkModule(
    repo,
    fleetDir,
    pinned.module,
    entries.filter((e) => !same(e)).map((e) => e.id),
    version,
  );
  const d = c.declaration;
  if (
    c.problems.length ||
    !d ||
    d.engine === undefined ||
    c.sha256 === undefined ||
    c.text === undefined
  ) {
    for (const x of c.problems) {
      p.fail(x, "the connector's author fixes it in a new tag; nothing was changed");
    }
    return fail();
  }
  const entry: RegistryEntry = {
    id: d.id,
    title: d.title,
    source,
    ref: pinned.ref,
    module: pinned.module,
    sha256: c.sha256,
    engine: d.engine,
    checkedWith: version,
    fixtures: d.fixtures.length,
    added: o.today ?? new Date().toISOString().slice(0, 10),
  };
  const replaced = entries.filter((e) => e.id === d.id || same(e));
  const next = [...entries.filter((e) => e.id !== d.id && !same(e)), entry];
  // The copy, byte for byte as checked, then the file that imports it and locks its hash.
  const copy = path.join(fleetDir, copyPath(d.id));
  await fs.mkdir(path.dirname(copy), { recursive: true });
  await fs.writeTextFile(copy, c.text);
  if ((await fs.sha256File(copy)) !== c.sha256) {
    await fs.remove(copy).catch(() => undefined);
    p.fail(`${copy} does not hash as checked`, "nothing was added; try again");
    return fail();
  }
  await fs.writeTextFile(file, registrySource(next));
  for (const e of replaced.filter((x) => x.id !== d.id)) {
    await fs.remove(path.join(fleetDir, copyPath(e.id))).catch(() => undefined);
  }
  forgetRegistry();
  p.done(
    `${d.title} (${d.id}) ${pinned.ref}: ${d.fixtures.length} fixture test(s) pass; engine ${d.engine}`,
  );
  const rel = (f: string): string => (f.startsWith(repo) ? f.slice(repo.length + 1) : f);
  ui.next.push(
    `review ${rel(file)} and ${rel(copy)}, then approve: bun run stolos apply -m "088-connectors: add ${d.id} ${pinned.ref}"`,
  );
  ui.next.push(`then: bun run stolos connect ${d.id}`);
  return fail();
}

/** `stolos connector list [--json]`. */
export async function connectorList(asJson = false, o: RegistryOptions = {}): Promise<number> {
  const { fleetDir, version } = where(o);
  const entries = registryEntries(await fs.readTextOr(registryFile(fleetDir)));
  const { engineSuits } = await import("./registry.ts");
  const rows = entries.map((e) => ({ ...e, suits: engineSuits(version, e.engine) === true }));
  if (asJson) {
    stdio.stdout.writeSync(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (!rows.length) {
    ui.phase("Connectors").done("none added (bun run stolos connector add <source>@<tag>)");
    return 0;
  }
  const { table } = await import("../state/query.ts");
  const lines = table(
    rows.map((e) => ({
      id: e.id,
      title: e.title,
      ref: e.ref,
      engine: e.engine,
      suits: e.suits ? "yes" : `no (this is ${version})`,
      source: e.source,
    })),
  );
  stdio.stdout.writeSync(`${lines}\n`);
  return 0;
}

/** `stolos connector remove <id>`: the import, the entry and the copy go; its observation stays in Git. */
export async function connectorRemove(id: string, o: RegistryOptions = {}): Promise<number> {
  const { fleetDir } = where(o);
  const p = ui.phase("Connector");
  const file = registryFile(fleetDir);
  const entries = registryEntries(await fs.readTextOr(file));
  if (!entries.some((e) => e.id === id)) {
    p.fail(`no added connector ${id}`, "bun run stolos connector list");
    return fail();
  }
  const rest = entries.filter((e) => e.id !== id);
  if (rest.length) await fs.writeTextFile(file, registrySource(rest));
  else await fs.remove(file);
  await fs.remove(path.join(fleetDir, copyPath(id))).catch(() => undefined);
  forgetRegistry();
  p.done(`${id} removed from ${file.replace(P.repo + "/", "")}`);
  ui.next.push(`forget its credential too: bun run stolos disconnect ${id} (before you apply)`);
  ui.next.push(`approve: bun run stolos apply -m "088-connectors: remove ${id}"`);
  return fail();
}

/**
 * `stolos connector test [id | path]`: each added connector (or one) is
 * probed again: its copy and its pinned module still hash as locked, it suits
 * this engine, and its fixtures pass. A path or URL tests a module not added
 * yet (the author's own check).
 */
export async function connectorTest(target?: string, o: RegistryOptions = {}): Promise<number> {
  const { repo, fleetDir, version } = where(o);
  const entries = registryEntries(await fs.readTextOr(registryFile(fleetDir)));
  const added = entries.find((e) => e.id === target);
  if (target && !added) {
    const p = ui.phase("Connector");
    const module = /^[a-z]+:/.test(target) ? target : await fs.realPath(target).catch(() => target);
    const c = await checkModule(
      repo,
      fleetDir,
      module,
      entries.map((e) => e.id),
      version,
    );
    for (const x of c.problems) p.fail(x, "fix it in the connector, then test again");
    for (const f of c.declaration?.fixtures.filter((f) => f.ok) ?? []) p.ok(`fixture: ${f.name}`);
    if (!c.problems.length && c.declaration) {
      p.done(`${c.declaration.title} (${c.declaration.id}): ready to publish at a tag`);
    }
    return fail();
  }
  if (!entries.length) {
    ui.phase("Connectors").done("none added");
    return 0;
  }
  for (const e of entries.filter((x) => !target || x.id === target)) {
    const p = ui.phase(e.title);
    const copy = path.join(fleetDir, copyPath(e.id));
    const copied = await fs.sha256File(copy).catch(() => undefined);
    if (copied !== e.sha256) {
      p.fail(
        `${copyPath(e.id)} does not hash as connectors.ts locks it`,
        "restore it from Git, or add it again",
      );
    }
    const c = await checkModule(
      repo,
      fleetDir,
      copy,
      entries.filter((x) => x.id !== e.id).map((x) => x.id),
      version,
    );
    const pinned = await fetchText(e.module).then(sha256, () => undefined);
    if (pinned !== undefined && pinned !== e.sha256) {
      p.fail(
        `${e.module} no longer hashes as locked`,
        "a pinned module must not change: remove it",
      );
    }
    for (const x of c.problems) {
      p.fail(x, `move to a newer tag: bun run stolos connector add ${e.source}@<tag>`);
    }
    if (!ui.problems.some((x) => x.phase === e.title)) {
      p.done(`${e.ref}: ${c.declaration?.fixtures.length ?? 0} fixture test(s) pass on ${version}`);
    }
  }
  return fail();
}
