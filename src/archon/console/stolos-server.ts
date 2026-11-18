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
 * - Commands run as `bun run stolos ...` in the fleet repository, one at a
 *   time, with this terminal as their input: a passphrase or token is typed
 *   there, never in the browser.
 * - Under `/v1/`, a read-only REST API for the estate (spec 094,
 *   `../api/handler.ts`): GET and HEAD only, for the same signed-in session.
 * - Under `/audit/<id>/` and `/v1/audit/<id>/`, the auditor portal (spec 083,
 *   `../audit/portal.ts`), behind its own one-time link (`/audit/launch`): an
 *   audit-scoped session sees that engagement's routes only.
 * - Spec 100: with `stolos console --lan`, the same pages over HTTPS on the LAN
 *   (`stolos.<domain>`, `<pc>.stolos.<domain>`): a device signs in with a passkey a fleet
 *   signer approved in a signed commit (`../access/`), never with the launch link. A signer
 *   whose key is not on this PC looks only: a command that changes the repository is refused
 *   with the line to run on their own PC. The Remote Access page is `/access`.
 *
 * @module
 */
// Spec: 066-stolos-console
// Spec: 099-engine-update FR-002, FR-005
// Spec: 100-remote-access FR-003, FR-007, FR-009
// Spec: 103-three-ports FR-003, FR-004, FR-005
// Spec: 107-pairing-and-query FR-008, FR-011, FR-012
// Spec: 108-tags FR-013, FR-014
// Spec: 110-network-assets FR-008

import type { EngineVersions } from "../fleet/releases.ts";
import { type Askpass, type Question, sameToken } from "./askpass.ts";
import type { ServeInfo } from "@intellectual-frontiers/commons/ts/runtime";
import type { Command } from "../core/registry-types.ts";
import type { ScfCatalog } from "../compliance/catalog.ts";
import type { Estate } from "../estate/graph.ts";
import type { AuditDeps } from "../audit/portal.ts";
import type { SignerDef } from "../model/types.ts";
import type { RemoteAccess } from "../access/service.ts";
import { COMMANDS, offeredOn } from "../commands/registry.ts";
import { cookieOf, IDLE_MS, type Session, type Sessions } from "./auth.ts";
import { argvFor, NOT_IN_CONSOLE, shellWords } from "./forms.ts";
import { formText, type Html, html, raw } from "./html.ts";
import { ui } from "../core/ui.ts";
import { DEVICE_PAIR_PATH } from "../ontology.auto.ts";
import { bare, page } from "./layout.ts";
import { networkDevicePage, networkPage, withNetworkNav } from "./network-page.ts";
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
import { tableItem } from "./table.ts";
import { CONTROLLER_NOTE } from "../adopt/joining.ts";
import type { AskOptions, QueryAnswer } from "../adopt/query.ts";
import {
  addPage,
  addStep,
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
  "devices approve",
  "devices revoke",
]);

/** Changes to who the fleet trusts, and the console itself: in the terminal only. */
export const TERMINAL_ONLY: Set<string> = new Set(["console", "signers add", "signers remove"]);

/** The commands the Stolos Console offers. Keys that change, restores, and the console itself stay in the terminal. */
export function stolosCommands(): Command[] {
  return COMMANDS.filter(
    (c) =>
      offeredOn(c, "pc") &&
      !NOT_IN_CONSOLE.has(c.name) &&
      !TERMINAL_ONLY.has(c.name) &&
      (!c.noMcp || PERSON_ONLY.has(c.name)),
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

/**
 * A session cookie for the PC: no Secure on plain HTTP on the loopback (which browsers treat as
 * secure); Secure over HTTPS (spec 100 FR-007).
 */
export function stolosCookie(s: Session | undefined, secure = false): string {
  const flags = `Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict`;
  return s
    ? `${STOLOS_COOKIE}=${s.id}; ${flags}; Max-Age=${IDLE_MS / 1000}`
    : `${STOLOS_COOKIE}=; ${flags}; Max-Age=0`;
}

/** Spec 100: what the console needs for remote access (absent: 127.0.0.1 only). */
export interface ConsoleRemote {
  /** Remote access: devices, codes, sessions, the signed tip. */
  access: RemoteAccess;
  /** The Host values the HTTPS listener answers (its names, with the port unless 443); filled once it listens. */
  hosts: string[];
  /** The fleet's signers (signers.ts). */
  signers(): Promise<SignerDef[]>;
  /** The listener, certificate and another controller's heartbeat, as they are now. */
  view(): {
    listener?: { address: string; port: number };
    tls?: { names: string[]; notAfter: string; directory: string };
    other?: { pc: string; at: string };
  };
  /** This controller's HTTPS address, for `devices approve --controller`. */
  controller: string;
}

/** Spec 100 FR-009: the refusal a signer whose key is not on this PC gets for a signing command. */
export function signedElsewhere(owner: string, argv: readonly string[]): string {
  return `This would be signed by ${owner}'s key: run it from your PC: bun run stolos ${shellWords([...argv])}`;
}

/** Runs `bun run stolos <argv>`: each output line, then the exit code. */
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
  /** Spec 099: the engine running here and a newer release, if any (absent: not shown). */
  engine?(): Promise<EngineVersions>;
  /** Runs a stolos command. */
  runner: PcRunner;
  /**
   * Spec 107-pairing-and-query FR-010: asks every machine one SQL question, at once, handing each answer on as it arrives (default:
   * the real one, `askFleet`, in this process).
   */
  ask?: (sql: string, o: AskOptions) => Promise<QueryAnswer[]>;
  /**
   * Spec 099: passphrases asked in the browser (OpenSSH's askpass helper asks the console); the
   * runner's commands use it. Absent: a passphrase is typed in the terminal.
   */
  askpass?: Askpass;
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
  /** Spec 100: remote access over HTTPS on the LAN (absent: this PC only). */
  remote?: ConsoleRemote;
  /**
   * Spec 103: pairing's routes (`/device/pair`), answered on the HTTPS names only, before any session or passkey, never on 127.0.0.1
   * (the handler answers `undefined` for a path that is not pairing's; with no pairing waiting it answers 404).
   */
  devicePair?: (req: Request, from?: string) => Promise<Response | undefined>;
}

/**
 * Spec 099: the passphrase field for a waiting question, on the page that started the run. On
 * plain HTTP, the warning first, with the same command for the terminal.
 */
export function askpassForm(q: Question, shown: string, http: boolean): Html {
  return html`<form
    id="askpass"
    class="card stack"
    style="margin-top:10px"
    data-on:submit="@post('/askpass/answer', {contentType: 'form'})"
  >
    ${
      http
        ? html`<p class="notice warn" role="alert">
            ⚠️ Warning, you're about to type in your passphrase on an unencrypted channel (this page
            is HTTP). Only do this on a trusted network, or do this at the command line:
            <code>${shown}</code>
          </p>`
        : ""
    }
    <input type="hidden" name="id" value="${q.id}" />
    <label class="field"
      ><span>${q.prompt}</span
      ><input type="password" name="passphrase" autocomplete="off" autofocus required
    /></label>
    <div class="row">
      <button class="btn" type="submit">Sign</button>
      <button
        class="btn ghost"
        type="button"
        data-on:click="@post('/askpass/answer?cancel=1', {contentType: 'form'})"
      >
        Cancel
      </button>
    </div>
    <p class="sub">
      It goes to OpenSSH on this PC for this signature only; Stolos does not keep it.
    </p>
  </form>`;
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
  const docs = await oscalExports({
    view: fleetFreshView(f, catalog, { cadences: await loadCadences() }),
    fleet: f.fleet,
    machines: f.machines.filter((m) => m.kind !== "discovered"),
    ...(nist ? { titles: nist.titles } : {}),
    version: VERSION,
    now: new Date(),
  });
  return { ...docs };
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
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** The Stolos Console's request handler. */
export function stolosHandler(
  deps: StolosDeps,
): (req: Request, info?: ServeInfo) => Promise<Response> {
  const offered = stolosCommands();
  const byName = new Map(offered.map((c) => [c.name, c]));
  const local = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  let busy = false;
  // Spec 100: who a session is: this PC's owner (the launch link) or a signer on a device.
  const remoteOf = (s: Session) => deps.remote?.access.session(s.id);
  const mayChange = (s: Session) => {
    const r = remoteOf(s);
    return !r || deps.remote?.access.maySign(r.signer) === true;
  };
  const owner = () => deps.remote?.access.localSigners()[0] ?? deps.person.name;
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
      estate: () => deps.estate(),
      oscal: async () => await pcOscal(f, await catalog()),
      catalog,
      evidenceDir: deps.evidenceDir,
    });
  };

  const frame = async (s: Session, title: string, current: string, body: Html, f?: PcFacts) => {
    const facts = f ?? (await deps.facts());
    return htmlResponse(
      page(
        {
          product: "stolos",
          title,
          subtitle: `this PC · ${deps.person.user}`,
          ...(deps.engine
            ? {
                engine: {
                  ...(await deps.engine().catch(() => ({ running: "" }))),
                  href: "/actions/fleet?cmd=update",
                },
              }
            : {}),
          fleet: { id: facts.fleet.title, repo: facts.fleet.repo },
          user: remoteOf(s)
            ? {
                name: s.name,
                user: `${s.user} · ${remoteOf(s)?.device.name ?? ""}`,
                role: mayChange(s) ? "fleet operator" : "looks only",
              }
            : {
                name: s.name,
                user: deps.person.github ? `${s.user} · GitHub ${deps.person.github}` : s.user,
                role: "fleet operator",
              },
          // Spec 082: a provider's client's pages lead back to the list of clients (also on a phone).
          nav: deps.scope
            ? [
                ...withNetworkNav(STOLOS_NAV, facts),
                { group: "Provider", label: "All clients", href: deps.scope.href },
              ]
            : withNetworkNav(STOLOS_NAV, facts),
          current,
          ...(deps.scope ? { scope: deps.scope } : {}),
        },
        body,
      ),
    );
  };

  const run = async (req: Request, s: Session): Promise<Response> => {
    const form = Object.fromEntries(
      [...(await req.formData()).entries()].map(([k, v]) => [k, formText(v)]),
    );
    // A pasted check-in code may wrap: it has no spaces of its own.
    for (const k of ["check-in", "import"]) {
      const v = form[k];
      if (v) form[k] = v.replace(/\s+/g, "");
    }
    const cmd = byName.get(form["command"] ?? "");
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
          send(
            patch(html`
              <div class="term" id="output">
                <div class="bad">${why}</div>
              </div>
            `),
          );
          state("Not run");
          ctl.close();
        };
        if (!cmd) return refuse("That command is not offered here (run it in the terminal).");
        const r = argvFor(cmd, form);
        if ("error" in r) return refuse(r.error);
        // Spec 107 FR-008: the controller is auto-adopted; the console does not release or remove it.
        if (r.argv[0] === "host" && r.argv[1] === "release") {
          const target = r.argv[2];
          if ((await deps.facts()).machines.some((m) => m.controller && m.name === target)) {
            return refuse(CONTROLLER_NOTE);
          }
        }
        // Spec 100 FR-009: a signer whose key is not on this PC looks only.
        if (r.tier !== "read" && !mayChange(s)) {
          const why = signedElsewhere(owner(), r.argv);
          await deps.activity.add({
            at: new Date().toISOString(),
            user: s.user,
            from: s.from,
            kind: "refused",
            detail: `${cmd.name}: not signed here`,
          });
          return refuse(why);
        }
        if (busy) {
          return refuse("Another command is running: it may be waiting for you in the terminal.");
        }
        busy = true;
        const shown = `bun run stolos ${shellWords(r.argv)}`;
        send(
          patch(html`
            <div class="term" id="output">
              <div class="dim">$ ${shown}</div>
            </div>
          `),
        );
        state(
          deps.askpass
            ? "Running ... (if it needs your passphrase, this page asks for it)"
            : "Running ... (if it asks for a passphrase, type it in the terminal)",
        );
        let asked = false;
        if (deps.askpass) {
          const http = new URL(req.url).protocol === "http:";
          deps.askpass.onAsk = (q) => {
            // A second question replaces the first form (a wrong passphrase is asked again).
            send(
              asked
                ? patch(askpassForm(q, shown, http))
                : patch(askpassForm(q, shown, http), { selector: "#output", mode: "after" }),
            );
            asked = true;
          };
        }
        let code = 1;
        try {
          code = await deps.runner(r.argv, (l) => out(l));
        } catch (e) {
          out((e as Error).message, "bad");
        } finally {
          busy = false;
          if (deps.askpass) {
            deps.askpass.onAsk = undefined;
            deps.askpass.cancelAll();
          }
          if (asked) send(patch("", { selector: "#askpass", mode: "remove" }));
        }
        state(code === 0 ? "Done" : `Failed (exit ${code})`);
        await deps.activity.add({
          at: new Date().toISOString(),
          user: s.user,
          from: s.from,
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
    const form = await req.formData();
    const sql = formText(form.get("sql")).trim();
    // Spec 108-tags FR-013: the machines to ask, chosen by tags with the same parser the command line uses.
    const pick = formText(form.get("select")).trim();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const send = (x: string) => ctl.enqueue(enc.encode(x));
        const state = (t: string) => send(patch(html`<span class="sub" id="runstate">${t}</span>`));
        const summary = (t: string) =>
          send(patch(html`<p class="sub" id="summary" role="status">${t}</p>`));
        const refuse = (why: string) => {
          send(
            patch(html`
              <div class="card" id="answer" style="margin-top:14px">
                <div class="term"><div class="bad">refused: ${why}</div></div>
              </div>
            `),
          );
          state("Refused or failed");
          ctl.close();
        };
        if (/[\0\r\n]/.test(sql) || sql.startsWith("-") || !sql) {
          state("Not asked: one line, one SELECT");
          return ctl.close();
        }
        const { answeredLine, queryRefusal, tableRows } = await import("../adopt/query.ts");
        const why = queryRefusal(sql);
        if (why) return refuse(why);
        const chosen = pick ? await (await import("../fleet/tags.ts")).readSelectionFor(pick) : {};
        if (chosen.error) return refuse(chosen.error);
        const ask = deps.ask ?? (await import("../adopt/commands.ts")).askFleet;
        // The grid fills in as the machines answer (spec 107-pairing-and-query FR-011): a row for each machine at once, asking.
        const feed = (change: Parameters<typeof tableItem>[0]) =>
          send(patch(tableItem(change), { selector: "#answers-feed", mode: "append" }));
        send(patch(html`<div id="answer" style="margin-top:14px"></div>`));
        feed({ op: "reset" });
        state("Asking every machine ...");
        const got: Array<Awaited<ReturnType<typeof ask>>[number]> = [];
        let total = 0;
        const answers = await ask(sql, {
          ...(chosen.selection ? { selection: chosen.selection } : {}),
          onStart: (ms) => {
            // Spec 110-network-assets FR-011: a network asset is not asked (it has no osquery): it is in no count.
            total = ms.filter((m) => m.kind !== "network").length;
            feed({
              op: "add",
              rows: ms.map((m) => ({
                __id: `ask:${m.machine}`,
                machine: m.machine,
                answer: "asking",
                reason: "",
              })),
              remove: [],
            });
            summary(`0 of ${total} answered`);
            if (!total) {
              state(pick ? `No machine has the tags ${pick}` : "There is no machine to ask yet");
            }
          },
          onAnswer: (a) => {
            got.push(a);
            feed({
              op: "add",
              rows: tableRows([a]).map((r, i) => ({ ...r, __id: `${a.machine}#${i}` })),
              remove: [`ask:${a.machine}`],
            });
            summary(
              `${answeredLine(got, total)}${got.length < total ? `, ${total - got.length} still asking` : ""}`,
            );
            state(`Asking every machine ... (${got.length} of ${total} came back)`);
          },
        });
        const failed = answers.filter(
          (a) => a.state !== "answered" && a.state !== "skipped",
        ).length;
        summary(
          `${answeredLine(answers)}${failed ? `: ${failed} failed or did not answer in time, each with its reason in its row` : ""}`,
        );
        state(failed ? "Answered, with machines that did not answer" : "Answered");
        await deps.activity.add({
          at: new Date().toISOString(),
          user: s.user,
          from: s.from,
          kind: "run",
          detail: `fleet query ${sql}`,
          code: failed ? 1 : 0,
        });
        ctl.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  };

  return async (req, info) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const host = req.headers.get("host") ?? "";
    if (!local.has(host) && !deps.remote?.hosts.includes(host)) {
      return new Response(
        deps.remote
          ? `This console answers only on 127.0.0.1, localhost and ${deps.remote.access.names.served.join(", ")}.\n`
          : "This console answers only on 127.0.0.1 and localhost.\n",
        { status: 421 },
      );
    }
    // Spec 100: on an HTTPS name, a device; on 127.0.0.1, this PC.
    const lan = !local.has(host);
    const from = lan ? (info?.remoteAddr.hostname ?? "?") : "this PC";
    const secure = url.protocol === "https:";
    // Spec 103: pairing is a route of the console's TLS door, for its LAN names (the Host check above held), with no session.
    if (path === DEVICE_PAIR_PATH || path.startsWith(`${DEVICE_PAIR_PATH}/`)) {
      const answer =
        lan && deps.devicePair ? await deps.devicePair(req, info?.remoteAddr.hostname) : undefined;
      return answer ?? new Response("not found\n", { status: 404 });
    }
    if (lan && (path === "/launch" || path === "/audit/launch" || path === "/askpass")) {
      return new Response("not here: this PC's own links work on 127.0.0.1 only\n", {
        status: 404,
      });
    }
    // Spec 099: OpenSSH's askpass helper asks for a passphrase (its token, not a session).
    if (path === "/askpass" && req.method === "POST" && deps.askpass) {
      if (!sameToken(req.headers.get("x-stolos-askpass") ?? "", deps.askpass.token)) {
        return new Response("refused\n", { status: 403 });
      }
      const answer = await deps.askpass.ask((await req.text()).slice(0, 500));
      return answer === undefined
        ? new Response("not answered\n", { status: 403 })
        : new Response(answer, { headers: { "cache-control": "no-store" } });
    }
    try {
      const st = await staticFile(path, deps.cacheDir);
      if (st) return st;
      if (path === "/launch") {
        if (!deps.launch.redeem(url.searchParams.get("t"))) {
          return htmlResponse(bare("Stolos Console", launchPage()), 401);
        }
        const s = deps.sessions.create(
          {
            user: deps.person.user,
            name: deps.person.name,
            groups: ["archon-ops"],
          },
          "this PC",
        );
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
      // Spec 100: pending codes, the waiting page's status, registration and sign-in (no session).
      // A passkey is made and used on the HTTPS names only (its origin); on 127.0.0.1, a signer's
      // devices approve reads a code's public fields.
      if (
        deps.remote &&
        path.startsWith("/access/") &&
        path !== "/access/deny" &&
        (lan || req.method === "GET")
      ) {
        const { accessRoute } = await import("../access/routes.ts");
        const remote = deps.remote;
        const r = await accessRoute(req, from, {
          access: remote.access,
          signers: () => remote.signers(),
          startSession: (device, at) => {
            const n = deps.sessions.create(
              { user: device.signer, name: `${device.signer} (${device.name})`, groups: [] },
              at,
            );
            remote.access.bind(n.id, device, at);
            return stolosCookie(n, secure);
          },
        });
        if (r) return r;
      }
      let s = deps.sessions.get(cookieOf(req.headers.get("cookie"), STOLOS_COOKIE));
      // A revoked device's session ends once the signed revoke is read; a launch-link session
      // never reaches the LAN names, nor a device's the loopback.
      if (s && deps.remote && (!deps.remote.access.live(s.id) || !!remoteOf(s) !== lan)) {
        if (!deps.remote.access.live(s.id)) {
          deps.sessions.end(s.id);
          deps.remote.access.endSession(s.id);
        }
        s = undefined;
      }
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
      if (!s && lan && deps.remote) {
        const { deviceWelcome } = await import("../access/pages.ts");
        const { defaultDeviceName } = await import("../access/devices.ts");
        const f = await deps.facts();
        return htmlResponse(
          bare(
            "Stolos Console",
            deviceWelcome({
              fleetTitle: f.fleet.title,
              names: deps.remote.access.names,
              signers: await deps.remote.signers(),
              defaultName: defaultDeviceName(req.headers.get("user-agent") ?? ""),
            }),
          ),
          401,
        );
      }
      if (!s) return htmlResponse(bare("Stolos Console", launchPage()), 401);
      if (req.method === "POST") {
        if (!sameOrigin(req)) return new Response("cross-site request refused\n", { status: 403 });
        if (path === "/signout") {
          deps.sessions.end(s.id);
          deps.remote?.access.endSession(s.id);
          return redirect(lan ? "/" : "/launch", { "set-cookie": stolosCookie(undefined, secure) });
        }
        // Spec 100 FR-005: deny a code (a form on the Remote Access page; nothing is signed).
        if (path === "/access/deny" && deps.remote) {
          if (!mayChange(s)) return new Response("refused: you look only here\n", { status: 403 });
          await deps.remote.access.deny(
            formText((await req.formData()).get("code")),
            s.user,
            s.from,
          );
          return redirect("/access");
        }
        if (!req.headers.get("datastar-request")) return new Response("refused\n", { status: 403 });
        if (path === "/actions/run") return await run(req, s);
        if (path === "/askpass/answer" && deps.askpass) {
          const f = await req.formData();
          const id = formText(f.get("id"));
          const cancel =
            url.searchParams.get("cancel") === "1" || formText(f.get("cancel")) === "1";
          const ok = deps.askpass.answer(id, cancel ? undefined : formText(f.get("passphrase")));
          await deps.activity.add({
            at: new Date().toISOString(),
            user: s.user,
            from: "this PC",
            kind: "run",
            detail: cancel ? "passphrase: cancelled" : "passphrase: typed in the browser",
            code: ok ? 0 : 1,
          });
          return new Response(
            patch(
              html`<div id="askpass" class="notice">
                ${
                  !ok
                    ? "That question is no longer waiting."
                    : cancel
                      ? "Cancelled: the command is told no."
                      : "Sent to OpenSSH (not kept anywhere)."
                }
              </div>`,
            ),
            { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
          );
        }
        if (path === "/query/run") return await query(req, s);
        return new Response("not found\n", { status: 404 });
      }
      if (path === "/signout") {
        deps.sessions.end(s.id);
        deps.remote?.access.endSession(s.id);
        return htmlResponse(bare("Signed out", launchPage()), 200, {
          "set-cookie": stolosCookie(undefined, secure),
        });
      }
      if (path === "/boot/stream") return bootStream(deps, req.signal);
      const f = await deps.facts();
      if (path === "/") {
        const engine = await deps.engine?.().catch(() => undefined);
        const access = deps.remote
          ? {
              pending: deps.remote.access.pending.list().length,
              unused: deps.remote.access.unused().length,
            }
          : undefined;
        return await frame(s, "Overview", "/", stolosOverview(f, Date.now(), engine, access), f);
      }
      // Spec 100 FR-010: the Remote Access page, and its record as CSV.
      if (path === "/access" || path === "/export/access.csv") {
        const { accessEvents, accessPage } = await import("../access/pages.ts");
        const events = accessEvents(await deps.activity.recent(100_000));
        if (path.startsWith("/export/")) {
          return new Response(activityCsv(events), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="stolos-access.csv"',
              "cache-control": "no-store",
            },
          });
        }
        const r = deps.remote;
        const v = r?.view() ?? {};
        return await frame(
          s,
          "Remote Access",
          "/access",
          accessPage({
            fleet: { id: f.fleet.id, title: f.fleet.title },
            ...(r ? { names: r.access.names } : {}),
            ...v,
            signers: r ? await r.signers() : f.signers,
            localSigners: r?.access.localSigners() ?? [],
            devices: r?.access.devices() ?? [],
            use: r?.access.use() ?? {},
            pending: r?.access.pending.list() ?? [],
            events,
            may: mayChange(s),
            controller: `http://127.0.0.1:${deps.port}`,
            ...(r ? { publicController: r.controller } : {}),
            ...(r?.access.lastRead().refused ? { refused: r.access.lastRead().refused } : {}),
            now: Date.now(),
          }),
          f,
        );
      }
      if (path === "/machines") {
        const group = url.searchParams.get("group") ?? "";
        return await frame(
          s,
          "Machines",
          "/machines",
          machinesPage(f, Date.now(), group ? { group } : {}),
          f,
        );
      }
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
      // Spec 110-network-assets FR-008: the Network page exists only where a router-kind integration is connected.
      if (path === "/network" || path.startsWith("/network/devices/")) {
        if (!f.network) return new Response("no router is connected\n", { status: 404 });
        if (path === "/network") return await frame(s, "Network", "/network", networkPage(f), f);
        let id = "";
        try {
          id = decodeURIComponent(path.slice("/network/devices/".length));
        } catch {
          return new Response("no such device\n", { status: 404 });
        }
        const body = networkDevicePage(f, id);
        return body
          ? await frame(s, "Network device", "/network", body, f)
          : new Response("no such device\n", { status: 404 });
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
          const as =
            what === "adopt" && url.searchParams.get("osquery") ? ["adopt", "osquery"] : [what];
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
          queryPage(
            url.searchParams.get("sql") ?? "select name, version from os_version",
            f.tagging,
            url.searchParams.get("select") ?? "",
          ),
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
        const selected =
          byName.get(want) ??
          byName.get(g.first) ??
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
      const gm = path.match(/^\/guide\/([a-z0-9-]+)$/)?.[1];
      if (gm) {
        const doc = await deps.guideDoc(gm);
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
      ui.say(`console: ${path}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
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
