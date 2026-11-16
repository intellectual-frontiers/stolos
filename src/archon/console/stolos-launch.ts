/**
 * Spec 066: `stolos console`: the Stolos Console on this PC. It checks that
 * your GitHub account (gh) may push to the fleet repository, listens on
 * 127.0.0.1, prints a one-time launch link (and opens it), and runs until
 * Ctrl+C. Commands run in the fleet repository with this terminal as their
 * input, so passphrases and tokens are typed here, never in the browser.
 *
 * @module
 */

import { fs, path, proc, type Server, serve } from "@intellectual-frontiers/commons/ts/runtime";
import { engineFileOr } from "../core/assets.ts";
import { run } from "../core/exec.ts";
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
import type { PreparedRemote } from "../access/launch.ts";

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

/**
 * Runs `bun run stolos <argv>` in the fleet repository; this terminal is its
 * input. `env` adds to its environment (spec 082: a client's scope).
 */
export function pcRunner(repo: string = P.repo, env: Record<string, string> = {}): PcRunner {
  return async (argv, each) => {
    const { engineCommand } = await import("../install/bun.ts");
    const p = proc.spawn([...engineCommand(), "stolos.ts", ...argv], {
      cwd: repo,
      env: { ...env, ARCHON_PLAIN: "1", NO_COLOR: "1", ARCHON_VIA: "console" },
      stdin: "inherit",
      stdout: "piped",
      stderr: "piped",
    });
    const pump = async (s: ReadableStream<Uint8Array> | null): Promise<void> => {
      if (!s) return;
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

/** A guide's page for the console (one of PC_GUIDES), as HTML. */
export function pcGuideDoc(n: string): Promise<string | undefined> {
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
}

/** The lines to run on a machine for an integration (spec 069), for the active fleet. */
export async function pcIntegrate(
  name: string,
  as: string[],
  repo: string,
): Promise<{ posix: string; windows?: string }> {
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
    ...(as.includes("workstation") ? { repo } : {}),
  });
}

/** Open a URL in this PC's browser (best effort: the link is printed anyway). */
export function openBrowser(url: string): void {
  const cmd =
    proc.build.os === "windows"
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : proc.build.os === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  try {
    proc.spawn(cmd, { stdin: "null", stdout: "null", stderr: "null" }).unref();
  } catch {
    /* no browser opener: the link is printed */
  }
}

/**
 * `stolos console [--port n] [--no-open] [--no-github] [--lan]`; with `audit`, the auditor portal's
 * link instead (spec 083). With `lan` (spec 100), also HTTPS on this PC's LAN address, for devices
 * a fleet signer approved.
 */
export async function stolosConsole(o: {
  port?: number;
  open?: boolean;
  github?: boolean;
  audit?: string;
  lan?: boolean;
}): Promise<number> {
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
  const name =
    (await run(["git", "-C", P.repo, "config", "user.name"])).stdout.trim() || github || "you";
  const user = proc.env.get("USER") ?? proc.env.get("USERNAME") ?? "you";
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
        "bun run stolos audit list",
      );
      return 1;
    }
  }
  // Spec 099: a passphrase a command needs is asked on the page that ran it (OpenSSH's askpass).
  const { Askpass, askpassEnv } = await import("./askpass.ts");
  const askpass = new Askpass();
  const askEnv = await askpassEnv(
    await fs.makeTempDir({ prefix: "stolos-askpass-" }),
    `http://127.0.0.1:${port}`,
    askpass,
  );
  const activity = activityLog(path.join(P.state, "console-activity.jsonl"));
  // Spec 100: remote access (names, certificate, DNS, the signed tip) before anything listens.
  let prepared: PreparedRemote | undefined;
  // fleet.ts's stolos.console.lan: true serves on the LAN without --lan (not for an audit link).
  const lanByFleet = (await (await import("../model/load.ts")).loadFleet().catch(() => undefined))
    ?.stolos?.console?.lan;
  if (o.lan || (lanByFleet === true && !o.audit)) {
    const { controllerName } = await import("../adopt/controller.ts");
    const { consoleNamesSetup } = await import("../access/commands.ts");
    const pc = await controllerName();
    const named = await consoleNamesSetup(pc);
    if ("why" in named) {
      c.fail(`remote access: ${named.why}`, "bun run stolos console (this PC only) still works");
      return 1;
    }
    const { lanAddresses } = await import("../core/net.ts");
    const { prepareRemote } = await import("../access/launch.ts");
    const p = await prepareRemote({
      phase: c,
      fleet: named.fleet,
      pc,
      addresses: lanAddresses(),
      activity,
    }).catch((e: unknown) => ({ why: (e as Error).message, fix: "run it again" }));
    if ("why" in p) {
      c.fail(`remote access: ${p.why}`, p.fix);
      return 1;
    }
    prepared = p;
  }
  const handler = stolosHandler({
    port,
    askpass,
    person: { user, name, ...(github ? { github } : {}) },
    launch,
    sessions: new Sessions(),
    facts: () => pcFacts(),
    engine: async () => {
      const { engineVersions } = await import("../fleet/releases.ts");
      return await engineVersions(path.join(P.bootCache, "..", "newest-release.json"));
    },
    runner: pcRunner(P.repo, askEnv),
    activity,
    guides: PC_GUIDES,
    guideDoc: pcGuideDoc,
    integrate: (name, as) => pcIntegrate(name, as, facts.fleet.repo),
    bootLog: async () => (await fs.readTextOr(path.join(P.bootCache, "boot.log"))) ?? "",
    cacheDir: path.join(P.state, "console-cache"),
    estate: estateFor(),
    evidenceDir: path.join(P.state, "evidence"),
    audit,
    ...(prepared ? { remote: prepared.remote } : {}),
  });
  let server: Server;
  try {
    server = await serve({ hostname: "127.0.0.1", port }, handler);
  } catch (e) {
    c.fail(
      `port ${port} is taken (${(e as Error).message})`,
      `bun run stolos console --port ${port + 1}`,
    );
    return 1;
  }
  const url = o.audit
    ? `http://127.0.0.1:${port}/audit/launch?t=${audit.launch.issue(o.audit)}`
    : `http://127.0.0.1:${port}/launch?t=${launch.issue()}`;
  if (prepared) {
    const l = await prepared.start(handler);
    if ("why" in l) {
      await server.shutdown();
      c.fail(
        `remote access: cannot listen on 443 or 8443 (${l.why})`,
        "free one of the ports (or allow Bun to bind 443), then run this again",
      );
      return 1;
    }
    ui.say(
      `Remote access: ${prepared.remote.access.names.served
        .map((n) => `https://${n}${l.port === 443 ? "" : `:${l.port}`}`)
        .join(
          ", ",
        )} (on ${l.address}, LAN or mesh only). Devices sign in with a passkey a signer approved; see /access.`,
    );
  }
  c.done(
    `${facts.fleet.title} on http://127.0.0.1:${port}${
      github ? ` (GitHub ${github} may push to ${facts.fleet.repo})` : ""
    }`,
  );
  ui.say("Open (works once, for two minutes, on this PC only):");
  ui.say(`  ${url}`);
  if (o.audit) {
    ui.say(
      `The link is for the auditor: it opens engagement ${o.audit} only, read-only, for at most four hours.`,
    );
  }
  ui.say(
    "A passphrase a command needs is asked on its page (on HTTP, with a warning); tokens are typed here, in this terminal.",
  );
  ui.say("Ctrl+C stops the console.");
  if (o.open !== false) openBrowser(url);
  await server.finished;
  await prepared?.stop();
  return 0;
}
