/**
 * Spec 066: the Stolos Console's web server, on this PC only.
 *
 * - It listens on 127.0.0.1 and answers only requests whose Host is
 *   127.0.0.1 or localhost on its port (a web page elsewhere cannot reach it
 *   through DNS rebinding).
 * - Sign-in is a one-time launch link the terminal prints (`/launch?t=...`):
 *   it works once, for two minutes, and becomes a session cookie (HttpOnly,
 *   SameSite=Strict). No password and no new key: whoever can read your
 *   terminal is you.
 * - POSTs come from this page only (Origin, and Datastar's own header).
 * - Commands run as `deno task stolos ...` in the fleet repository, one at a
 *   time, with this terminal as their input: a passphrase or token is typed
 *   there, never in the browser.
 * - Under `/v1/`, a read-only REST API for the estate (spec 094,
 *   `../api/handler.ts`): GET and HEAD only, for the same signed-in session.
 * - Under `/audit/<id>/` and `/v1/audit/<id>/`, the auditor portal (spec 083,
 *   `../audit/portal.ts`), behind its own one-time link (`/audit/launch`): an
 *   audit-scoped session sees that engagement's routes only.
 *
 * @module
 */

import type { Command } from "../core/registry-types.ts";
import type { ScfCatalog } from "../compliance/catalog.ts";
import type { Estate } from "../estate/graph.ts";
import type { AuditDeps } from "../audit/portal.ts";
import { COMMANDS, offeredOn } from "../commands/registry.ts";
import { cookieOf, IDLE_MS, type Session, type Sessions } from "./auth.ts";
import { argvFor, NOT_IN_CONSOLE, shellWords } from "./forms.ts";
import { type Html, html, raw } from "./html.ts";
import { bare, page } from "./layout.ts";
import {
  actionsView,
  activityBetween,
  activityCsv,
  type ActivityEntry,
  activityPage,
} from "./pages.ts";
import type { PcFacts } from "./pc.ts";
import { installCards, parseBootLog } from "./boot-timeline.ts";
import { htmlResponse, lineClass, patch, redirect, sameOrigin, staticFile } from "./server.ts";
import {
  addPage,
  addStep,
  answerTable,
  bootPage,
  changesPage,
  connectorsPage,
  evidence,
  launchPage,
  machinePage,
  machinesCsv,
  machinesPage,
  queryPage,
  STOLOS_GROUPS,
  STOLOS_NAV,
  stolosGroupOf,
  stolosGuidePage,
  stolosHowPage,
  stolosOverview,
  terminalNote,
  trustPage,
} from "./stolos-pages.ts";

/** The Stolos Console's cookie. */
export const STOLOS_COOKIE = "stolos_session";

/** How long a launch link works. */
export const LAUNCH_MS = 120_000;

/** Commands the PC console offers although agents may not (a person is at this PC). */
export const PERSON_ONLY: Set<string> = new Set([
  "apply",
  "fleet upgrade",
  "fleet trust",
  "decide",
  "update",
  "vault status",
  "vault list",
  "vault backup",
  "keys",
  "keys check-recovery",
  "compliance fedramp",
]);

/** Changes to who the fleet trusts, and the console itself: in the terminal only. */
export const TERMINAL_ONLY: Set<string> = new Set(["console", "signers add", "signers remove"]);

/** The commands the Stolos Console offers. Keys that change, restores, and the console itself stay in the terminal. */
export function stolosCommands(): Command[] {
  return COMMANDS.filter((c) =>
    offeredOn(c, "pc") && !NOT_IN_CONSOLE.has(c.name) && !TERMINAL_ONLY.has(c.name) &&
    (!c.noMcp || PERSON_ONLY.has(c.name))
  );
}

/** One-time launch links. */
export class Launch {
  #tokens = new Map<string, number>();
  #now: () => number;
  /** A clock (tests pass their own). */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** A new token. */
  issue(): string {
    const b = crypto.getRandomValues(new Uint8Array(32));
    const t = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    this.#tokens.set(t, this.#now());
    return t;
  }
  /** Whether a token is good: once, within LAUNCH_MS. */
  redeem(t: string | null): boolean {
    if (!t) return false;
    const at = this.#tokens.get(t);
    this.#tokens.delete(t);
    return at !== undefined && this.#now() - at <= LAUNCH_MS;
  }
}

/** A session cookie for the PC (no Secure: it is plain HTTP on the loopback, which browsers treat as secure). */
export function stolosCookie(s: Session | undefined): string {
  return s
    ? `${STOLOS_COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${IDLE_MS / 1000}`
    : `${STOLOS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Runs `deno task stolos <argv>`: each output line, then the exit code. */
export type PcRunner = (argv: string[], each: (line: string) => void) => Promise<number>;

/** What the Stolos Console needs: real on the PC, fakes in tests. */
export interface StolosDeps {
  /** The port it listens on (for the Host check). */
  port: number;
  /** The person at this PC. */
  person: { user: string; name: string; github?: string };
  /** The launch links. */
  launch: Launch;
  /** The sessions. */
  sessions: Sessions;
  /** The fleet's facts. */
  facts(): Promise<PcFacts>;
  /** Runs a stolos command. */
  runner: PcRunner;
  /** The activity record. */
  activity: { add(e: ActivityEntry): Promise<void>; recent(n: number): Promise<ActivityEntry[]> };
  /** The guides offered (docs/<name>.md). */
  guides: Array<{ name: string; title: string; why: string }>;
  /** A guide's page. */
  guideDoc(name: string): Promise<string | undefined>;
  /** The lines to run on a machine for an integration (and its probe key, made now), spec 069. */
  integrate(name: string, as: string[]): Promise<{ posix: string; windows?: string }>;
  /** The boot server's log (boot.log), or "" when it has none. */
  bootLog(): Promise<string>;
  /** Where Mermaid and the fonts are cached. */
  cacheDir: string;
  /** The estate graph with its findings, for the REST API (spec 094). */
  estate(): Promise<Estate>;
  /** The directory with this PC's evidence bundles (spec 072), for the REST API. */
  evidenceDir: string;
  /** The SCF catalog, when it is on this PC (default: the cached one). */
  catalog?(): Promise<ScfCatalog | undefined>;
  /** Spec 083: the auditor portal's engagements and links (none: no portal). */
  audit?: AuditDeps;
  /** Spec 082: the provider's client these pages are for (shown in the top bar, with the way back). */
  scope?: { label: string; href: string };
}

/** The fleet's OSCAL documents (spec 071), by file name; none without the SCF catalog. */
async function pcOscal(
  f: PcFacts,
  catalog: ScfCatalog | undefined,
): Promise<Record<string, unknown>> {
  if (!catalog) return {};
  const { loadNist } = await import("../compliance/catalog.ts");
  const { fleetFreshView, loadCadences } = await import("../compliance/freshness.ts");
  const { oscalExports } = await import("../compliance/oscal.ts");
  const { VERSION } = await import("../version.ts");
  const nist = await loadNist("nist80053");
  return await oscalExports({
    view: fleetFreshView(f, catalog, { cadences: await loadCadences() }),
    fleet: f.fleet,
    machines: f.machines.filter((m) => m.kind !== "discovered"),
    ...(nist ? { titles: nist.titles } : {}),
    version: VERSION,
    now: new Date(),
  });
}

/** boot.log, followed: the cards and new lines as they come (Datastar patches), until the page goes. */
function bootStream(deps: StolosDeps, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      let seen = (await deps.bootLog()).length;
      for (let i = 0; i < 3600 && !signal.aborted; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const log = await deps.bootLog();
        if (log.length === seen) continue;
        const fresh = log.length > seen ? log.slice(seen) : log;
        seen = log.length;
        try {
          ctl.enqueue(enc.encode(patch(installCards(parseBootLog(log)))));
          for (const l of fresh.split("\n").filter(Boolean)) {
            ctl.enqueue(
              enc.encode(
                patch(html`<div class="${lineClass(l)}">${l}</div>`, {
                  selector: "#bootlog",
                  mode: "append",
                }),
              ),
            );
          }
        } catch {
          break; // the page went away
        }
      }
      try {
        ctl.close();
      } catch { /* already closed */ }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** The Stolos Console's request handler. */
export function stolosHandler(
  deps: StolosDeps,
): (req: Request, info?: Deno.ServeHandlerInfo) => Promise<Response> {
  const offered = stolosCommands();
  const byName = new Map(offered.map((c) => [c.name, c]));
  const hosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  let busy = false;
  const catalog = async () =>
    deps.catalog
      ? await deps.catalog()
      : await (await import("../compliance/catalog.ts")).loadScf();
  const api = async (req: Request) => {
    const f = await deps.facts();
    const { apiHandler } = await import("../api/handler.ts");
    return await apiHandler(req, {
      fleet: f.fleet.id,
      port: deps.port,
      estate: deps.estate,
      oscal: async () => await pcOscal(f, await catalog()),
      catalog,
      evidenceDir: deps.evidenceDir,
    });
  };

  const frame = async (s: Session, title: string, current: string, body: Html, f?: PcFacts) => {
    const facts = f ?? (await deps.facts());
    return htmlResponse(page({
      product: "stolos",
      title,
      subtitle: `this PC · ${deps.person.user}`,
      fleet: { id: facts.fleet.title, repo: facts.fleet.repo },
      user: {
        name: s.name,
        user: deps.person.github ? `${s.user} · GitHub ${deps.person.github}` : s.user,
        role: "fleet operator",
      },
      // Spec 082: a provider's client's pages lead back to the list of clients (also on a phone).
      nav: deps.scope
        ? [...STOLOS_NAV, { group: "Provider", label: "All clients", href: deps.scope.href }]
        : STOLOS_NAV,
      current,
      ...(deps.scope ? { scope: deps.scope } : {}),
    }, body));
  };

  const run = async (req: Request, s: Session): Promise<Response> => {
    const form = Object.fromEntries(
      [...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]),
    );
    // A pasted check-in code may wrap: it has no spaces of its own.
    for (const k of ["check-in", "import"]) if (form[k]) form[k] = form[k].replace(/\s+/g, "");
    const cmd = byName.get(form.command ?? "");
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const send = (x: string) => ctl.enqueue(enc.encode(x));
        const state = (t: string) => send(patch(html`<span class="sub" id="runstate">${t}</span>`));
        const out = (l: string, cls = lineClass(l)) =>
          send(
            patch(html`<div class="${cls}">${l || " "}</div>`, {
              selector: "#output",
              mode: "append",
            }),
          );
        const refuse = (why: string) => {
          send(patch(html`
            <div class="term" id="output">
              <div class="bad">${why}</div>
            </div>
          `));
          state("Not run");
          ctl.close();
        };
        if (!cmd) return refuse("That command is not offered here (run it in the terminal).");
        const r = argvFor(cmd, form);
        if ("error" in r) return refuse(r.error);
        if (busy) {
          return refuse("Another command is running: it may be waiting for you in the terminal.");
        }
        busy = true;
        const shown = `deno task stolos ${shellWords(r.argv)}`;
        send(patch(html`
          <div class="term" id="output">
            <div class="dim">$ ${shown}</div>
          </div>
        `));
        state("Running ... (if it asks for a passphrase, type it in the terminal)");
        let code = 1;
        try {
          code = await deps.runner(r.argv, (l) => out(l));
        } catch (e) {
          out((e as Error).message, "bad");
        } finally {
          busy = false;
        }
        state(code === 0 ? "Done" : `Failed (exit ${code})`);
        await deps.activity.add({
          at: new Date().toISOString(),
          user: s.user,
          from: "this PC",
          kind: "run",
          detail: shown,
          code,
        });
        ctl.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  };

  const query = async (req: Request, s: Session): Promise<Response> => {
    const sql = String((await req.formData()).get("sql") ?? "").trim();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const send = (x: string) => ctl.enqueue(enc.encode(x));
        const state = (t: string) => send(patch(html`<span class="sub" id="runstate">${t}</span>`));
        if (/[\0\r\n]/.test(sql) || sql.startsWith("-") || !sql) {
          state("Not asked: one line, one SELECT");
          return ctl.close();
        }
        if (busy) {
          state("Another command is running");
          return ctl.close();
        }
        busy = true;
        state("Asking every machine ...");
        const lines: string[] = [];
        let code = 1;
        try {
          code = await deps.runner(["fleet", "query", sql, "--json"], (l) => lines.push(l));
        } finally {
          busy = false;
        }
        const text = lines.join("\n");
        const start = text.indexOf("[");
        try {
          const answers = JSON.parse(text.slice(start, text.lastIndexOf("]") + 1));
          send(patch(answerTable(answers)));
          state(code === 0 ? "Answered" : "Answered, with machines that did not answer");
        } catch {
          send(patch(html`
            <div class="card" id="answer">
              <div class="term">${lines.map((l) =>
                html`<div class="${lineClass(l)}">${l}</div>`
              )}</div>
            </div>
          `));
          state("Refused or failed");
        }
        await deps.activity.add({
          at: new Date().toISOString(),
          user: s.user,
          from: "this PC",
          kind: "run",
          detail: `fleet query ${sql}`,
          code,
        });
        ctl.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  };

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!hosts.has(req.headers.get("host") ?? "")) {
      return new Response("This console answers only on 127.0.0.1 and localhost.\n", {
        status: 421,
      });
    }
    try {
      const st = await staticFile(path, deps.cacheDir);
      if (st) return st;
      if (path === "/launch") {
        if (!deps.launch.redeem(url.searchParams.get("t"))) {
          return htmlResponse(bare("Stolos Console", launchPage()), 401);
        }
        const s = deps.sessions.create({
          user: deps.person.user,
          name: deps.person.name,
          groups: ["archon-ops"],
        }, "this PC");
        await deps.activity.add({
          at: new Date().toISOString(),
          user: s.user,
          from: "this PC",
          kind: "sign-in",
          detail: "launch link",
        });
        return redirect("/", { "set-cookie": stolosCookie(s) });
      }
      // Spec 083: an audit link becomes a session that sees one engagement's routes only.
      if (path === "/audit/launch" && deps.audit) {
        const { auditAccount } = await import("../audit/portal.ts");
        const id = deps.audit.launch.redeem(url.searchParams.get("t"));
        if (!id) return htmlResponse(bare("Audit portal", launchPage()), 401);
        const a = deps.sessions.create(auditAccount(id), "audit link");
        await deps.activity.add({
          at: new Date().toISOString(),
          user: a.user,
          from: "audit link",
          kind: "sign-in",
          detail: `audit portal: ${id}`,
        });
        return redirect(`/audit/${id}/`, { "set-cookie": stolosCookie(a) });
      }
      const s = deps.sessions.get(cookieOf(req.headers.get("cookie"), STOLOS_COOKIE));
      if (s) {
        const { auditScope, isAuditPath, serveAudit } = await import("../audit/portal.ts");
        if (auditScope(s) !== undefined) {
          if (path === "/signout" && (req.method !== "POST" || sameOrigin(req))) {
            deps.sessions.end(s.id);
            return htmlResponse(bare("Signed out", launchPage()), 200, {
              "set-cookie": stolosCookie(undefined),
            });
          }
          return await serveAudit(req, s, deps.audit);
        }
        if (isAuditPath(path)) return await serveAudit(req, s, deps.audit);
      }
      // Spec 094: the read-only REST API, for this session (and local tools with its cookie).
      if (path === "/v1" || path.startsWith("/v1/")) {
        return s ? await api(req) : (await import("../api/handler.ts")).apiUnauthorized();
      }
      if (!s) return htmlResponse(bare("Stolos Console", launchPage()), 401);
      if (req.method === "POST") {
        if (!sameOrigin(req)) return new Response("cross-site request refused\n", { status: 403 });
        if (path === "/signout") {
          deps.sessions.end(s.id);
          return redirect("/launch", { "set-cookie": stolosCookie(undefined) });
        }
        if (!req.headers.get("datastar-request")) return new Response("refused\n", { status: 403 });
        if (path === "/actions/run") return await run(req, s);
        if (path === "/query/run") return await query(req, s);
        return new Response("not found\n", { status: 404 });
      }
      if (path === "/signout") {
        deps.sessions.end(s.id);
        return htmlResponse(bare("Signed out", launchPage()), 200, {
          "set-cookie": stolosCookie(undefined),
        });
      }
      if (path === "/boot/stream") return bootStream(deps, req.signal);
      const f = await deps.facts();
      if (path === "/") return await frame(s, "Overview", "/", stolosOverview(f), f);
      if (path === "/machines") return await frame(s, "Machines", "/machines", machinesPage(f), f);
      if (path.startsWith("/machines/")) {
        let name = "";
        try {
          name = decodeURIComponent(path.slice(10));
        } catch {
          return new Response("no such machine\n", { status: 404 });
        }
        const body = machinePage(f, name);
        return body
          ? await frame(s, decodeURIComponent(path.slice(10)), "/machines", body, f)
          : new Response("no such machine\n", { status: 404 });
      }
      if (path === "/export/machines.csv") {
        return new Response(machinesCsv(f), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${f.fleet.id}-machines.csv"`,
            "cache-control": "no-store",
          },
        });
      }
      if (path === "/export/evidence.json") {
        return new Response(JSON.stringify(evidence(f), null, 2) + "\n", {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${f.fleet.id}-evidence.json"`,
            "cache-control": "no-store",
          },
        });
      }
      if (path === "/boot") {
        const log = await deps.bootLog();
        return await frame(
          s,
          "Installs",
          "/boot",
          bootPage(
            installCards(parseBootLog(log)),
            log.trim().split("\n").filter(Boolean).slice(-80),
          ),
          f,
        );
      }
      if (path.startsWith("/export/oscal/")) {
        const name = path.slice("/export/oscal/".length);
        const docs = await pcOscal(f, await catalog());
        if (!(name in docs)) return new Response("not found\n", { status: 404 });
        return new Response(JSON.stringify(docs[name], null, 2) + "\n", {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${f.fleet.id}-${name}"`,
            "cache-control": "no-store",
          },
        });
      }
      if (path === "/compliance" || path === "/export/compliance.json") {
        const { loadScf } = await import("../compliance/catalog.ts");
        // Spec 073: with each control's evidence age; stale evidence fails (MON-02).
        const { fleetFreshView, loadCadences } = await import("../compliance/freshness.ts");
        const view = fleetFreshView(f, await loadScf(), { cadences: await loadCadences() });
        if (path.startsWith("/export/")) {
          return new Response(JSON.stringify(view, null, 2) + "\n", {
            headers: {
              "content-type": "application/json",
              "content-disposition": `attachment; filename="${f.fleet.id}-compliance.json"`,
              "cache-control": "no-store",
            },
          });
        }
        const { compliancePage } = await import("./compliance-page.ts");
        return await frame(
          s,
          "Compliance",
          "/compliance",
          compliancePage(
            view,
            url.searchParams.get("fw") ?? undefined,
            f.fleet.title,
            "/export/compliance.json",
          ),
          f,
        );
      }
      if (path === "/add") {
        const what = url.searchParams.get("what");
        const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
        if (!what) return await frame(s, "Add a machine", "/add", addPage(name), f);
        const needsName = ["adopt", "discover", "server", "workstation"].includes(what);
        let lines;
        if (needsName && /^[a-z][a-z0-9-]{0,62}$/.test(name)) {
          const as = what === "adopt" && url.searchParams.get("osquery")
            ? ["adopt", "osquery"]
            : [what];
          lines = await deps.integrate(name, as);
        }
        const { allConnectors } = await import("../connect/commands.ts");
        const CONNECTORS = await allConnectors();
        const { SNMP_HELP } = await import("../device/commands.ts");
        return await frame(
          s,
          "Add a machine",
          "/add",
          addStep({
            what,
            name,
            ...(lines ? { lines } : {}),
            clouds: f.clouds,
            recipes: Object.fromEntries(CONNECTORS.map((c) => [c.id, c.recipe])),
            snmpHelp: SNMP_HELP,
          }),
          f,
        );
      }
      if (path === "/clouds") {
        return await frame(s, "Connected accounts", "/clouds", connectorsPage(f), f);
      }
      if (path === "/query") {
        return await frame(
          s,
          "Ask every machine",
          "/query",
          queryPage(url.searchParams.get("sql") ?? "select name, version from os_version"),
          f,
        );
      }
      if (path === "/changes") return await frame(s, "Changes", "/changes", changesPage(f), f);
      if (path === "/trust") return await frame(s, "Trust", "/trust", trustPage(f), f);
      if (path === "/how") return await frame(s, "How it works", "/how", stolosHowPage(f), f);
      if (path === "/activity" || path === "/export/activity.csv") {
        const from = url.searchParams.get("from") ?? undefined,
          to = url.searchParams.get("to") ?? undefined;
        const all = activityBetween(await deps.activity.recent(100_000), from, to);
        if (path.startsWith("/export/")) {
          return new Response(activityCsv(all), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="stolos-activity.csv"',
              "cache-control": "no-store",
            },
          });
        }
        return await frame(
          s,
          "Activity",
          "/activity",
          activityPage(all.slice(0, 500), "this PC", { from, to }),
          f,
        );
      }
      if (path === "/actions") return redirect("/actions/fleet");
      if (path.startsWith("/actions/")) {
        const g = STOLOS_GROUPS.find((x) => x.id === path.slice(9));
        if (!g) return new Response("not found\n", { status: 404 });
        const want = url.searchParams.get("cmd") ?? g.first;
        const selected = byName.get(want) ?? byName.get(g.first) ??
          offered.find((c) => stolosGroupOf(c.name).id === g.id);
        if (!selected) return new Response("nothing offered here\n", { status: 404 });
        const values = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "cmd"));
        const body = actionsView({
          group: g,
          groupOf: stolosGroupOf,
          cmds: offered,
          selected,
          role: "operator",
          diagram: g.diagram(f),
          note: terminalNote(),
          form: {
            may: () => true,
            password: false,
            footnote: "Runs here, as you, in the fleet repository; recorded in Activity.",
          },
          values,
        });
        return await frame(s, g.label, `/actions/${g.id}`, body, f);
      }
      if (path === "/guide") {
        return await frame(s, "Guide", "/guide", stolosGuidePage(deps.guides), f);
      }
      const gm = path.match(/^\/guide\/([a-z0-9-]+)$/);
      if (gm) {
        const doc = await deps.guideDoc(gm[1]);
        if (!doc) return new Response("no such guide\n", { status: 404 });
        return await frame(
          s,
          "Guide",
          "/guide",
          html`<article class="card prose">${raw(doc)}</article>`,
          f,
        );
      }
      return new Response("not found\n", { status: 404 });
    } catch (e) {
      console.error(`console: ${path}: ${(e as Error).stack ?? e}`);
      return htmlResponse(
        bare(
          "Error",
          html`
            <div class="card" style="max-width:640px;margin:10vh auto">
              <h1>Something went wrong</h1>
              <p class="mono">${(e as Error).message}</p>
              <p class="sub">The terminal where the console runs has the details.</p>
            </div>
          `,
        ),
        500,
      );
    }
  };
}
