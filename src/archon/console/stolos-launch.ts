/**
 * Spec 066: `stolos console`: the Stolos Console on this PC. It checks that
 * your GitHub account (gh) may push to the fleet repository, listens on
 * 127.0.0.1, prints a one-time launch link (and opens it), and runs until
 * Ctrl+C. Commands run in the fleet repository with this terminal as their
 * input, so passphrases and tokens are typed here, never in the browser.
 *
 * @module
 */

import { engineFileOr } from "../core/assets.ts";
import { run } from "../core/exec.ts";
import { readTextOr } from "../core/fsx.ts";
import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { markdownToHtml } from "../web/markdown.ts";
import { Sessions } from "./auth.ts";
import { stripAnsi } from "./exec.ts";
import { activityLog } from "./machine.ts";
import { pcFacts } from "./pc.ts";
import { PC_GUIDES } from "./stolos-pages.ts";
import { Launch, type PcRunner, stolosHandler } from "./stolos-server.ts";
import type { Estate } from "../estate/graph.ts";

/** Your GitHub login, and whether it may push to the fleet repository; or why it cannot tell. */
export async function githubCheck(
  slug: string,
): Promise<{ login?: string; push?: boolean; why?: string }> {
  const who = await run(["gh", "api", "user", "--jq", ".login"]).catch(() => undefined);
  if (!who) return { why: "gh is not installed (https://cli.github.com)" };
  if (!who.ok) return { why: "gh is not signed in: gh auth login" };
  const login = who.stdout.trim();
  if (!slug) return { login, why: "the fleet repository has no GitHub origin" };
  const p = await run(["gh", "api", `repos/${slug}`, "--jq", ".permissions.push"]);
  if (!p.ok) return { login, push: false, why: `${login} cannot see ${slug}` };
  return { login, push: p.stdout.trim() === "true" };
}

/** Runs `deno task stolos <argv>` in the fleet repository; this terminal is its input. */
export function pcRunner(repo = P.repo): PcRunner {
  return async (argv, each) => {
    const p = new Deno.Command(Deno.execPath(), {
      args: ["task", "-q", "stolos", ...argv],
      cwd: repo,
      env: { ARCHON_PLAIN: "1", NO_COLOR: "1", ARCHON_VIA: "console" },
      stdin: "inherit",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const c of s) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          each(stripAnsi(buf.slice(0, i).replace(/\r$/, "")));
          buf = buf.slice(i + 1);
        }
      }
      if (buf) each(stripAnsi(buf));
    };
    await Promise.all([pump(p.stdout), pump(p.stderr)]);
    return (await p.status).code;
  };
}

/** How long the REST API reuses the estate graph it built (spec 094). */
export const ESTATE_TTL_MS = 60_000;

/** The estate graph from the fleet repository, with its findings, built at most once a minute. */
export function estateFor(): () => Promise<Estate> {
  let at = 0;
  let last: Promise<Estate> | undefined;
  return () => {
    if (!last || Date.now() - at > ESTATE_TTL_MS) {
      at = Date.now();
      last = (async () => {
        const { loadEstate } = await import("../estate/commands.ts");
        const { estatePolicies } = await import("../estate/graph.ts");
        const e = await loadEstate();
        estatePolicies(e);
        return e;
      })();
      last.catch(() => (last = undefined));
    }
    return last;
  };
}

function openBrowser(url: string): void {
  const cmd = Deno.build.os === "windows"
    ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : Deno.build.os === "darwin"
    ? ["open", url]
    : ["xdg-open", url];
  try {
    new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "null", stderr: "null" }).spawn();
  } catch { /* no browser opener: the link is printed */ }
}

/** `stolos console [--port n] [--no-open] [--no-github]`; with `audit`, the auditor portal's link instead (spec 083). */
export async function stolosConsole(
  o: { port?: number; open?: boolean; github?: boolean; audit?: string },
): Promise<number> {
  const c = ui.phase("Console");
  const facts = await pcFacts();
  let github: string | undefined;
  if (o.github !== false) {
    const g = await githubCheck(facts.fleet.repo);
    if (g.why || !g.push) {
      c.fail(
        g.why ?? `${g.login} may not push to ${facts.fleet.repo}`,
        "the console is for the fleet's operators: gh auth login with an account that can push, or --no-github to skip this check (offline)",
      );
      return 1;
    }
    github = g.login;
  }
  const name = (await run(["git", "-C", P.repo, "config", "user.name"])).stdout.trim() || github ||
    "you";
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "you";
  const port = o.port ?? 8091;
  const launch = new Launch();
  const { auditDeps } = await import("../audit/commands.ts");
  const audit = await auditDeps();
  if (o.audit) {
    const ac = await audit.load(o.audit);
    const { engagementState } = await import("../audit/engagement.ts");
    if (!ac || engagementState(ac.engagement) !== "open") {
      c.fail(
        !ac
          ? `no engagement ${o.audit}`
          : `engagement ${o.audit} is ${engagementState(ac.engagement)}`,
        "deno task stolos audit list",
      );
      return 1;
    }
  }
  const handler = stolosHandler({
    port,
    person: { user, name, ...(github ? { github } : {}) },
    launch,
    sessions: new Sessions(),
    facts: () => pcFacts(),
    runner: pcRunner(),
    activity: activityLog(join(P.state, "console-activity.jsonl")),
    guides: PC_GUIDES,
    guideDoc: (n) => {
      if (!PC_GUIDES.some((g) => g.name === n)) return Promise.resolve(undefined);
      const md = engineFileOr(`docs/${n}.md`);
      return Promise.resolve(
        md
          ? markdownToHtml(md, {
            served: PC_GUIDES.map((g) => g.name),
            repoBlob: "https://github.com/intellectual-frontiers/stolos/blob/main/",
          })
          : undefined,
      );
    },
    integrate: async (name, as) => {
      const { integrateLines } = await import("../adopt/integrate.ts");
      const { ensureProbeKey } = await import("../adopt/adopt.ts");
      const key = as.includes("adopt") ? await ensureProbeKey(name, P.fleetId) : undefined;
      const fleet = as.includes("server")
        ? await (await import("../model/load.ts")).loadFleet()
        : undefined;
      return await integrateLines({
        as: as as never,
        fleet: P.fleetId,
        ...(key ? { key } : {}),
        ...(fleet ? { github: fleet.admin.github.login } : {}),
        ...(as.includes("workstation") ? { repo: facts.fleet.repo } : {}),
      });
    },
    bootLog: async () => (await readTextOr(join(P.bootCache, "boot.log"))) ?? "",
    cacheDir: join(P.state, "console-cache"),
    estate: estateFor(),
    evidenceDir: join(P.state, "evidence"),
    audit,
  });
  let server: Deno.HttpServer;
  try {
    server = Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, handler);
  } catch (e) {
    c.fail(
      `port ${port} is taken (${(e as Error).message})`,
      `deno task stolos console --port ${port + 1}`,
    );
    return 1;
  }
  const url = o.audit
    ? `http://127.0.0.1:${port}/audit/launch?t=${audit.launch.issue(o.audit)}`
    : `http://127.0.0.1:${port}/launch?t=${launch.issue()}`;
  c.done(
    `${facts.fleet.title} on http://127.0.0.1:${port}${
      github ? ` (GitHub ${github} may push to ${facts.fleet.repo})` : ""
    }`,
  );
  console.log(`\n  Open (works once, for two minutes, on this PC only):\n\n    ${url}\n`);
  if (o.audit) {
    console.log(
      `  The link is for the auditor: it opens engagement ${o.audit} only, read-only, for at most four hours.`,
    );
  }
  console.log("  Passphrases and tokens a command asks for are typed here, in this terminal.");
  console.log("  Ctrl+C stops the console.\n");
  if (o.open !== false) openBrowser(url);
  await server.finished;
  return 0;
}
