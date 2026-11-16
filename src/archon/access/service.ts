/**
 * Spec 100: remote access to the Stolos Console, on the controller. One object holds what the
 * HTTPS side needs between requests:
 *
 * - registration (FR-004): the options for a new passkey (the challenge kept here), its
 *   verification, and the pending code;
 * - the signed tip (FR-006): `git fetch`, then `checkTip` against the signers this checkout
 *   trusts, never an older tip than the last one honoured, then access.ts read from that tip;
 * - sign-in (FR-007): the options, the verification against access.ts's public keys, the counter
 *   and the last sign-in in local state, five failures a minute pausing an address;
 * - privileges (FR-009): who may sign here (their key is on this controller);
 * - audit (FR-011): every event to the activity record (kind `access`) and, at once, to the fleet's
 *   mailbox (best effort), with a daily digest of remote sign-ins and commands.
 *
 * @module
 */
// Spec: 100-remote-access FR-004, FR-006, FR-007, FR-009, FR-010, FR-011

import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { run, type RunResult } from "../core/exec.ts";
import type { ConsoleDevice, SignerDef } from "../model/types.ts";
import type { Event } from "../notify/notify.ts";
import { allowedSignersText, checkTip } from "../identity/signers.ts";
import { parseSignersSource } from "../identity/keys.ts";
import { Throttle } from "../console/auth.ts";
import type { ActivityEntry } from "../console/pages.ts";
import {
  type AccessState,
  accessRepoPath,
  type DeviceUse,
  parseAccess,
  type Pending,
  PendingStore,
  readAccessState,
  unusedDevices,
  writeAccessState,
} from "./devices.ts";
import type { ConsoleNames } from "./names.ts";
import type { Passkeys } from "./passkeys.ts";

/** How often the signed tip is read while a code waits (30 s), and otherwise (5 minutes). */
export const REFRESH_MS = { pending: 30_000, idle: 5 * 60_000 };

/** How long a challenge is good for (5 minutes). */
export const CHALLENGE_TTL_MS = 5 * 60_000;

/** How often a digest of remote use goes out (daily). */
export const DIGEST_MS = 24 * 3600_000;

/** What remote access needs: real on the controller, fakes in tests. */
export interface AccessDeps {
  /** The console's names. */
  names: ConsoleNames;
  /** The fleet: its id, title, and the branch servers follow. */
  fleet: { id: string; title: string; branch: string };
  /** The fleet repository (this controller's checkout). */
  repo: string;
  /** Signers whose daily or recovery key is on this controller (they may sign here). */
  localSigners: ReadonlySet<string>;
  /** WebAuthn. */
  passkeys: Passkeys;
  /** This controller's record (console-access.json). */
  statePath: string;
  /** The allowed_signers file this module writes for `checkTip` (from the checkout's signers.ts). */
  allowedFile: string;
  /** The activity record. */
  activity: { add(e: ActivityEntry): Promise<void>; recent(n: number): Promise<ActivityEntry[]> };
  /** The fleet's mail (best effort). */
  mail(ev: Event): Promise<unknown>;
  /** The clock. */
  now?: () => number;
  /** Git in the fleet repository (tests may pass their own). */
  git?: (args: string[]) => Promise<RunResult>;
}

/** Who a remote session is. */
export interface RemoteSession {
  /** The signer. */
  signer: string;
  /** The device's id and name. */
  device: { id: string; name: string };
  /** Where they signed in from. */
  from: string;
}

/** A challenge waiting for the browser's answer. */
interface Challenge {
  kind: "register" | "signin";
  challenge: string;
  expires: number;
  signer?: string;
  deviceName?: string;
  from: string;
  userAgent: string;
}

/** What the last read of the signed tip found. */
export interface TipRead {
  /** The tip honoured now (unchanged when nothing new or refused). */
  tip?: string;
  /** Why a newer tip was not honoured. */
  refused?: string;
  /** Devices added and removed by the newer tip. */
  added: ConsoleDevice[];
  /** Devices removed (revoked). */
  removed: ConsoleDevice[];
}

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const random = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The console's remote access on this controller. */
export class RemoteAccess {
  /** The registrations waiting for a signer. */
  readonly pending: PendingStore;
  /** Failed sign-ins per address. */
  readonly throttle: Throttle;
  readonly #d: AccessDeps;
  readonly #now: () => number;
  readonly #challenges = new Map<string, Challenge>();
  readonly #sessions = new Map<string, RemoteSession>();
  readonly #mailedFailures = new Map<string, number>();
  #state: AccessState = {};
  #loaded = false;
  #lastRead: TipRead = { added: [], removed: [] };

  /** Remote access with these dependencies (call {@link RemoteAccess.load} first). */
  constructor(d: AccessDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.pending = new PendingStore(this.#now);
    this.throttle = new Throttle(this.#now);
  }

  /** The names. */
  get names(): ConsoleNames {
    return this.#d.names;
  }

  /** Read the local record. */
  async load(): Promise<void> {
    this.#state = await readAccessState(this.#d.statePath);
    this.#loaded = true;
  }

  async #save(): Promise<void> {
    await writeAccessState(this.#d.statePath, this.#state);
  }

  /** The local record, as last read or written. */
  get state(): AccessState {
    return this.#state;
  }

  /** The devices honoured now (from the last signed tip). */
  devices(): ConsoleDevice[] {
    return this.#state.devices ?? [];
  }

  /** Each device's use on this controller. */
  use(): Record<string, DeviceUse> {
    return this.#state.use ?? {};
  }

  /** What the last read of the signed tip found. */
  lastRead(): TipRead {
    return this.#lastRead;
  }

  /** Whether a signer may sign here (their key is on this controller), FR-009. */
  maySign(signer: string): boolean {
    return this.#d.localSigners.has(signer);
  }

  /** The signers whose key is on this controller. */
  localSigners(): string[] {
    return [...this.#d.localSigners].sort();
  }

  /** The remote session with this id, if it is one. */
  session(id: string): RemoteSession | undefined {
    return this.#sessions.get(id);
  }

  /** Forget a session (signed out). */
  endSession(id: string): void {
    this.#sessions.delete(id);
  }

  async #event(
    who: string,
    from: string,
    detail: string,
    mail?: Omit<Event, "what"> & { what?: string },
    kind: ActivityEntry["kind"] = "access",
  ): Promise<void> {
    await this.#d.activity.add({
      at: new Date(this.#now()).toISOString(),
      user: who,
      from,
      kind,
      detail,
    });
    if (mail) {
      // Best effort: mail never blocks or fails what it reports.
      void this.#d.mail({ what: mail.what ?? detail, ...mail }).catch(() => undefined);
    }
  }

  #challenge(c: Omit<Challenge, "challenge" | "expires">): { ticket: string; challenge: string } {
    const now = this.#now();
    for (const [k, v] of this.#challenges) if (v.expires <= now) this.#challenges.delete(k);
    const ticket = random(18);
    const challenge = random(32);
    this.#challenges.set(ticket, { ...c, challenge, expires: now + CHALLENGE_TTL_MS });
    return { ticket, challenge };
  }

  #take(ticket: string, kind: Challenge["kind"]): Challenge | undefined {
    const c = this.#challenges.get(ticket);
    this.#challenges.delete(ticket);
    return c && c.kind === kind && c.expires > this.#now() ? c : undefined;
  }

  /** FR-004: the options to create a passkey for `signer` on a device called `deviceName`. */
  registerOptions(o: {
    signer: string;
    deviceName: string;
    signers: readonly SignerDef[];
    from: string;
    userAgent: string;
  }): { ticket: string; options: unknown } | { error: string } {
    if (!o.signers.some((s) => s.name === o.signer)) return { error: "no such signer" };
    const deviceName = o.deviceName
      .trim()
      .replace(/\p{Cc}/gu, "")
      .slice(0, 60);
    if (!deviceName) return { error: "name this device" };
    const { ticket, challenge } = this.#challenge({
      kind: "register",
      signer: o.signer,
      deviceName,
      from: o.from,
      userAgent: o.userAgent.slice(0, 300),
    });
    const enc = new TextEncoder();
    return {
      ticket,
      options: this.#d.passkeys.registrationOptions({
        rpId: this.#d.names.domain,
        rpName: `${this.#d.fleet.title}: Stolos Console`,
        user: { id: b64url(enc.encode(o.signer)), name: o.signer, displayName: o.signer },
        challenge,
        excludeCredentials: this.devices()
          .filter((d) => d.signer === o.signer)
          .map((d) => d.credential.id),
      }),
    };
  }

  /** FR-004: verify the new passkey and keep the registration under a code. */
  async registerFinish(o: {
    ticket: string;
    response: unknown;
    origin: string;
  }): Promise<{ pending: Pending } | { error: string }> {
    const c = this.#take(o.ticket, "register");
    if (!c?.signer || !c.deviceName) return { error: "that request expired: start again" };
    const v = await this.#d.passkeys.verifyRegistration({
      response: o.response,
      expectedChallenge: c.challenge,
      expectedOrigin: o.origin,
      rpId: this.#d.names.domain,
    });
    if (v.kind === "err") {
      await this.#event(c.signer, c.from, `registration refused: ${v.error}`, undefined, "refused");
      return { error: `the passkey was not accepted: ${v.error}` };
    }
    const p = this.pending.add({
      signer: c.signer,
      deviceName: c.deviceName,
      credential: {
        id: v.value.credentialId,
        publicKey: v.value.publicKey,
        alg: v.value.alg,
        ...(v.value.transports?.length ? { transports: v.value.transports } : {}),
      },
      backedUp: v.value.backedUp,
      from: c.from,
      userAgent: c.userAgent,
    });
    await this.#event(
      c.signer,
      c.from,
      `device registered, waiting for a signer: ${p.deviceName} (code ${p.code})`,
      {
        event: `Stolos Console: ${p.deviceName} wants to sign in as ${p.signer}`,
        level: "warn",
        what: [
          `A device registered a passkey for the Stolos Console of ${this.#d.fleet.title}.`,
          `Signer: ${p.signer}`,
          `Device: ${p.deviceName} (${p.backedUp ? "synced passkey" : "device-bound passkey"})`,
          `From: ${p.from}`,
          `Browser: ${p.userAgent}`,
          `Code: ${p.code} (waits until ${p.expires})`,
        ].join("\n"),
        todo: `If you expect it, a signer approves it: bun run stolos devices approve ${p.code}. If not, deny it on the Remote Access page; it expires in 15 minutes.`,
        key: `access-pending-${p.code}`,
      },
    );
    this.#refreshSoon?.();
    return { pending: p };
  }

  /** A code's state for its waiting page: waiting, approved (sign in now), or gone. */
  status(code: string): "waiting" | "approved" | "gone" {
    const p = this.pending.get(code);
    if (!p) return "gone";
    return this.devices().some((d) => d.credential.id === p.credential.id) ? "approved" : "waiting";
  }

  /** FR-005: deny a code: it is dropped and recorded. */
  async deny(code: string, by: string, from: string): Promise<boolean> {
    const p = this.pending.drop(code);
    if (!p) return false;
    await this.#event(by, from, `denied ${p.deviceName} for ${p.signer} (code ${p.code})`, {
      event: `Stolos Console: ${by} denied ${p.deviceName} for ${p.signer}`,
      what: `${by} denied the device "${p.deviceName}" (${p.from}, ${p.userAgent}) that asked to sign in as ${p.signer}.`,
      key: `access-denied-${p.code}`,
    });
    return true;
  }

  /** FR-007: the options to sign in with a passkey (any approved device). */
  signinOptions(
    from: string,
    userAgent: string,
  ): { ticket: string; options: unknown } | { error: string } {
    if (!this.throttle.allowed(from)) return { error: "too many tries: wait a minute" };
    if (!this.devices().length) return { error: "no device is approved yet" };
    const { ticket, challenge } = this.#challenge({ kind: "signin", from, userAgent });
    return {
      ticket,
      options: this.#d.passkeys.authenticationOptions({
        rpId: this.#d.names.domain,
        challenge,
        allowCredentials: this.devices().map((d) => d.credential.id),
      }),
    };
  }

  async #failed(from: string, why: string): Promise<{ error: string }> {
    this.throttle.failed(from);
    await this.#event(from, from, why, undefined, "sign-in failed");
    if (!this.throttle.allowed(from)) {
      const last = this.#mailedFailures.get(from) ?? 0;
      if (this.#now() - last > 60_000) {
        this.#mailedFailures.set(from, this.#now());
        await this.#event(from, from, "five failed sign-ins in a minute: address paused", {
          event: `Stolos Console: five failed sign-ins from ${from}`,
          level: "warn",
          what: `Five sign-ins to the Stolos Console failed from ${from} within a minute; that address is paused for a minute. The last: ${why}.`,
          todo: "If this was not you, look at the Remote Access page and revoke any device you do not know.",
          key: `access-failures-${from}`,
        });
      }
    }
    return { error: "not signed in" };
  }

  /** FR-007: verify a sign-in; the device and the session's owner when it is good. */
  async signinFinish(o: {
    ticket: string;
    response: unknown;
    origin: string;
    from: string;
  }): Promise<{ device: ConsoleDevice } | { error: string }> {
    if (!this.throttle.allowed(o.from)) return { error: "too many tries: wait a minute" };
    const c = this.#take(o.ticket, "signin");
    if (!c) return await this.#failed(o.from, "an expired or unknown sign-in request");
    const id =
      typeof o.response === "object" && o.response !== null && "id" in o.response
        ? String(o.response.id)
        : "";
    const device = this.devices().find((d) => d.credential.id === id);
    if (!device) return await this.#failed(o.from, "a passkey that is not approved (or revoked)");
    const use = this.use()[device.id] ?? { signCount: 0 };
    const v = await this.#d.passkeys.verifyAuthentication({
      response: o.response,
      expectedChallenge: c.challenge,
      expectedOrigin: o.origin,
      rpId: this.#d.names.domain,
      credential: { ...device.credential, signCount: use.signCount },
    });
    if (v.kind === "err") return await this.#failed(o.from, `${device.name}: ${v.error}`);
    this.throttle.succeeded(o.from);
    this.#state.use = {
      ...this.use(),
      [device.id]: {
        signCount: v.value.signCount,
        lastUsed: new Date(this.#now()).toISOString(),
        lastFrom: o.from,
      },
    };
    await this.#save();
    await this.#event(device.signer, o.from, `passkey: ${device.name}`, undefined, "sign-in");
    return { device };
  }

  /** Remember a remote session (after a good sign-in). */
  bind(sessionId: string, device: ConsoleDevice, from: string): RemoteSession {
    const s = { signer: device.signer, device: { id: device.id, name: device.name }, from };
    this.#sessions.set(sessionId, s);
    return s;
  }

  #refreshSoon: (() => void) | undefined;

  /** Called when a code is added, so the watcher reads GitHub sooner (set by the timer). */
  onPending(f: (() => void) | undefined): void {
    this.#refreshSoon = f;
  }

  #git(args: string[]): Promise<RunResult> {
    return this.#d.git ? this.#d.git(args) : run(["git", "-C", this.#d.repo, ...args]);
  }

  /**
   * FR-006: fetch the fleet's branch and honour access.ts from its tip when a signer this checkout
   * trusts signed it and it comes after the tip honoured last. Devices of signers no longer listed
   * are dropped. Mails what changed (approved, revoked).
   */
  async refresh(o: { fetch?: boolean } = {}): Promise<TipRead> {
    if (!this.#loaded) await this.load();
    const branch = this.#d.fleet.branch;
    if (o.fetch !== false) await this.#git(["fetch", "--quiet", "origin", branch]);
    const tip = (await this.#git(["rev-parse", `origin/${branch}`])).stdout.trim();
    const read: TipRead = {
      added: [],
      removed: [],
      ...(this.#state.tip ? { tip: this.#state.tip } : {}),
    };
    if (!tip || tip === this.#state.tip) return (this.#lastRead = read);
    const signersText = (await this.#git(["show", `HEAD:fleets/${this.#d.fleet.id}/signers.ts`]))
      .stdout;
    const signers = parseSignersSource(signersText);
    await fs.mkdir(path.dirname(this.#d.allowedFile), { recursive: true });
    await fs.writeTextFile(this.#d.allowedFile, allowedSignersText(signers));
    const t = await checkTip(this.#d.repo, tip, this.#state.tip ?? "", this.#d.allowedFile);
    if (!t.ok) {
      read.refused = t.reason ?? "not signed by a signer";
      return (this.#lastRead = read);
    }
    const shown = await this.#git(["show", `${tip}:${accessRepoPath(this.#d.fleet.id)}`]);
    const names = new Set(signers.map((s) => s.name));
    const now = shown.ok ? parseAccess(shown.stdout).filter((d) => names.has(d.signer)) : [];
    const before = this.devices();
    read.added = now.filter((d) => !before.some((b) => b.id === d.id));
    read.removed = before.filter((b) => !now.some((d) => d.id === b.id));
    read.tip = tip;
    this.#state.tip = tip;
    this.#state.devices = now;
    await this.#save();
    for (const d of read.added) {
      await this.#event(
        d.approvedBy,
        "GitHub",
        `approved ${d.name} for ${d.signer} (signed by ${t.signer ?? "a signer"})`,
        {
          event: `Stolos Console: ${d.name} approved for ${d.signer}`,
          what: `${d.approvedBy} approved the device "${d.name}" (${d.backedUp ? "synced passkey" : "device-bound passkey"}, registered from ${d.registeredFrom}) to sign in as ${d.signer}, in a commit signed by ${t.signer ?? "a signer"} (${tip.slice(0, 10)}).`,
          key: `access-approved-${d.id}`,
        },
      );
    }
    for (const d of read.removed) {
      for (const [id, s] of this.#sessions) if (s.device.id === d.id) this.#sessions.delete(id);
      await this.#event(t.signer ?? "a signer", "GitHub", `revoked ${d.name} of ${d.signer}`, {
        event: `Stolos Console: ${d.name} of ${d.signer} revoked`,
        what: `The device "${d.name}" may no longer sign in as ${d.signer}: removed in a commit signed by ${t.signer ?? "a signer"} (${tip.slice(0, 10)}).`,
        key: `access-revoked-${d.id}`,
      });
    }
    return (this.#lastRead = read);
  }

  /** Whether the remote session of `sessionId` still has an approved device (a revoke ends it). */
  live(sessionId: string): boolean {
    const s = this.#sessions.get(sessionId);
    return !s || this.devices().some((d) => d.id === s.device.id);
  }

  /** Devices with no sign-in for 90 days (FR-010). */
  unused(): ConsoleDevice[] {
    return unusedDevices(this.devices(), this.use(), this.#now());
  }

  /** Record where the HTTPS listener serves, and its latest heartbeat (for the doctor). */
  async listening(l: { address: string; port: number } | undefined): Promise<void> {
    if (l) this.#state.listening = { ...l, at: new Date(this.#now()).toISOString() };
    else delete this.#state.listening;
    await this.#save();
  }

  /**
   * FR-011: the daily digest of remote sign-ins and commands since the last one, sent at most once
   * a day (the last digest's time is kept, so a restart does not send it again). Returns whether
   * one was sent.
   */
  async digest(): Promise<boolean> {
    if (!this.#loaded) await this.load();
    const now = this.#now();
    const last = this.#state.lastDigest ? Date.parse(this.#state.lastDigest) : 0;
    if (last && now - last < DIGEST_MS) return false;
    const since = last || now - DIGEST_MS;
    const entries = (await this.#d.activity.recent(100_000)).filter(
      (e) =>
        Date.parse(e.at) > since &&
        e.from !== "this PC" &&
        e.from !== "audit link" &&
        e.from !== "GitHub" &&
        (e.kind === "sign-in" || e.kind === "run"),
    );
    this.#state.lastDigest = new Date(now).toISOString();
    await this.#save();
    if (!entries.length) return false;
    await this.#d
      .mail({
        event: `Stolos Console: remote use, ${entries.length} event(s) in the last day`,
        what: digestText(entries),
        key: `access-digest-${this.#state.lastDigest.slice(0, 10)}`,
      })
      .catch(() => undefined);
    return true;
  }
}

/** The digest's body: one line per sign-in or command (when, who, from, what). */
export function digestText(entries: readonly ActivityEntry[]): string {
  return [
    "Sign-ins and commands from devices other than this PC (spec 100):",
    "",
    ...[...entries]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(
        (e) =>
          `${e.at.slice(0, 16).replace("T", " ")}  ${e.user}  from ${e.from}  ${
            e.kind === "sign-in"
              ? `signed in (${e.detail})`
              : `ran: ${e.detail}${e.code ? ` (exit ${e.code})` : ""}`
          }`,
      ),
  ].join("\n");
}
