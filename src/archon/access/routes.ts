/**
 * Spec 100: the console's requests that come before a session, on its HTTPS names (and, for a
 * signer's `devices approve` on this PC, on 127.0.0.1):
 *
 * - `GET /access/pending/<code>`: a pending registration's public fields, as JSON (FR-005);
 * - `GET /access/status/<code>`: waiting, approved or gone, for the waiting page (FR-006);
 * - `POST /access/register/options` and `/finish`: a new passkey (FR-004);
 * - `POST /access/signin/options` and `/finish`: a sign-in (FR-007).
 *
 * POSTs are JSON from this origin only. Wrong codes count against the address like failed
 * sign-ins.
 *
 * @module
 */

import type { ConsoleDevice, SignerDef } from "../model/types.ts";
import { defaultDeviceName } from "./devices.ts";
import type { RemoteAccess } from "./service.ts";

/** What these routes need from the console. */
export interface AccessRouteDeps {
  /** Remote access. */
  access: RemoteAccess;
  /** The fleet's signers. */
  signers(): Promise<SignerDef[]>;
  /** Start a session for a device that signed in; its Set-Cookie value. */
  startSession(device: ConsoleDevice, from: string): string;
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v) + "\n", {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/** The browser's origin for this request (what WebAuthn's client data names). */
export function originOf(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${req.headers.get("host") ?? u.host}`;
}

async function body(req: Request): Promise<Record<string, unknown> | undefined> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return undefined;
  const text = await req.text();
  if (text.length > 64_000) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Answer one of the routes above, or undefined when the path is not one of them. */
export async function accessRoute(
  req: Request,
  from: string,
  d: AccessRouteDeps,
): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  const a = d.access;
  if (req.method === "GET") {
    const pending = path.match(/^\/access\/pending\/([A-Za-z0-9-]{8,12})$/)?.[1];
    if (pending) {
      if (!a.throttle.allowed(from)) return json({ error: "too many tries: wait a minute" }, 429);
      const p = a.pending.get(pending);
      if (!p) {
        a.throttle.failed(from);
        return json({ error: "no such code (or it expired)" }, 404);
      }
      return json(p);
    }
    const status = path.match(/^\/access\/status\/([A-Za-z0-9-]{8,12})$/)?.[1];
    if (status) return json({ status: a.status(status) });
    return undefined;
  }
  if (req.method !== "POST" || !path.startsWith("/access/")) return undefined;
  const origin = req.headers.get("origin");
  if (origin && origin !== originOf(req)) return json({ error: "cross-site request refused" }, 403);
  const b = await body(req);
  if (!b) return json({ error: "a JSON body, please" }, 400);
  const ua = req.headers.get("user-agent") ?? "";
  if (path === "/access/register/options") {
    const r = a.registerOptions({
      signer: str(b["signer"]),
      deviceName: str(b["name"]) || defaultDeviceName(ua),
      signers: await d.signers(),
      from,
      userAgent: ua,
    });
    return "error" in r ? json(r, 400) : json(r);
  }
  if (path === "/access/register/finish") {
    const r = await a.registerFinish({
      ticket: str(b["ticket"]),
      response: b["response"],
      origin: originOf(req),
    });
    return "error" in r ? json(r, 400) : json({ code: r.pending.code, expires: r.pending.expires });
  }
  if (path === "/access/signin/options") {
    const r = a.signinOptions(from, ua);
    return "error" in r ? json(r, 400) : json(r);
  }
  if (path === "/access/signin/finish") {
    const r = await a.signinFinish({
      ticket: str(b["ticket"]),
      response: b["response"],
      origin: originOf(req),
      from,
    });
    if ("error" in r) return json(r, 401);
    return json({ ok: true }, 200, { "set-cookie": d.startSession(r.device, from) });
  }
  return undefined;
}
