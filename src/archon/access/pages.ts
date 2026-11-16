/**
 * Spec 100: the pages of remote access.
 *
 * - For a device that is not signed in, on an HTTPS name (FR-004, FR-007): sign in with a
 *   passkey, or register this device (pick your signer, name it, create the passkey), then the
 *   code and the wait for a signer, then sign in. The browser's WebAuthn calls are a few lines of
 *   script on the page; nothing else runs in the browser.
 * - The Remote Access page (`/access`, FR-010): the addresses and certificate, who can sign in,
 *   every device with its history, the codes waiting, recent sign-ins and refusals, and the flow.
 *
 * @module
 */
// Spec: 100-remote-access FR-004, FR-007, FR-010

import type { ConsoleDevice } from "../model/types.ts";
import type { ActivityEntry } from "../console/pages.ts";
import { type Html, html, raw } from "../console/html.ts";
import { diagram } from "../console/layout.ts";
import type { DeviceUse, Pending } from "./devices.ts";
import { UNUSED_DAYS } from "./devices.ts";
import type { ConsoleNames } from "./names.ts";
import { daysLeft, EXPIRY_WARN_DAYS, issuerName } from "./tls.ts";

/** How remote access works, drawn (the Remote Access page and its action group). */
export function accessDiagram(domain = "lab.example.net"): string {
  const d = domain.replace(/[<>"]/g, "");
  return `sequenceDiagram
  participant D as New device
  participant C as Controller (stolos console --lan)
  participant S as A signer's PC
  participant G as GitHub
  D->>C: https://stolos.${d}: pick your name, create a passkey
  C->>D: code (15 minutes)
  S->>C: devices approve (code): fetch the public fields
  S->>G: access.ts, in a commit signed by the signer's key
  C->>G: fetch: the tip signed by a signer?
  C->>D: approved: sign in with the passkey`;
}

// The browser's side of WebAuthn: the JSON forms of the options and answers (commons' WebAuthn
// speaks JSON), with the newer browser helpers where they exist.
const SCRIPT = String.raw`
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const creds = (l) => (l || []).map((c) => ({ ...c, id: b64u.dec(c.id) }));
function createOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) }, excludeCredentials: creds(o.excludeCredentials) };
}
function getOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: b64u.dec(o.challenge), allowCredentials: creds(o.allowCredentials) };
}
function asJson(c) {
  if (c.toJSON) return c.toJSON();
  const r = c.response;
  const out = { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(), response: { clientDataJSON: b64u.enc(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = b64u.enc(r.attestationObject);
    out.response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    out.response.authenticatorData = b64u.enc(r.authenticatorData);
    out.response.signature = b64u.enc(r.signature);
    if (r.userHandle) out.response.userHandle = b64u.enc(r.userHandle);
  }
  return out;
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}
const say = (t) => { document.getElementById("say").textContent = t; };
async function signIn() {
  say("Use your passkey ...");
  try {
    const o = await post("/access/signin/options", {});
    if (o.error) return say(o.error);
    const c = await navigator.credentials.get({ publicKey: getOptions(o.options) });
    const r = await post("/access/signin/finish", { ticket: o.ticket, response: asJson(c) });
    if (r.ok) location.href = "/"; else say(r.error || "Not signed in.");
  } catch (e) { say("Not signed in: " + e.message); }
}
async function register(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  say("Create your passkey ...");
  try {
    const o = await post("/access/register/options", { signer: f.get("signer"), name: f.get("name") });
    if (o.error) return say(o.error);
    const c = await navigator.credentials.create({ publicKey: createOptions(o.options) });
    const r = await post("/access/register/finish", { ticket: o.ticket, response: asJson(c) });
    if (r.error) return say(r.error);
    document.getElementById("register").hidden = true;
    document.getElementById("wait").hidden = false;
    document.getElementById("code").textContent = r.code;
    say("");
    const t = setInterval(async () => {
      const s = await (await fetch("/access/status/" + encodeURIComponent(r.code))).json();
      if (s.status === "approved") {
        clearInterval(t);
        document.getElementById("waiting").textContent = "Approved: sign in with your passkey.";
        document.getElementById("signin2").hidden = false;
      } else if (s.status === "gone") {
        clearInterval(t);
        document.getElementById("waiting").textContent = "The code expired or was denied: start again.";
      }
    }, 3000);
  } catch (e) { say("Not registered: " + e.message); }
}
document.getElementById("signin")?.addEventListener("click", signIn);
document.getElementById("signin2")?.addEventListener("click", signIn);
document.getElementById("register")?.addEventListener("submit", register);
`;

/** The page a device that is not signed in sees on an HTTPS name: sign in, or register (FR-004). */
export function deviceWelcome(o: {
  fleetTitle: string;
  names: ConsoleNames;
  signers: ReadonlyArray<{ name: string; role: string }>;
  defaultName: string;
}): Html {
  return html`
    <div class="card stack" style="max-width:560px;margin:8vh auto">
      <h1>Stolos Console</h1>
      <p class="sub">${o.fleetTitle} · ${o.names.own}</p>
      <div class="row">
        <button class="btn" type="button" id="signin">Sign in with your passkey</button>
      </div>
      <p id="say" class="sub" role="status"></p>
      <form id="register" class="stack">
        <h2>New device? Register it</h2>
        <label class="field"
          ><span>Who are you (a fleet signer)?</span>
          <select name="signer" required>
            ${o.signers.map((s) => html`<option value="${s.name}">${s.name} (${s.role})</option>`)}
          </select></label
        >
        <label class="field"
          ><span>Name this device</span
          ><input name="name" value="${o.defaultName}" maxlength="60" required
        /></label>
        <button class="btn ghost" type="submit">Create a passkey</button>
        <p class="sub">
          Your browser makes a passkey for this console now. A fleet signer then approves the code
          shown next, with a signed commit (bun run stolos devices approve, on their PC or on the
          controller's Remote Access page). Only the passkey's public half leaves this device.
        </p>
      </form>
      <div id="wait" class="stack" hidden>
        <h2>Waiting for a signer</h2>
        <p>Give this code to a fleet signer. It waits for 15 minutes.</p>
        <p class="mono" style="font-size:2em" id="code"></p>
        <pre class="mono">bun run stolos devices approve &lt;code&gt;</pre>
        <p id="waiting" class="sub">Waiting ...</p>
        <button class="btn" type="button" id="signin2" hidden>Sign in with your passkey</button>
      </div>
    </div>
    <script>
      ${raw(SCRIPT)};
    </script>
  `;
}

/** What the Remote Access page shows (FR-010). */
export interface AccessView {
  /** The fleet's id and title. */
  fleet: { id: string; title: string };
  /** The console's names, or undefined when the fleet has no web domain. */
  names?: ConsoleNames;
  /** The HTTPS listener while it serves. */
  listener?: { address: string; port: number };
  /** The certificate, when there is one. */
  tls?: { names: string[]; notAfter: string; directory: string };
  /** Another controller's live heartbeat. */
  other?: { pc: string; at: string };
  /** Every signer. */
  signers: ReadonlyArray<{ name: string; role: string }>;
  /** Signers whose key is on this controller. */
  localSigners: readonly string[];
  /** The approved devices. */
  devices: readonly ConsoleDevice[];
  /** Each device's use here. */
  use: Record<string, DeviceUse>;
  /** The codes waiting. */
  pending: readonly Pending[];
  /** Recent sign-ins, failures, refusals and access events. */
  events: readonly ActivityEntry[];
  /** Whether this session may sign here (Approve, Deny, Revoke shown). */
  may: boolean;
  /** The controller's address for the Approve button's `devices approve --controller` (it runs here). */
  controller: string;
  /** The controller's HTTPS address, for a signer approving from their own PC. */
  publicController?: string;
  /** Why the newest tip was not honoured, if it was not. */
  refused?: string;
  /** Now (ms). */
  now: number;
}

const when = (iso: string | undefined): string =>
  iso ? iso.slice(0, 16).replace("T", " ") : "never";

/** The activity entries the Remote Access page lists: sign-ins, failures, refusals, access. */
export function accessEvents(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return entries.filter(
    (e) =>
      e.kind === "access" ||
      e.kind === "sign-in" ||
      e.kind === "sign-in failed" ||
      e.kind === "refused",
  );
}

/** The Remote Access page (FR-010). */
export function accessPage(v: AccessView): Html {
  const unused = new Set(
    v.devices
      .filter((d) => {
        const last = Date.parse(v.use[d.id]?.lastUsed ?? d.registered);
        return !Number.isFinite(last) || v.now - last > UNUSED_DAYS * 86_400_000;
      })
      .map((d) => d.id),
  );
  const left = v.tls ? daysLeft(v.tls.notAfter, v.now) : undefined;
  const approveHref = (p: Pending) =>
    `/actions/access?cmd=devices%20approve&code=${encodeURIComponent(p.code)}&controller=${encodeURIComponent(v.controller)}&yes=on`;
  const revokeHref = (d: ConsoleDevice) =>
    `/actions/access?cmd=devices%20revoke&id=${encodeURIComponent(d.id)}&yes=on`;
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${v.fleet.title}</div>
        <h1>Remote Access</h1>
        <p>
          This console from other devices on the site's network: HTTPS with a real certificate, a
          passkey per device, and every device approved by a fleet signer in a signed commit
          (fleets/${v.fleet.id}/access.ts). Signers whose key is on this PC may run every command;
          everyone else looks.
        </p>
      </div>
      <a class="btn ghost" href="/export/access.csv">Download CSV</a>
    </div>
    <div class="grid cols-3">
      <div class="card" id="addresses">
        <div class="k">Addresses</div>
        ${
          v.names
            ? html`<div class="v mono">
                  ${v.names.served.map((n) => html`<div>https://${n}${v.listener && v.listener.port !== 443 ? `:${v.listener.port}` : ""}</div>`)}
                </div>
                <div class="sub">
                  ${v.names.primary ? "this PC is the primary controller" : `the primary is ${v.names.primaryName ?? "another controller"}`}
                </div>`
            : html`<div class="v">not set up</div>
                <div class="sub">
                  fleet.ts needs web: { domain }, then: bun run stolos console --lan
                </div>`
        }
      </div>
      <div class="card" id="listener">
        <div class="k">LAN listener</div>
        <div class="v">
          ${
            v.listener
              ? html`<span class="pill ok">on</span> ${v.listener.address}:${v.listener.port}`
              : html`<span class="pill tier">off</span>`
          }
        </div>
        <div class="sub">
          ${v.listener ? "LAN or mesh only (Article 28)" : "start it with: bun run stolos console --lan"}
        </div>
        ${
          v.other
            ? html`<p class="notice warn">
                ⚡ also open on ${v.other.pc} (heartbeat ${when(v.other.at)})
              </p>`
            : ""
        }
      </div>
      <div class="card" id="certificate">
        <div class="k">Certificate</div>
        ${
          v.tls
            ? html`<div class="v">${issuerName(v.tls.directory)}, ${left} day(s) left</div>
                <div class="sub mono">${v.tls.names.join(", ")}</div>
                <div class="sub">expires ${when(v.tls.notAfter)}</div>
                ${
                  left !== undefined && left < EXPIRY_WARN_DAYS
                    ? html`<p class="notice warn">
                        ⚡ renew it: restart bun run stolos console --lan
                      </p>`
                    : ""
                }`
            : html`<div class="v">none yet</div>
                <div class="sub">issued at the first bun run stolos console --lan</div>`
        }
      </div>
    </div>
    ${
      v.refused
        ? html`<p class="notice warn">
            The newest commit on GitHub is not honoured: ${v.refused}. Devices stay as they were.
          </p>`
        : ""
    }
    <div class="card scroll" id="pending" style="margin-top:14px">
      <h2>Waiting for a signer</h2>
      ${
        v.pending.length
          ? html`<table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Signer</th>
                  <th>Device</th>
                  <th>From</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${v.pending.map(
                  (p) =>
                    html`<tr>
                      <td class="mono"><b>${p.code}</b></td>
                      <td>${p.signer}</td>
                      <td>
                        ${p.deviceName}
                        <span class="sub"
                          >${p.backedUp ? "synced passkey" : "device-bound passkey"}</span
                        >
                      </td>
                      <td class="sub">${p.from} · ${p.userAgent}</td>
                      <td class="sub">${when(p.expires)}</td>
                      <td>
                        ${
                          v.may
                            ? html`<a class="btn" href="${approveHref(p)}">Approve</a>
                                <form method="post" action="/access/deny" style="display:inline">
                                  <input type="hidden" name="code" value="${p.code}" />
                                  <button class="btn ghost" type="submit">Deny</button>
                                </form>`
                            : html`<span class="sub"
                                >a signer approves, on their PC: bun run stolos devices approve
                                ${p.code}${v.publicController ? ` --controller ${v.publicController}` : ""}</span
                              >`
                        }
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="sub">No code is waiting.</p>`
      }
    </div>
    <div class="card scroll" id="signers" style="margin-top:14px">
      <h2>Who can sign in</h2>
      <table>
        <thead>
          <tr>
            <th>Signer</th>
            <th>Role</th>
            <th>Here</th>
            <th>Devices</th>
            <th>Last sign-in</th>
          </tr>
        </thead>
        <tbody>
          ${v.signers.map((s) => {
            const mine = v.devices.filter((d) => d.signer === s.name);
            const last = mine
              .map((d) => v.use[d.id]?.lastUsed)
              .filter((x): x is string => !!x)
              .sort()
              .pop();
            return html`<tr>
              <td><b>${s.name}</b></td>
              <td>${s.role}</td>
              <td>
                ${
                  v.localSigners.includes(s.name)
                    ? html`<span class="pill ok">may sign here</span>`
                    : html`<span class="pill tier">looks only</span>`
                }
              </td>
              <td>${mine.length}</td>
              <td class="sub">${when(last)}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    <div class="card scroll" id="devices" style="margin-top:14px">
      <h2>Devices</h2>
      ${
        v.devices.length
          ? html`<table>
              <thead>
                <tr>
                  <th>Signer</th>
                  <th>Device</th>
                  <th>Passkey</th>
                  <th>Registered</th>
                  <th>Approved by</th>
                  <th>From</th>
                  <th>Last sign-in</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${v.devices.map((d) => {
                  const u = v.use[d.id];
                  return html`<tr>
                    <td>${d.signer}</td>
                    <td>
                      <b>${d.name}</b>
                      <span class="sub mono">${d.id}</span>
                      ${unused.has(d.id) ? html`<div class="notice warn">⚡ unused for ${UNUSED_DAYS} days: review or revoke</div>` : ""}
                    </td>
                    <td>${d.backedUp ? "synced" : "device-bound"}</td>
                    <td class="sub">${when(d.registered)}</td>
                    <td>${d.approvedBy}</td>
                    <td class="sub">${d.registeredFrom} · ${d.userAgent}</td>
                    <td class="sub">
                      ${u?.lastUsed ? `${when(u.lastUsed)} from ${u.lastFrom ?? "?"}` : "never"}
                    </td>
                    <td>
                      ${v.may ? html`<a class="btn ghost" href="${revokeHref(d)}">Revoke</a>` : ""}
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>`
          : html`<p class="sub">No device is approved yet.</p>`
      }
    </div>
    <div class="card scroll" id="events" style="margin-top:14px">
      <h2>Recent sign-ins, failures and refusals</h2>
      ${
        v.events.length
          ? html`<table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>From</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                ${v.events.slice(0, 100).map(
                  (e) =>
                    html`<tr>
                      <td class="sub">${when(e.at)}</td>
                      <td>${e.user}</td>
                      <td class="sub">${e.from}</td>
                      <td>
                        ${e.kind === "access" ? "" : html`<span class="pill ${e.kind === "sign-in" ? "ok" : "bad"}">${e.kind}</span> `}${e.detail}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="sub">Nothing yet.</p>`
      }
    </div>
    ${diagram(accessDiagram(v.names?.domain), "A device is trusted only once a signer's signed commit says so.")}
  `;
}
