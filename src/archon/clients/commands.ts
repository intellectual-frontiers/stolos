/**
 * Spec 082: the `stolos clients` commands (add, list, remove, use, summary,
 * report, console) and `--client <id>`, which runs any command in one
 * client's scope.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { exists } from "../core/fsx.ts";
import { ui } from "../core/ui.ts";
import {
  choiceFile,
  chosenClient,
  type Client,
  findClient,
  loadClients,
  planAdd,
  registryFile,
  saveClients,
} from "./registry.ts";
import { enterClient, withClient } from "./scope.ts";

/**
 * Which client this run is for: `--client <id>`, else the chosen one (`clients
 * use`), else none. The `clients` commands themselves are the provider's and
 * run in no client's scope. Enters the scope; returns an error to print when
 * the client is unknown.
 */
export async function resolveClientScope(
  flag: string | undefined,
  command: string,
): Promise<{ client?: Client; error?: string }> {
  if (command === "clients") {
    return flag ? { error: "the clients commands are the provider's: drop --client" } : {};
  }
  // A scope set by the process that started this one (the console, sudo) stands as it is.
  if (!flag && Deno.env.get("ARCHON_CLIENT")) return {};
  const id = flag ?? await chosenClient();
  if (!id) return {};
  const c = await findClient(id);
  if (!c) {
    return {
      error: `no client ${id} (see: deno task stolos clients list)${
        flag ? "" : `; it was chosen with clients use: deno task stolos clients use --clear`
      }`,
    };
  }
  if (!(await exists(c.path))) {
    return { error: `client ${id}'s checkout is missing: ${c.path}` };
  }
  enterClient(c);
  return { client: c };
}

/** `stolos clients add <path>`: register a client's checkout. */
export async function clientsAdd(
  o: { path: string; fleet?: string; id?: string; title?: string },
): Promise<number> {
  const all = await loadClients();
  const r = planAdd(all, o);
  if ("error" in r) {
    console.error(`${ui.red("error:")} ${r.error}${r.fix ? `\n  fix: ${r.fix}` : ""}`);
    return 1;
  }
  const c = r.client;
  if (!o.title) {
    // The fleet's own title, read in the client's scope (a fleet that does not load keeps the id).
    try {
      const { loadFleet } = await import("../model/load.ts");
      c.title = await withClient(c, async () => (await loadFleet()).title || c.id);
    } catch { /* keep the id */ }
  }
  await saveClients([...all, c]);
  console.log(`added client ${c.id} (${c.title}): fleet ${c.fleet} in ${c.path}`);
  console.log(`  its state and secrets on this PC: ${(await scopedFolders(c)).join(", ")}`);
  console.log(`next: deno task stolos --client ${c.id} where`);
  return 0;
}

/** The per-user folders a client's scope uses on this PC. */
export function scopedFolders(c: Client): Promise<string[]> {
  return withClient(c, () => Promise.resolve([P.state, P.secrets]));
}

/** Forget the chosen client (none chosen is fine; any other failure is reported). */
async function clearChoice(): Promise<void> {
  try {
    await Deno.remove(choiceFile());
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** `stolos clients list`. */
export async function clientsList(json: boolean): Promise<number> {
  const all = await loadClients();
  const chosen = await chosenClient();
  if (json) {
    console.log(JSON.stringify({ chosen: chosen || null, clients: all }, null, 2));
    return 0;
  }
  if (!all.length) {
    console.log("no clients yet: deno task stolos clients add <path to a client's checkout>");
    return 0;
  }
  const w = Math.max(...all.map((c) => c.id.length));
  for (const c of all) {
    console.log(
      `${c.id === chosen ? "*" : " "} ${c.id.padEnd(w)}  ${c.title}  (fleet ${c.fleet}, ${c.path}${
        (await exists(c.path)) ? "" : ", missing"
      })`,
    );
  }
  console.log(ui.dim(`registry: ${registryFile()}`));
  return 0;
}

/** `stolos clients remove <id>`: forget a client (its checkout, state, and secrets stay). */
export async function clientsRemove(id: string): Promise<number> {
  const all = await loadClients();
  const c = all.find((x) => x.id === id);
  if (!c) {
    console.error(`${ui.red("error:")} no client ${id}`);
    return 1;
  }
  await saveClients(all.filter((x) => x.id !== id));
  if ((await chosenClient()) === id) await clearChoice();
  console.log(
    `removed client ${id} from the registry; nothing was deleted: its checkout (${c.path}) and its folders on this PC stay`,
  );
  return 0;
}

/** `stolos clients use <id>` (or `--clear`): the client every command is for, until changed. */
export async function clientsUse(id: string | undefined, clear: boolean): Promise<number> {
  if (clear || !id) {
    if (!clear) {
      const now = await chosenClient();
      console.log(now ? `using client ${now}` : "no client chosen");
      return 0;
    }
    await clearChoice();
    console.log("no client chosen: commands work on the fleet repository you are in");
    return 0;
  }
  const c = await findClient(id);
  if (!c) {
    console.error(`${ui.red("error:")} no client ${id} (see: deno task stolos clients list)`);
    return 1;
  }
  await Deno.mkdir(P.provider, { recursive: true });
  await Deno.writeTextFile(choiceFile(), id + "\n");
  console.log(`now using client ${id} (${c.title}) for every stolos command on this PC`);
  console.log("  --client <id> chooses another for one command; clients use --clear goes back");
  return 0;
}

/** `stolos clients summary`: every client's numbers, each read on its own. */
export async function clientsSummary(o: { since?: string; json: boolean }): Promise<number> {
  const { clientSummaries, totals } = await import("./summary.ts");
  const list = await clientSummaries(await loadClients(), o);
  if (o.json) {
    console.log(JSON.stringify({ totals: totals(list), clients: list }, null, 2));
    return 0;
  }
  const { summaryText } = await import("./report.ts");
  console.log(summaryText(list));
  return 0;
}

/** `stolos clients report --out <folder>`: one report per client, and the summary. */
export async function clientsReport(o: { out: string; since?: string }): Promise<number> {
  const p = ui.phase("Client reports");
  const all = await loadClients();
  const { reportFolder, writeReports } = await import("./report.ts");
  const f = reportFolder(o.out, all);
  if ("error" in f) {
    p.fail(f.error, "a folder of the provider's, outside every client's checkout");
    return 1;
  }
  const list = await writeReports(all, f.dir, {
    ...(o.since ? { since: o.since } : {}),
    each: (s, folder) =>
      s.readable ? p.ok(`${s.client}: ${folder}`) : p.warn(`${s.client}: not read: ${s.problem}`),
  });
  p.done(`${list.length} client report(s) and the summary in ${f.dir}`);
  return 0;
}

/** `stolos clients console`: every client in one console, on this PC. */
export async function clientsConsole(o: { port?: number; open?: boolean }): Promise<number> {
  const c = ui.phase("Provider console");
  const { Sessions } = await import("../console/auth.ts");
  const { Launch } = await import("../console/stolos-server.ts");
  const { providerHandler } = await import("./console.ts");
  const { realConsoleFor } = await import("./launch.ts");
  const { clientSummaries } = await import("./summary.ts");
  const { openBrowser } = await import("../console/stolos-launch.ts");
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "you";
  const port = o.port ?? 8092;
  const launch = new Launch();
  const person = { user, name: user };
  const consoleFor = realConsoleFor(port, person);
  const handler = providerHandler({
    port,
    person,
    launch,
    sessions: new Sessions(),
    clients: () => loadClients(),
    summaries: async () => await clientSummaries(await loadClients()),
    consoleFor,
    cacheDir: join(P.provider, "console-cache"),
  });
  let server: Deno.HttpServer;
  try {
    server = Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, handler);
  } catch (e) {
    c.fail(
      `port ${port} is taken (${(e as Error).message})`,
      `deno task stolos clients console --port ${port + 1}`,
    );
    return 1;
  }
  const url = `http://127.0.0.1:${port}/launch?t=${launch.issue()}`;
  c.done(`${(await loadClients()).length} client(s) on http://127.0.0.1:${port}`);
  console.log(`\n  Open (works once, for two minutes, on this PC only):\n\n    ${url}\n`);
  console.log("  Passphrases and tokens a command asks for are typed here, in this terminal.");
  console.log("  Ctrl+C stops the console.\n");
  if (o.open !== false) openBrowser(url);
  await server.finished;
  return 0;
}
