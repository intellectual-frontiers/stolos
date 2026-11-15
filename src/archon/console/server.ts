/**
 * Spec 065: the Archon Console's web server, as one request handler built
 * from its dependencies (PAM, accounts, the runner, the data), so tests drive
 * it with fakes and a server with the real ones.
 *
 * - `/signin` (form, PAM) and `/signout`; everything else needs a session
 *   (a cookie). Wrong passwords are throttled by address and by account.
 * - POSTs come from this site only: the Origin must match the Host, and a run
 *   must carry Datastar's own header (another site's form cannot set it).
 * - `/actions/run` streams the command's output as server-sent events
 *   (Datastar patches the page as lines arrive).
 *
 * @module
 */

import type { Command } from "../core/registry-types.ts";
import type { WelcomeData } from "../web/welcome.ts";
import {
  CONSOLE_CSS,
  CSS_URL,
  DATASTAR,
  datastarSource,
  FAVICON,
  FONTS,
  MERMAID,
  vendored,
} from "./assets.ts";
import {
  type AccountLookup,
  COOKIE,
  cookieOf,
  mayRun,
  type Session,
  sessionCookie,
  type Sessions,
  type Throttle,
} from "./auth.ts";
import type { Runner } from "./exec.ts";
import { argvFor, consoleCommands, shellWords } from "./forms.ts";
import { esc, type Html, html, raw } from "./html.ts";
import { bare, page } from "./layout.ts";
import {
  ACTION_GROUPS,
  actionsPage,
  activityBetween,
  activityCsv,
  type ActivityEntry,
  activityPage,
  appsPage,
  ARCHON_NAV,
  dataPage,
  groupOf,
  guidePage,
  howPage,
  logsPage,
  overviewPage,
  type RepoFacts,
  servicesPage,
  signinPage,
} from "./pages.ts";
import type { Authenticator } from "./pam.ts";
import type { ServicesFacts } from "./machine.ts";

/** What the console needs from the machine: real on a server, fakes in tests. */
export interface ConsoleDeps {
  /** This machine's name in the model. */
  host: string;
  /** Checks passwords (PAM). */
  auth: Authenticator;
  /** Looks up accounts (name, groups). */
  accounts: AccountLookup;
  /** Runs commands as the person. */
  runner: Runner;
  /** The signed-in people. */
  sessions: Sessions;
  /** The sign-in throttle. */
  throttle: Throttle;
  /** What the welcome page gathered (health, apps, guide). */
  data(): Promise<WelcomeData>;
  /** The fleet repository's checkout: commit, signer, engine, signers. */
  repo(): Promise<RepoFacts>;
  /** The activity record: append, and the newest entries. */
  activity: { add(e: ActivityEntry): Promise<void>; recent(n: number): Promise<ActivityEntry[]> };
  /** A served guide's page (docs/<name>.md as HTML), or undefined. */
  guideDoc(name: string): Promise<string | undefined>;
  /** Where large vendored files are cached (Mermaid). */
  cacheDir: string;
  /** The optional services and units, live. */
  services(): Promise<ServicesFacts>;
  /** The journal, live, for a unit or everything, until the signal aborts. */
  journal(
    unit: string | undefined,
    each: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

/** An HTML response, never cached or framed. */
export const htmlResponse = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      // Datastar evaluates its attribute expressions, and the pages carry one inline script.
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...headers,
    },
  });

/** A redirect after a POST (303). */
export const redirect = (to: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { location: to, ...headers } });

/**
 * The address a request came from. The console listens on 127.0.0.1 behind
 * Traefik, which replaces any X-Forwarded-For a client sends with its own
 * (it trusts no forwarded headers): so the header counts only on a loopback
 * connection, and its last entry is the one Traefik added.
 */
export function clientAddress(req: Request, info?: Deno.ServeHandlerInfo): string {
  const a = (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname ?? "unknown";
  const loopback = a === "127.0.0.1" || a === "::1" || a === "unknown";
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean);
  return loopback && xff?.length ? xff[xff.length - 1] : a;
}

/** Whether a POST comes from this site: its Origin (when the browser sends one) matches the Host. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a browser's cross-site form (browsers always send Origin on POST)
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

/** One server-sent event that patches the page (Datastar's datastar-patch-elements). */
export function patch(
  elements: Html | string,
  o: { selector?: string; mode?: string } = {},
): string {
  const lines = [
    "event: datastar-patch-elements",
    ...(o.mode ? [`data: mode ${o.mode}`] : []),
    ...(o.selector ? [`data: selector ${o.selector}`] : []),
    ...String(elements).split("\n").map((l) => `data: elements ${l}`),
  ];
  return lines.join("\n") + "\n\n";
}

/** How a line of archon's plain output is colored. */
export function lineClass(l: string): string {
  return /^\s*\[ok\]/.test(l)
    ? "ok"
    : /^\s*\[FAIL\]|^error|failed|refus/i.test(l)
    ? "bad"
    : /^\s*\[(!!|!|warn|\.\.)\]|warning/i.test(l)
    ? "w"
    : /^==>|^\s+(fix|log|explain):/.test(l)
    ? "dim"
    : "";
}

/** The consoles' static files (stylesheet, icon, Datastar, Mermaid, fonts), or undefined. */
export async function staticFile(path: string, cacheDir: string): Promise<Response | undefined> {
  if (path === CSS_URL || path === "/static/console.css") {
    return new Response(CONSOLE_CSS, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": path === CSS_URL ? "max-age=31536000, immutable" : "no-cache",
      },
    });
  }
  if (path === "/static/favicon.svg") {
    return new Response(FAVICON, {
      headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" },
    });
  }
  if (path === DATASTAR.url) {
    return new Response(datastarSource(), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "max-age=31536000, immutable",
      },
    });
  }
  if (path === MERMAID.url) {
    const b = await vendored(MERMAID, cacheDir);
    return b
      ? new Response(b, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "max-age=31536000, immutable",
        },
      })
      : new Response("// Mermaid is not available on this server yet\n", {
        status: 503,
        headers: { "content-type": "text/javascript" },
      });
  }
  const font = FONTS.find((f) => f.url === path);
  if (font) {
    const b = await vendored(font, cacheDir);
    return b
      ? new Response(b, {
        headers: {
          "content-type": "font/woff2",
          "cache-control": "max-age=31536000, immutable",
        },
      })
      : new Response("", { status: 503 });
  }
  return undefined;
}

/** The console's request handler. */
export function consoleHandler(
  deps: ConsoleDeps,
): (req: Request, info?: Deno.ServeHandlerInfo) => Promise<Response> {
  const offered = consoleCommands("machine");
  const byName = new Map(offered.map((c) => [c.name, c]));

  const frame = async (s: Session, title: string, current: string, body: Html) => {
    const d = await deps.data();
    return htmlResponse(page({
      product: "archon",
      title,
      subtitle: `${deps.host} · ${d.os}`,
      fleet: { id: d.title, repo: d.repo.slug },
      user: { name: s.name, user: s.user, role: s.role === "operator" ? "operator" : "can look" },
      nav: ARCHON_NAV,
      current,
    }, body));
  };

  /** A session from the cookie (the only way in: no Basic credentials, which would make a session per request). */
  const who = (req: Request): Session | undefined =>
    deps.sessions.get(cookieOf(req.headers.get("cookie"), COOKIE));

  return async (req, info) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const from = clientAddress(req, info);
    try {
      // ------------------------------------------------ open to anyone
      if (path === "/healthz") return new Response("ok\n");
      const st = await staticFile(path, deps.cacheDir);
      if (st) return st;
      if (path === "/signin" && req.method === "GET") {
        const d = await deps.data();
        return htmlResponse(
          bare(`Sign in · ${deps.host}`, signinPage({ host: deps.host, fqdn: d.fqdn })),
        );
      }
      if (path === "/signin" && req.method === "POST") {
        if (!sameOrigin(req)) return new Response("cross-site sign-in refused\n", { status: 403 });
        const form = await req.formData();
        const user = String(form.get("user") ?? "").trim();
        const password = String(form.get("password") ?? "");
        const d = await deps.data();
        const again = (error: string, status = 401) =>
          htmlResponse(
            bare(
              `Sign in · ${deps.host}`,
              signinPage({ host: deps.host, fqdn: d.fqdn, error, user }),
            ),
            status,
          );
        // By address and by account: a forged or rotating address still cannot guess one account's password.
        if (!deps.throttle.allowed(from) || !deps.throttle.allowed(`user:${user}`)) {
          return again(
            "Too many wrong tries from your address: wait a minute, then try again.",
            429,
          );
        }
        const account = await deps.accounts(user);
        if (!account || !(await deps.auth.check(user, password))) {
          deps.throttle.failed(from);
          deps.throttle.failed(`user:${user}`);
          await deps.activity.add({
            at: new Date().toISOString(),
            user: user || "?",
            from,
            kind: "sign-in failed",
            detail: "wrong username or password",
          });
          return again("That username and password do not match an account on this server.");
        }
        deps.throttle.succeeded(from);
        deps.throttle.succeeded(`user:${user}`);
        const s = deps.sessions.create(account, from);
        await deps.activity.add({
          at: new Date().toISOString(),
          user: s.user,
          from,
          kind: "sign-in",
          detail: s.role,
        });
        return redirect("/", { "set-cookie": sessionCookie(s) });
      }
      if (path === "/signout" && req.method === "POST") {
        if (!sameOrigin(req)) return new Response("cross-site sign-out refused\n", { status: 403 });
        const id = cookieOf(req.headers.get("cookie"), COOKIE);
        const s = deps.sessions.get(id);
        if (s) {
          await deps.activity.add({
            at: new Date().toISOString(),
            user: s.user,
            from,
            kind: "sign-out",
            detail: "",
          });
        }
        deps.sessions.end(id);
        return redirect("/signin", { "set-cookie": sessionCookie(undefined) });
      }

      // ------------------------------------------------ signed in
      const s = who(req);
      if (!s) {
        return req.method === "GET"
          ? redirect("/signin")
          : new Response("sign in first\n", { status: 401 });
      }
      if (req.method === "GET") {
        if (path === "/") {
          return frame(s, "Overview", "/", overviewPage(await deps.data(), await deps.repo(), s));
        }
        if (path === "/how") {
          return frame(s, "How it works", "/how", howPage(await deps.data(), await deps.repo()));
        }
        if (path === "/actions") return redirect("/actions/server");
        const ag = path.match(/^\/actions\/([a-z]+)$/);
        if (ag) {
          const group = ACTION_GROUPS.find((g) => g.id === ag[1]);
          if (!group) return htmlResponse("not found\n", 404);
          const wanted = byName.get(url.searchParams.get("cmd") ?? "");
          const c = wanted && groupOf(wanted.name).id === group.id
            ? wanted
            : byName.get(group.first) ?? offered.find((x) => groupOf(x.name).id === group.id)!;
          return frame(
            s,
            group.label,
            `/actions/${group.id}`,
            actionsPage(group, offered, c, s, await deps.data()),
          );
        }
        if (path === "/services") {
          return frame(
            s,
            "Services",
            "/services",
            servicesPage(await deps.services(), s, deps.host),
          );
        }
        if (path === "/apps") return frame(s, "Apps", "/apps", appsPage(await deps.data()));
        if (path === "/data") {
          return frame(s, "Data", "/data", dataPage(await deps.data(), await deps.services()));
        }
        if (path === "/logs" || path === "/logs/stream") {
          const units = (await deps.services()).units.map((u) => u.unit);
          const want = url.searchParams.get("unit") || undefined;
          const unit = want && units.includes(want) ? want : undefined; // only the plan's units
          if (path === "/logs") return frame(s, "Logs", "/logs", logsPage(units, unit, deps.host));
          return journalStream(deps, unit, req.signal);
        }
        if (path === "/compliance") {
          const d = await deps.data();
          const r = await deps.repo();
          const { complianceView, serverEvidence } = await import("../compliance/report.ts");
          const { loadScf } = await import("../compliance/catalog.ts");
          const { compliancePage } = await import("./compliance-page.ts");
          const view = complianceView(
            serverEvidence({
              host: deps.host,
              ...(d.verify ? { verify: d.verify } : {}),
              ...(r.signer ? { signer: r.signer } : {}),
              ...(r.commit ? { commit: r.commit.sha } : {}),
              https: true,
            }),
            await loadScf(),
          );
          return frame(
            s,
            "Compliance",
            "/compliance",
            compliancePage(view, url.searchParams.get("fw") ?? undefined, deps.host),
          );
        }
        if (path === "/activity" || path === "/export/activity.csv") {
          // A viewer sees only their own entries (others' sign-ins and addresses are operators' business).
          const mine = (e: ActivityEntry) => s.role === "operator" || e.user === s.user;
          const all = activityBetween(
            (await deps.activity.recent(100_000)).filter(mine),
            url.searchParams.get("from") ?? undefined,
            url.searchParams.get("to") ?? undefined,
          );
          if (path.startsWith("/export/")) {
            return new Response(activityCsv(all), {
              headers: {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="${deps.host}-activity.csv"`,
                "cache-control": "no-store",
              },
            });
          }
          return frame(
            s,
            "Activity",
            "/activity",
            activityPage(all.slice(0, 500), deps.host, {
              from: url.searchParams.get("from") ?? undefined,
              to: url.searchParams.get("to") ?? undefined,
              ...(s.role === "operator" ? {} : { note: "As a viewer, you see your own entries." }),
            }),
          );
        }
        if (path === "/guide") {
          const d = await deps.data();
          return frame(
            s,
            "Guide",
            "/guide",
            guidePage(d.guide, d.guides, new Set(byName.keys()), deps.host),
          );
        }
        const g = path.match(/^\/guide\/([a-z0-9-]+)$/);
        if (g) {
          const body = await deps.guideDoc(g[1]);
          if (body) {
            return frame(
              s,
              "Guide",
              "/guide",
              html`<article class="card prose">${raw(body)}</article>`,
            );
          }
        }
        return htmlResponse("not found\n", 404);
      }
      if (req.method === "POST" && path === "/actions/run") {
        if (!sameOrigin(req) || req.headers.get("datastar-request") !== "true") {
          return new Response("refused: not from this console's page\n", { status: 403 });
        }
        return await runCommand(req, s, from, byName, deps);
      }
      return new Response("not found\n", { status: 404 });
    } catch (e) {
      return htmlResponse(`<p>console error: ${esc((e as Error).message)}</p>`, 500);
    }
  };
}

/** Run a command from its form, and stream its output to the page. */
async function runCommand(
  req: Request,
  s: Session,
  from: string,
  byName: Map<string, Command>,
  deps: ConsoleDeps,
): Promise<Response> {
  const form = Object.fromEntries(
    [...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]),
  );
  const cmd = byName.get(form.command ?? "");
  const enc = new TextEncoder();
  const now = () => new Date().toISOString();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (x: string) => ctl.enqueue(enc.encode(x));
      const state = (text: string) =>
        send(patch(html`<span class="sub" id="runstate">${text}</span>`));
      const refuse = async (why: string) => {
        send(patch(html`
          <div class="term" id="output">
            <div class="bad">${why}</div>
          </div>
        `));
        state("Not run");
        await deps.activity.add({
          at: now(),
          user: s.user,
          from,
          kind: "refused",
          detail: `${form.command ?? "?"}: ${why}`,
        });
        ctl.close();
      };
      if (!cmd) return refuse("That command is not offered here.");
      const r = argvFor(cmd, form);
      if ("error" in r) return refuse(r.error);
      if (!mayRun(s.role, r.tier)) {
        return refuse(
          "Only operators (members of sudo or archon-ops) may run commands that change the server.",
        );
      }
      const destroying = r.tier === "destructive" || r.args["confirm-destroy"] !== undefined;
      if (destroying && !(await deps.auth.check(s.user, form.password ?? ""))) {
        return refuse("Destroying data needs your password again, and it did not match.");
      }
      const shown = `archon ${shellWords(r.argv)}`;
      send(patch(html`
        <div class="term" id="output">
          <div class="dim">$ ${shown}   (as ${s.user})</div>
        </div>
      `));
      state("Running ...");
      let code = 1;
      try {
        code = await deps.runner.run(
          s.user,
          r.argv,
          (l) =>
            send(
              patch(html`<div class="${lineClass(l)}">${l || " "}</div>`, {
                selector: "#output",
                mode: "append",
              }),
            ),
        );
      } catch (e) {
        send(
          patch(html`<div class="bad">${(e as Error).message}</div>`, {
            selector: "#output",
            mode: "append",
          }),
        );
      }
      state(code === 0 ? "Done" : `Failed (exit ${code})`);
      await deps.activity.add({ at: now(), user: s.user, from, kind: "run", detail: shown, code });
      ctl.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

/** The journal as server-sent events: the page's terminal gets each line as it comes. */
function journalStream(deps: ConsoleDeps, unit: string | undefined, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(enc.encode(patch(html`<div class="term" id="logs" aria-live="off"></div>`)));
      deps.journal(unit, (l) => {
        try {
          ctl.enqueue(
            enc.encode(
              patch(html`<div class="${lineClass(l)}">${l}</div>`, {
                selector: "#logs",
                mode: "append",
              }),
            ),
          );
        } catch { /* the page went away */ }
      }, signal).finally(() => {
        try {
          ctl.close();
        } catch { /* already closed */ }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
