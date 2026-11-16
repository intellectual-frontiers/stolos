/**
 * Spec 100: the devices that may sign in to the Stolos Console, and the codes waiting for a
 * signer's approval.
 *
 * - `fleets/<fleet>/access.ts` lists the approved devices (FR-005): public keys only, written by
 *   `stolos devices approve` and `stolos devices revoke` in one fixed form (a typed literal) and
 *   read back without running it (`exportedLiteral`), so a past version from `git show` is safe to
 *   read.
 * - A pending registration (FR-004) lives in the console's memory for 15 minutes under an
 *   8-character code (spec 098's alphabet): nothing is written before a signer approves.
 * - The local record (`console-access.json` in this PC's state, never Git): the tip last honoured,
 *   each device's signature counter and last sign-in, the last digest, and the listener.
 *
 * @module
 */

import { exportedLiteral, tsLiteral } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { newCode, normalizeCode } from "../adopt/pair.ts";
import type { ConsoleDevice } from "../model/types.ts";

/** How long a pending registration waits for a signer (15 minutes). */
export const PENDING_TTL_MS = 15 * 60_000;

/** How many days without a sign-in make a device due for review (FR-010, FR-012). */
export const UNUSED_DAYS = 90;

/** `fleets/<fleet>/access.ts` in a fleet folder. */
export function accessFile(fleetDir: string): string {
  return path.join(fleetDir, "access.ts");
}

/** The repository path of a fleet's access.ts (for `git show <tip>:<path>`). */
export function accessRepoPath(fleetId: string): string {
  return `fleets/${fleetId}/access.ts`;
}

/** The fixed form of access.ts: what Stolos writes. */
export function accessSource(list: readonly ConsoleDevice[]): string {
  const sorted = [...list].sort(
    (a, b) => a.signer.localeCompare(b.signer) || a.registered.localeCompare(b.registered),
  );
  return `/**
 * Written by stolos devices approve and stolos devices revoke (spec 100): the devices that may sign
 * in to the Stolos Console with their passkey (public keys only). A change here counts only in a
 * commit signed by a fleet signer, on GitHub.
 *
 * @module
 */
import type { ConsoleDevice } from "@intellectual-frontiers/stolos/archon/model/types";

export const access: ConsoleDevice[] = ${tsLiteral(sorted.map((d) => ({ ...d, credential: { ...d.credential } })))};
`;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** The devices in an access.ts text ([] when it has none or is not in the fixed form). */
export function parseAccess(text: string): ConsoleDevice[] {
  const r = exportedLiteral(text, "access");
  if (r.kind !== "ok" || !Array.isArray(r.value)) return [];
  const out: ConsoleDevice[] = [];
  for (const v of r.value as unknown[]) {
    if (typeof v !== "object" || v === null) continue;
    const d = v as Record<string, unknown>;
    const c = d["credential"] as Record<string, unknown> | undefined;
    if (
      !isStr(d["id"]) ||
      !isStr(d["signer"]) ||
      !isStr(d["name"]) ||
      !c ||
      !isStr(c["id"]) ||
      !isStr(c["publicKey"]) ||
      typeof c["alg"] !== "number"
    ) {
      continue;
    }
    const transports = Array.isArray(c["transports"])
      ? (c["transports"] as unknown[]).filter(isStr)
      : undefined;
    out.push({
      id: d["id"],
      signer: d["signer"],
      name: d["name"],
      credential: {
        id: c["id"],
        publicKey: c["publicKey"],
        alg: c["alg"],
        ...(transports ? { transports } : {}),
      },
      backedUp: d["backedUp"] === true,
      registered: isStr(d["registered"]) ? d["registered"] : "",
      approvedBy: isStr(d["approvedBy"]) ? d["approvedBy"] : "",
      registeredFrom: isStr(d["registeredFrom"]) ? d["registeredFrom"] : "",
      userAgent: isStr(d["userAgent"]) ? d["userAgent"] : "",
    });
  }
  return out;
}

/** A device's id from its credential's id: its first 16 characters (what revoke takes). */
export function deviceId(credentialId: string): string {
  return credentialId.slice(0, 16);
}

/** A name for a device from its browser's User-Agent ("iPhone (Safari)"). */
export function defaultDeviceName(ua: string): string {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows PC"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux PC"
              : "This device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${os} (${browser})` : os;
}

/** A registration waiting for a signer (FR-004): its public fields and its code. */
export interface Pending {
  /** The code, shown as two groups of four (WDJB-MJHT). */
  code: string;
  /** The signer the person picked. */
  signer: string;
  /** The device's name. */
  deviceName: string;
  /** The verified passkey's public half. */
  credential: ConsoleDevice["credential"];
  /** A synced passkey. */
  backedUp: boolean;
  /** The address it registered from. */
  from: string;
  /** Its User-Agent. */
  userAgent: string;
  /** When (ISO). */
  created: string;
  /** When it stops waiting (ISO). */
  expires: string;
}

/** The device a pending registration becomes once `approvedBy` approves it. */
export function deviceOf(p: Pending, approvedBy: string): ConsoleDevice {
  return {
    id: deviceId(p.credential.id),
    signer: p.signer,
    name: p.deviceName,
    credential: p.credential,
    backedUp: p.backedUp,
    registered: p.created,
    approvedBy,
    registeredFrom: p.from,
    userAgent: p.userAgent,
  };
}

/** The pending registrations, in memory, each for 15 minutes. */
export class PendingStore {
  #all = new Map<string, Pending>();
  #now: () => number;
  /** None yet; `now` is the clock (tests move it). */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** Keep a verified registration under a new code; returns it. */
  add(p: Omit<Pending, "code" | "created" | "expires">): Pending {
    let code = newCode();
    while (this.#all.has(normalizeCode(code))) code = newCode();
    const t = this.#now();
    const full: Pending = {
      ...p,
      code,
      created: new Date(t).toISOString(),
      expires: new Date(t + PENDING_TTL_MS).toISOString(),
    };
    this.#all.set(normalizeCode(code), full);
    return full;
  }
  /** The registration under a code as typed, unless it expired. */
  get(code: string): Pending | undefined {
    const k = normalizeCode(code);
    const p = this.#all.get(k);
    if (p && Date.parse(p.expires) <= this.#now()) {
      this.#all.delete(k);
      return undefined;
    }
    return p;
  }
  /** Drop a code (denied, or approved and honoured); the registration it held. */
  drop(code: string): Pending | undefined {
    const k = normalizeCode(code);
    const p = this.#all.get(k);
    this.#all.delete(k);
    return p;
  }
  /** Every registration still waiting. */
  list(): Pending[] {
    return [...this.#all.keys()].flatMap((k) => {
      const p = this.get(k);
      return p ? [p] : [];
    });
  }
}

/** One device's use, on this controller. */
export interface DeviceUse {
  /** The authenticator's signature counter last seen. */
  signCount: number;
  /** When it last signed in (ISO). */
  lastUsed?: string;
  /** From where. */
  lastFrom?: string;
}

/** This controller's own record of remote access (local state, not Git). */
export interface AccessState {
  /** The tip of the fleet's branch whose access.ts is honoured. */
  tip?: string;
  /** The devices of that tip. */
  devices?: ConsoleDevice[];
  /** Each device's use, by id. */
  use?: Record<string, DeviceUse>;
  /** When the last daily digest went out (ISO). */
  lastDigest?: string;
  /** The HTTPS listener while it serves: where, and the last heartbeat (ISO). */
  listening?: { address: string; port: number; at: string };
}

/** Where this PC keeps it, under its state folder. */
export function accessStatePath(stateDir: string): string {
  return path.join(stateDir, "console-access.json");
}

/** The record ({} when there is none). */
export async function readAccessState(file: string): Promise<AccessState> {
  try {
    return JSON.parse((await fs.readTextOr(file)) ?? "{}") as AccessState;
  } catch {
    return {};
  }
}

/** Write the record. */
export async function writeAccessState(file: string, s: AccessState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeTextFile(file, JSON.stringify(s, null, 2) + "\n");
}

/** Devices with no sign-in (or registration, when never used) for `days` days. */
export function unusedDevices(
  devices: readonly ConsoleDevice[],
  use: Record<string, DeviceUse>,
  now: number,
  days = UNUSED_DAYS,
): ConsoleDevice[] {
  return devices.filter((d) => {
    const last = use[d.id]?.lastUsed ?? d.registered;
    const t = Date.parse(last);
    return !Number.isFinite(t) || now - t > days * 86_400_000;
  });
}
