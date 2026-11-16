/**
 * Spec 082: the provider's console (`stolos clients console`): one Stolos
 * Console for every client, on this PC only (127.0.0.1, a one-time launch
 * link, as spec 066).
 *
 * - `/clients`: the cross-client summary, numbers only, and a switch per client.
 * - Switching (a POST to `/clients/switch`) ends the session and starts a new
 *   one, scoped to that client: every other page (the client's own console,
 *   its REST API under `/v1/`) is that client's, served by a console of its
 *   own, with its own sessions and caches, built and run in its scope.
 * - A session sees one client at a time. Its cookie names a provider session;
 *   the provider session maps to one session in one client's console, so
 *   reaching another client's pages takes another switch (a new cookie), and
 *   the old cookie stops working.
 * - `/v1/clients`: the summary as JSON (numbers only), for any signed-in session.
 *
 * ```mermaid
 * flowchart LR
 *   launch["/launch (one-time link)"] --> list["/clients: the summary"]
 *   list -->|"switch: a new session"| a["client A's console<br/>(its sessions, caches, scope)"]
 *   list -->|"switch: a new session"| b["client B's console"]
 *   a -->|"All clients"| list
 * ```
 *
 * @module
 */
// Spec: 082-multi-fleet

import type { ServeInfo } from "@intellectual-frontiers/commons/ts/runtime";
import { cookieOf, type Sessions } from "../console/auth.ts";
import { type Html, html } from "../console/html.ts";
import { bare, page } from "../console/layout.ts";
import { htmlResponse, redirect, sameOrigin, staticFile } from "../console/server.ts";
import { launchPage } from "../console/stolos-pages.ts";
import { type Launch, STOLOS_COOKIE, stolosCookie } from "../console/stolos-server.ts";
import { apiError, apiJson, apiUnauthorized } from "../api/handler.ts";
import type { Client } from "./registry.ts";
import { ui } from "../core/ui.ts";
import { type ClientSummary, totals } from "./summary.ts";

/** One client's console: its handler and its own sessions. */
export interface ClientConsole {
  /** The client's Stolos Console (spec 066), scoped to it. */
  handler: (req: Request) => Promise<Response>;
  /** Its own sessions (never another client's). */
  sessions: Sessions;
}

/** What the provider's console needs: real on the PC, fakes in tests. */
export interface ProviderDeps {
  /** The port (for the Host check). */
  port: number;
  /** The person at this PC. */
  person: { user: string; name: string };
  /** The launch links. */
  launch: Launch;
  /** The provider's sessions. */
  sessions: Sessions;
  /** The registered clients. */
  clients(): Promise<Client[]>;
  /** Every client's numbers, each read in its own scope. */
  summaries(): Promise<ClientSummary[]>;
  /** A client's console (built once per client, in its scope). */
  consoleFor(c: Client): Promise<ClientConsole>;
  /** Where Mermaid and the fonts are cached. */
  cacheDir: string;
}

const NAV = [{ group: "Provider", label: "Clients", href: "/clients" }];

const num = (n: number, bad = false) =>
  html`<span class="pill ${bad && n > 0 ? "bad" : n > 0 ? "ok" : "off"}">${n}</span>`;

/** The cross-client summary page: one row per client, numbers only, and its switch. */
export function clientsPage(list: ClientSummary[], current?: string): Html {
  const t = totals(list);
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">Provider</div>
        <h1>Clients</h1>
        <p>
          Each client is its own repository, vault, and signers. These numbers are read from each
          client separately; opening a client starts a session for that client only.
        </p>
      </div>
    </div>
    <div class="grid cols-3">
      <div class="card">
        <div class="k">Clients</div>
        <div class="v">${t.clients}</div>
        <div class="sub">${t.unreadable} not read</div>
      </div>
      <div class="card">
        <div class="k">Failing controls</div>
        <div class="v">${t.failing}</div>
        <div class="sub">${t.stale} with stale evidence</div>
      </div>
      <div class="card">
        <div class="k">Open POA&amp;M items</div>
        <div class="v">${t.poamOpen}</div>
        <div class="sub">${t.drifted} client(s) drifted</div>
      </div>
    </div>
    <div class="card scroll">
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Pass</th>
            <th>Fail</th>
            <th>Partial</th>
            <th>No evidence</th>
            <th>Stale</th>
            <th>Drift</th>
            <th>Last observation</th>
            <th>Open POA&amp;M</th>
            <th>Evidence bundle</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${list.map(
            (s) => html`
              <tr>
                <td>
                  <b>${s.title}</b> <span class="sub mono">${s.client}</span>${
                    s.client === current ? html` <span class="pill tier">open</span> ` : ""
                  }
                </td>
                ${
                  s.readable
                    ? html`
                        <td>${num(s.controls.pass)}</td>
                        <td>${num(s.controls.fail, true)}</td>
                        <td>${num(s.controls.partial)}</td>
                        <td>${s.controls.noEvidence}</td>
                        <td>${num(s.controls.stale, true)}</td>
                        <td>${s.drift ? `${s.drift.changed} (${s.drift.worse} worse)` : "-"}</td>
                        <td class="sub">
                          ${s.lastObservation?.slice(0, 16).replace("T", " ") ?? "-"}
                        </td>
                        <td>${num(s.poamOpen, true)}</td>
                        <td class="sub">${s.evidenceBundle ?? "-"}</td>
                      `
                    : html`<td colspan="9" class="sub">Not read: ${s.problem}</td>`
                }
                <td>
                  ${
                    s.readable
                      ? html`
                          <form method="post" action="/clients/switch">
                            <input type="hidden" name="id" value="${s.client}" />
                            <button class="btn" type="submit">Open</button>
                          </form>
                        `
                      : ""
                  }
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      ${
        list.length
          ? ""
          : html`
              <p class="sub">
                No clients yet: in a terminal,
                <code>bun run stolos clients add &lt;path to the client's checkout&gt;</code>.
              </p>
            `
      }
    </div>
  `;
}

/** The provider's console's request handler. */
export function providerHandler(
  deps: ProviderDeps,
): (req: Request, info?: ServeInfo) => Promise<Response> {
  const hosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  /** Provider session id -> the client it is scoped to, and its session in that client's console. */
  const scopes = new Map<string, { client: string; inner: string }>();

  const end = async (id: string) => {
    const sc = scopes.get(id);
    scopes.delete(id);
    deps.sessions.end(id);
    if (sc) {
      const c = (await deps.clients()).find((x) => x.id === sc.client);
      if (c) (await deps.consoleFor(c)).sessions.end(sc.inner);
    }
  };

  const frame = (title: string, body: Html, s: { name: string; user: string }) =>
    htmlResponse(
      page(
        {
          product: "stolos",
          title,
          subtitle: `this PC · ${deps.person.user}`,
          fleet: { id: "none (the provider's view)", repo: "each client in its own repository" },
          user: { name: s.name, user: s.user, role: "provider" },
          nav: NAV,
          current: "/clients",
        },
        body,
      ),
    );

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
        const s = deps.sessions.create(
          {
            user: deps.person.user,
            name: deps.person.name,
            groups: ["archon-ops"],
          },
          "this PC",
        );
        return redirect("/clients", { "set-cookie": stolosCookie(s) });
      }
      const s = deps.sessions.get(cookieOf(req.headers.get("cookie"), STOLOS_COOKIE));
      if (!s) {
        return path === "/v1" || path.startsWith("/v1/")
          ? apiUnauthorized()
          : htmlResponse(bare("Stolos Console", launchPage()), 401);
      }
      if (path === "/signout") {
        if (req.method === "POST" && !sameOrigin(req)) {
          return new Response("cross-site request refused\n", { status: 403 });
        }
        await end(s.id);
        return redirect("/launch", { "set-cookie": stolosCookie(undefined) });
      }
      if (path === "/clients/switch") {
        if (req.method !== "POST") return new Response("POST only\n", { status: 405 });
        if (!sameOrigin(req)) return new Response("cross-site request refused\n", { status: 403 });
        const given = (await req.formData()).get("id");
        const id = typeof given === "string" ? given : "";
        const c = (await deps.clients()).find((x) => x.id === id);
        if (!c) return new Response("no such client\n", { status: 404 });
        // A new session for the new scope: the old cookie (and its client session) end here.
        await end(s.id);
        const fresh = deps.sessions.create(
          { user: s.user, name: s.name, groups: s.groups },
          "this PC",
        );
        const inner = (await deps.consoleFor(c)).sessions.create(
          { user: s.user, name: s.name, groups: ["archon-ops"] },
          "this PC",
        );
        scopes.set(fresh.id, { client: c.id, inner: inner.id });
        return redirect("/", { "set-cookie": stolosCookie(fresh) });
      }
      const scope = scopes.get(s.id);
      if (path === "/clients" && req.method === "GET") {
        return frame("Clients", clientsPage(await deps.summaries(), scope?.client), s);
      }
      if (path === "/v1/clients" || path.startsWith("/v1/clients/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return apiError(405, "read-only: GET and HEAD", { allow: "GET, HEAD" });
        }
        const list = await deps.summaries();
        if (path === "/v1/clients") return apiJson({ totals: totals(list), clients: list });
        const one = list.find((x) => x.client === path.slice("/v1/clients/".length));
        return one ? apiJson(one) : apiError(404, "no such client");
      }
      if (!scope) {
        return path === "/v1" || path.startsWith("/v1/")
          ? apiError(409, "choose a client first: POST /clients/switch, or open /clients")
          : redirect("/clients");
      }
      const c = (await deps.clients()).find((x) => x.id === scope.client);
      if (!c) {
        scopes.delete(s.id);
        return redirect("/clients");
      }
      const cc = await deps.consoleFor(c);
      // The request goes on to that client's console as its own session there, and nothing else.
      const headers = new Headers(req.headers);
      headers.set("cookie", `${STOLOS_COOKIE}=${scope.inner}`);
      const r = await cc.handler(new Request(req, { headers }));
      if (!r.headers.has("set-cookie")) return r;
      const out = new Response(r.body, r);
      out.headers.delete("set-cookie");
      return out;
    } catch (e) {
      ui.problem(
        "fail",
        "Console",
        `console: ${path}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return htmlResponse(
        bare(
          "Error",
          html`
            <div class="card" style="max-width:640px;margin:10vh auto">
              <h1>Something went wrong</h1>
              <p class="sub">The terminal where the console runs has the details.</p>
            </div>
          `,
        ),
        500,
      );
    }
  };
}
