/**
 * Spec 065: the Archon Console's web server, as one request handler built
 * from its dependencies (PAM, accounts, the runner, the data), so tests drive
 * it with fakes and a server with the real ones.
 *
 * - `/signin` (form, PAM) and `/signout`; everything else needs a session
 *   (a cookie) or, for a GET, HTTP Basic credentials (scripts).
 * - POSTs come from this site only: the Origin must match the Host, and a run
 *   must carry Datastar's own header (another site's form cannot set it).
 * - `/actions/run` streams the command's output as server-sent events
 *   (Datastar patches the page as lines arrive).
 *
 * @module
 */

import type { Command } from "../core/registry-types.ts";
import type { WelcomeData } from "../web/welcome.ts";
import { CONSOLE_CSS, DATASTAR, datastarSource, FAVICON, MERMAID, vendored } from "./assets.ts";
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
import { argvFor, consoleCommands } from "./forms.ts";
import { esc, type Html, html, raw } from "./html.ts";
import { bare, page } from "./layout.ts";
import {
  actionsPage,
  type ActivityEntry,
  activityPage,
  ARCHON_NAV,
  guidePage,
  howPage,
  overviewPage,
  type RepoFacts,
  signinPage,
} from "./pages.ts";
import type { Authenticator } from "./pam.ts";

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
}

const htmlResponse = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      ...headers,
    },
  });

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location: to, ...headers } });

/** The address a request came from: Traefik's X-Forwarded-For, else the connection's. */
export function clientAddress(req: Request, info?: Deno.ServeHandlerInfo): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  const a = info?.remoteAddr as Deno.NetAddr | undefined;
  return a?.hostname ?? "unknown";
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
    : /^\s*\[(FAIL|!!)\]|fail|refus/i.test(l)
    ? "bad"
    : /^\s*\[(!|warn|\.\.)\]|warning/i.test(l)
    ? "w"
    : /^==>|^\s+(fix|log|explain):/.test(l)
    ? "dim"
    : "";
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

  /** A session from the cookie, or (GET only) Basic credentials checked with PAM. */
  const who = async (req: Request, from: string): Promise<Session | undefined> => {
    const s = deps.sessions.get(cookieOf(req.headers.get("cookie"), COOKIE));
    if (s) return s;
    const auth = req.headers.get("authorization");
    if (req.method !== "GET" || !auth?.startsWith("Basic ")) return undefined;
    if (!deps.throttle.allowed(from)) return undefined;
    let user = "", password = "";
    try {
      [user, password] = atob(auth.slice(6)).split(/:(.*)/s, 2) as [string, string];
    } catch {
      return undefined;
    }
    const account = await deps.accounts(user);
    if (!account || !(await deps.auth.check(user, password ?? ""))) {
      deps.throttle.failed(from);
      return undefined;
    }
    return deps.sessions.create(account, from); // short-lived in practice: Basic sends no cookie
  };

  return async (req, info) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const from = clientAddress(req, info);
    try {
      // ------------------------------------------------ open to anyone
      if (path === "/healthz") return new Response("ok\n");
      if (path === "/static/console.css") {
        return new Response(CONSOLE_CSS, {
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": "max-age=3600" },
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
        const b = await vendored(MERMAID, deps.cacheDir);
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
        if (!deps.throttle.allowed(from)) {
          return again(
            "Too many wrong tries from your address: wait a minute, then try again.",
            429,
          );
        }
        const account = await deps.accounts(user);
        if (!account || !(await deps.auth.check(user, password))) {
          deps.throttle.failed(from);
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
      const s = await who(req, from);
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
        if (path === "/actions") {
          const c = byName.get(url.searchParams.get("cmd") ?? "verify") ?? byName.get("verify")!;
          return frame(s, "Actions", "/actions", actionsPage(offered, c, s));
        }
        if (path === "/activity") {
          return frame(
            s,
            "Activity",
            "/activity",
            activityPage(await deps.activity.recent(200), deps.host),
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
      const shown = `archon ${r.argv.join(" ")}`;
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
