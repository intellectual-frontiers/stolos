/**
 * Spec 088: `stolos connector add | list | remove | test`, the connector
 * registry's commands, run in the fleet repository on your PC. Adding one is
 * like moving the engine's pin: checked first, then written with its lock
 * entry, then committed and pushed by you (pushing is the approval).
 *
 * @module
 */

import { fromFileUrl, join, toFileUrl } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { ui } from "../core/ui.ts";
import { VERSION } from "../version.ts";
import { PROBE_PREFIX } from "./registry-probe.ts";
import type { Declaration } from "./registry-contract.ts";
import {
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

const where = (o: RegistryOptions) => ({
  repo: o.repo ?? P.repo,
  fleetDir: o.fleetDir ?? P.fleetDir,
  version: o.version ?? VERSION,
});

const fail = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The engine's base URL as the fleet repository pins it (`@stolos/` in deno.json), resolved. */
export async function engineBase(repo: string): Promise<string> {
  const text = await readTextOr(join(repo, "deno.json"));
  const pin = text ? (JSON.parse(text).imports?.["@stolos/"] as string | undefined) : undefined;
  if (!pin) throw new Error(`${join(repo, "deno.json")} has no @stolos/ import`);
  return new URL(pin, toFileUrl(join(repo, "deno.json"))).href;
}

/** The host (and port) a URL is fetched from, for --allow-import; undefined for a file. */
const hostOf = (u: string) => (u.startsWith("file:") ? undefined : new URL(u).host);

/**
 * Run the probe on a module in its own restricted Deno process: imports from
 * the module's host and the engine's only, no network, no files (a local
 * module reads its own folder, a local engine its sources), and only the
 * environment variables the engine reads for its paths.
 */
export async function runProbe(repo: string, module: string): Promise<Declaration> {
  const base = await engineBase(repo);
  const probe = new URL("archon/connect/registry-probe.ts", base).href;
  const hosts = [...new Set([hostOf(module), hostOf(probe)].filter((h): h is string => !!h))];
  // A local module (an author's own) reads its own folder; a local engine, its sources.
  const reads = [new URL(".", module).href, base].filter((u) => u.startsWith("file:")).map((u) =>
    fromFileUrl(u)
  );
  const args = [
    "run",
    "--no-prompt",
    "--no-lock",
    `--config=${join(repo, "deno.json")}`,
    ...(hosts.length ? [`--allow-import=${hosts.join(",")}`] : []),
    "--allow-env=HOME,USERPROFILE,LOCALAPPDATA,APPDATA,XDG_DATA_HOME,XDG_CONFIG_HOME,ARCHON_SANDBOX,ARCHON_REPO,ARCHON_FLEET",
    ...(reads.length ? [`--allow-read=${reads.join(",")}`] : []),
    probe,
    module,
  ];
  const r = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout);
  const line = out.split("\n").find((l) => l.startsWith(PROBE_PREFIX));
  if (!line) {
    const err = new TextDecoder().decode(r.stderr).trim().split("\n").filter(Boolean);
    throw new Error(`the module does not load: ${err.slice(-3).join(" ") || `exit ${r.code}`}`);
  }
  const d = JSON.parse(line.slice(PROBE_PREFIX.length)) as Declaration & { error?: string };
  if (d.error) throw new Error(`the module does not load: ${d.error}`);
  return d;
}

/** The SHA-256 deno.lock holds for a URL, or undefined. */
export async function lockedHash(repo: string, url: string): Promise<string | undefined> {
  const text = await readTextOr(join(repo, "deno.lock"));
  if (!text) return undefined;
  try {
    const lock = JSON.parse(text) as { remote?: Record<string, string> };
    return lock.remote?.[url];
  } catch {
    return undefined;
  }
}

async function fetchText(url: string): Promise<string> {
  if (url.startsWith("file:")) return await Deno.readTextFile(new URL(url));
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`${url}: HTTP ${r.status}`);
  }
  return await r.text();
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
  /** The module's SHA-256. */
  sha256?: string;
  /** What is wrong (none: it may be added). */
  problems: string[];
}

/** Fetch, probe, and check one module against the engine and the fleet's other connectors. */
export async function checkModule(
  repo: string,
  module: string,
  others: string[],
  version: string,
): Promise<Checked> {
  let sha256: string;
  try {
    sha256 = await sha256Hex(await fetchText(module));
  } catch (e) {
    return { problems: [(e as Error).message] };
  }
  let d: Declaration;
  try {
    d = await runProbe(repo, module);
  } catch (e) {
    return { sha256, problems: [(e as Error).message] };
  }
  const problems = declarationProblems(d, {
    builtIns: await builtInIds(),
    others,
    version,
    scf: await scfIds(),
  });
  return { declaration: d, sha256, problems };
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
    if (o.index) spec = fromIndex(parseIndex(await fetchText(o.index)), spec);
    pinned = pinSource(spec);
  } catch (e) {
    p.fail(
      (e as Error).message,
      "deno task stolos connector add https://github.com/<owner>/<repo>@v1.0.0",
    );
    return fail();
  }
  const file = registryFile(fleetDir);
  const before = await readTextOr(file);
  let entries: RegistryEntry[];
  try {
    entries = registryEntries(before);
  } catch (e) {
    p.fail(`${file}: ${(e as Error).message}`, "restore it from Git: git checkout -- " + file);
    return fail();
  }
  p.status(`checking ${pinned.module}`);
  const same = (e: RegistryEntry) => e.source === pinned.source;
  const c = await checkModule(
    repo,
    pinned.module,
    entries.filter((e) => !same(e)).map((e) => e.id),
    version,
  );
  if (c.problems.length || !c.declaration || !c.sha256) {
    for (const x of c.problems) {
      p.fail(x, "the connector's author fixes it in a new tag; nothing was changed");
    }
    return fail();
  }
  const d = c.declaration;
  const entry: RegistryEntry = {
    id: d.id,
    title: d.title,
    source: pinned.source,
    ref: pinned.ref,
    module: pinned.module,
    sha256: c.sha256,
    engine: d.engine!,
    checkedWith: version,
    fixtures: d.fixtures.length,
    added: o.today ?? new Date().toISOString().slice(0, 10),
  };
  const next = [...entries.filter((e) => e.id !== d.id && !same(e)), entry];
  await Deno.mkdir(fleetDir, { recursive: true });
  await Deno.writeTextFile(file, registrySource(next));
  const undo = async () => {
    if (before === undefined) {
      await Deno.remove(file).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
    } else await Deno.writeTextFile(file, before);
  };
  // Deno's lock: the hash of every file the connector loads, beside the engine's.
  p.status("locking (deno.lock)");
  const rel = file.startsWith(repo) ? file.slice(repo.length + 1) : file;
  const cache = await new Deno.Command(Deno.execPath(), {
    args: ["cache", "--allow-import", "--lock=deno.lock", rel],
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!cache.success) {
    await undo();
    const err = new TextDecoder().decode(cache.stderr).trim().split("\n").pop();
    p.fail(
      `deno.lock could not take it: ${err}`,
      "nothing was changed; check the network and try again",
    );
    return fail();
  }
  const locked = await lockedHash(repo, pinned.module);
  if (locked !== c.sha256) {
    await undo();
    p.fail(
      `the module changed while it was added (deno.lock ${
        locked ?? "has none"
      }, checked ${c.sha256})`,
      "a pinned module must not change: ask its author, and add it again",
    );
    return fail();
  }
  forgetRegistry();
  p.done(
    `${d.title} (${d.id}) ${pinned.ref}: ${d.fixtures.length} fixture test(s) pass; engine ${d.engine}`,
  );
  ui.next.push(
    `review and approve: git add ${rel} deno.lock && git commit -S -m "088-connectors: add ${d.id} ${pinned.ref}" && git push`,
  );
  ui.next.push(`then: deno task stolos connect ${d.id}`);
  return fail();
}

/** `stolos connector list [--json]`. */
export async function connectorList(json = false, o: RegistryOptions = {}): Promise<number> {
  const { fleetDir, version } = where(o);
  const entries = registryEntries(await readTextOr(registryFile(fleetDir)));
  const { satisfies } = await import("./registry.ts");
  const rows = entries.map((e) => ({ ...e, suits: satisfies(version, e.engine) === true }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    ui.phase("Connectors").done("none added (deno task stolos connector add <source>@<tag>)");
    return 0;
  }
  const { table } = await import("../state/query.ts");
  console.log(table(rows.map((e) => ({
    id: e.id,
    title: e.title,
    ref: e.ref,
    engine: e.engine,
    suits: e.suits ? "yes" : `no (this is ${version})`,
    source: e.source,
  }))));
  return 0;
}

/** `stolos connector remove <id>`: the import and the entry go; its observation stays in Git. */
export async function connectorRemove(id: string, o: RegistryOptions = {}): Promise<number> {
  const { fleetDir } = where(o);
  const p = ui.phase("Connector");
  const file = registryFile(fleetDir);
  const entries = registryEntries(await readTextOr(file));
  if (!entries.some((e) => e.id === id)) {
    p.fail(`no added connector ${id}`, "deno task stolos connector list");
    return fail();
  }
  const rest = entries.filter((e) => e.id !== id);
  if (rest.length) await Deno.writeTextFile(file, registrySource(rest));
  else await Deno.remove(file);
  forgetRegistry();
  p.done(`${id} removed from ${file.replace(P.repo + "/", "")}`);
  ui.next.push(`forget its credential too: deno task stolos disconnect ${id} (before you commit)`);
  ui.next.push(`review and approve: git commit -S -am "088-connectors: remove ${id}" && git push`);
  return fail();
}

/**
 * `stolos connector test [id | path]`: each added connector (or one) is
 * probed again at its pin: its module still hashes as locked, it suits this
 * engine, and its fixtures pass. A path or URL tests a module not added yet
 * (the author's own check).
 */
export async function connectorTest(target?: string, o: RegistryOptions = {}): Promise<number> {
  const { repo, fleetDir, version } = where(o);
  const entries = registryEntries(await readTextOr(registryFile(fleetDir)));
  const added = entries.find((e) => e.id === target);
  if (target && !added) {
    const p = ui.phase("Connector");
    const module = /^[a-z]+:/.test(target)
      ? target
      : toFileUrl((await exists(target)) ? await Deno.realPath(target) : target).href;
    const c = await checkModule(repo, module, entries.map((e) => e.id), version);
    for (const x of c.problems) p.fail(x, "fix it in the connector, then test again");
    for (const f of c.declaration?.fixtures.filter((f) => f.ok) ?? []) p.ok(`fixture: ${f.name}`);
    if (!c.problems.length) {
      p.done(`${c.declaration!.title} (${c.declaration!.id}): ready to publish at a tag`);
    }
    return fail();
  }
  if (!entries.length) {
    ui.phase("Connectors").done("none added");
    return 0;
  }
  for (const e of entries.filter((x) => !target || x.id === target)) {
    const p = ui.phase(e.title);
    const c = await checkModule(
      repo,
      e.module,
      entries.filter((x) => x.id !== e.id).map((x) => x.id),
      version,
    );
    if (c.sha256 && c.sha256 !== e.sha256) {
      p.fail(
        `${e.module} no longer hashes as locked`,
        "a pinned module must not change: remove it",
      );
    }
    const locked = await lockedHash(repo, e.module);
    if (locked && locked !== e.sha256) {
      p.fail(
        "deno.lock and connectors.ts disagree",
        "add it again: deno task stolos connector add",
      );
    }
    for (const x of c.problems) {
      p.fail(x, `move to a newer tag: deno task stolos connector add ${e.source}@<tag>`);
    }
    if (!ui.problems.some((x) => x.phase === e.title)) {
      p.done(`${e.ref}: ${c.declaration?.fixtures.length ?? 0} fixture test(s) pass on ${version}`);
    }
  }
  return fail();
}
