/**
 * Spec 098: `stolos pair`, on the controller PC. Shows the short line to run on a machine for each door that is up and a code, keeps
 * the pairing's record in a short-lived file (spec 103-three-ports), and asks the person to approve the machine before anything is
 * written to the fleet repository. The doors answer the machine from that file: the boot server's HTTP on TCP 8080 (when `boot serve`
 * runs; otherwise this command serves just the `/device/pair` routes there, no TFTP and no downloads), and the console's TLS on TCP 443
 * (when `stolos console --lan` serves and its name resolves to this PC). The person still approves here, in the terminal.
 *
 * @module
 */
// Spec: 097-controller FR-001
// Spec: 098-pair FR-001, FR-005, FR-006, FR-007, FR-008
// Spec: 103-three-ports FR-004, FR-005, FR-006, FR-008, FR-011
// Spec: 106-one-passphrase-speed FR-006

import { dns, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { compact, toBase64 } from "@intellectual-frontiers/commons/ts/kernel";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { choosePort, firewallRule, outsideStandardNote, standardPort } from "../core/listeners.ts";
import { DEVICE_PAIR_PATH, type PairingDoor } from "../ontology.auto.ts";
import { loadAdopted, MACHINE_NAME } from "./adopt.ts";
import { type Hello, newCode } from "./pair.ts";
import { type PairEnd, type PairRecord, type PairStore, newPairRecord } from "./pair-store.ts";
import { devicePairHandler, pairEngine, pairingStore } from "./pair-service.ts";

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** A way in that is up: which door, and the base URL a machine runs the line against. */
export interface DoorUp {
  /** The door (`tls` is the console's, `lan-http` the boot server's port). */
  door: PairingDoor;
  /** The pairing's base URL: `<origin>/device/pair`. */
  base: string;
  /** A word for the line: what serves it. */
  via: string;
}

/** What `findDoors` needs to know and ask (all injectable, so a test needs no network). */
export interface DoorQuery {
  /** The address a machine reaches this PC at on the boot server's port (or `--address`). */
  address: string;
  /** The port of door A (8080 unless the person chose another). */
  port: number;
  /** Door A is up: this command's own pair-only server bound it, or the boot server holds it and serves pairing. */
  httpUp: { via: string } | undefined;
  /** This PC's LAN addresses, to tell whether a name is this PC's. */
  addresses: readonly string[];
  /** The console's LAN names, in the order to prefer (empty: the fleet has no web domain). */
  names: readonly string[];
  /** The A records of a name. */
  resolve: (name: string) => Promise<readonly string[]>;
  /** Fetches a URL's text (certificate verified), or undefined where it cannot be reached. */
  fetchText: (url: string) => Promise<string | undefined>;
}

/** The first line of the POSIX script a door serves: how a door's answer is recognized as pairing's. */
export const SCRIPT_START = "#!/bin/sh";

/** The doors that are up, HTTPS first, and one short plain line for the door that is not (how to get it). */
export async function findDoors(q: DoorQuery): Promise<{ doors: DoorUp[]; notes: string[] }> {
  const doors: DoorUp[] = [];
  const notes: string[] = [];
  if (q.names.length === 0) {
    notes.push(
      "No HTTPS door: the console has no name (the fleet needs web.domain): see stolos console --lan",
    );
  } else {
    let why: string | undefined;
    for (const name of q.names) {
      const ips = await q.resolve(name).catch(() => [] as readonly string[]);
      if (!ips.some((a) => q.addresses.includes(a))) {
        why ??= `${name} does not resolve to this PC yet (${ips.join(", ") || "no address"})`;
        continue;
      }
      const base = `https://${name}${DEVICE_PAIR_PATH}`;
      if ((await q.fetchText(base))?.startsWith(SCRIPT_START)) {
        doors.push({ door: "tls", base, via: `the console's TLS, ${name}` });
        why = undefined;
      } else why = `${name} is this PC's, but the console does not answer there`;
      break;
    }
    if (why) notes.push(`No HTTPS door: ${why}: stolos console --lan`);
  }
  if (q.httpUp) {
    doors.push({
      door: "lan-http",
      base: `http://${q.address}:${q.port}${DEVICE_PAIR_PATH}`,
      via: q.httpUp.via,
    });
  }
  doors.sort((a, b) => Number(b.door === "tls") - Number(a.door === "tls"));
  return { doors, notes };
}

/** What `stolos pair` shows for the doors that are up: one line per door, HTTPS first, then the code and its expiry. */
export function pairInstructions(doors: readonly DoorUp[], code: string): string {
  const out: string[] = [""];
  doors.forEach((d, i) => {
    out.push(
      i === 0
        ? `  On the machine, run (${d.door === "tls" ? "HTTPS" : "plain HTTP"}: ${d.via}):`
        : `  or (${d.door === "tls" ? "HTTPS" : "plain HTTP"}: ${d.via}):`,
      `    Linux, macOS, WSL:   curl -fsSL ${d.base} | sh`,
      `    Windows (admin):     irm ${d.base}/w | iex`,
    );
  });
  out.push(
    "",
    `  Then type this code:   ${code}      (expires in 10 minutes)`,
    "",
    ...(doors.some((d) => d.door === "lan-http")
      ? [
          "  Plain HTTP on the boot server's port, on purpose: this LAN is trusted (Article 28). A machine",
          "  elsewhere joins over a zero trust mesh network (bun run stolos mesh), never over the internet.",
          "",
        ]
      : []),
  );
  return out.join("\n");
}

/**
 * The pair-only server: when boot serve is not running, `stolos pair` serves just the `/device/pair` routes on the boot server's port
 * (TCP 8080 unless `explicit` says another: no TFTP, no Ubuntu downloads, nothing else). Rejects where the port is taken.
 */
export async function startPairOnly(
  handle: (req: Request) => Promise<Response | undefined>,
  explicit?: number,
): Promise<{ port: number; explicit: boolean; close(): void }> {
  const { listen } = await import("../../archon-boot/http.ts");
  const choice = choosePort("boot-http", explicit);
  const l = await listen(
    choice.port,
    async (req) => (await handle(req)) ?? new Response("not found\n", { status: 404 }),
  );
  return {
    port: (l.addr as { port: number }).port,
    explicit: choice.explicit,
    close: () => l.close(),
  };
}

/** What a pairing run needs from outside (the real ones in `pair`; fakes in tests). */
export interface PairRun {
  /** The pairing's record's home. */
  store: PairStore;
  /** The record to write (its code, fleet and hints). */
  record: PairRecord;
  /** Brings the doors up and shows them; false where no door is up (nothing can be paired). */
  doors: () => Promise<boolean>;
  /** The person's decision on a machine's check-in (shows who asked, asks, adopts). */
  approve: (checkIn: string, hello: Hello) => Promise<{ ok: boolean; message: string }>;
  /** Stops what `doors` started (the pair-only server). */
  close: () => Promise<void>;
  /** Calls back when the person interrupts (Ctrl+C); returns what stops listening. */
  onInterrupt?: (cb: () => void) => () => void;
  /** Now, in milliseconds. */
  now?: () => number;
  /** How often the record is looked at (500 ms by default). */
  pollMs?: number;
  /** How long to wait for the door to tell the machine the decision before the record goes (3 s by default). */
  graceMs?: number;
}

/**
 * The terminal's part of a pairing: write the record, bring the doors up, then watch the record: when a machine's check-in is
 * waiting, ask the person (`approve`) and write the decision; end on a decision, on too many wrong tries, on expiry, on a record
 * another `stolos pair` replaced, or on Ctrl+C. Whatever ends it, the record is removed in `finally`.
 */
export async function runPairing(r: PairRun): Promise<PairEnd | "no-door"> {
  const now = r.now ?? Date.now;
  const poll = r.pollMs ?? 500;
  await r.store.create(r.record);
  let interrupted = false;
  const off = r.onInterrupt?.(() => {
    interrupted = true;
  });
  let end: PairEnd | "no-door";
  let decided = false;
  try {
    if (!(await r.doors())) return "no-door";
    let approving: Promise<void> | undefined;
    for (;;) {
      const cur = await r.store.read();
      if (!cur || cur.code !== r.record.code || interrupted) {
        end = "refused";
        break;
      }
      if (cur.ended) {
        end = cur.ended;
        break;
      }
      if (now() > cur.expiresAt) {
        end = "expired";
        break;
      }
      if (cur.checkIn && cur.hello && !cur.decision && !approving) {
        const hello = cur.hello;
        const text = cur.checkIn.text;
        approving = r
          .approve(text, hello)
          .catch((e: unknown) => ({ ok: false, message: `the PC could not decide: ${String(e)}` }))
          .then(async (d) => {
            await r.store.update((x) => {
              if (x.ended || x.decision) return;
              x.decision = d;
              x.ended = d.ok ? "paired" : "refused";
            });
            decided = true;
          });
      }
      await proc.sleep(poll);
    }
    return end;
  } finally {
    off?.();
    // Let the machine read the last answer before the door closes and the record goes.
    if (decided) {
      const until = now() + (r.graceMs ?? 3000);
      while (now() < until) {
        const cur = await r.store.read().catch(() => undefined);
        if (!cur || cur.delivered) break;
        await proc.sleep(Math.min(poll, 50));
      }
    }
    await r.close().catch(() => undefined);
    await r.store.remove().catch(() => undefined);
  }
}

/** `stolos pair [--name n] [--port 8080] [--address a]`: pair one machine with a short code. */
export async function pair(o: {
  name?: string;
  port?: number;
  address?: string;
  title?: string;
  owner?: string;
}): Promise<number> {
  const c = ui.phase("Pairing");
  if (o.name && !MACHINE_NAME.test(o.name)) {
    c.fail(`${o.name} is not a name (lowercase letters, digits, -)`, "for example: alice-laptop");
    return fail();
  }
  const { lanAddresses, preferAddress } = await import("../core/net.ts");
  preferAddress(o.address);
  const addresses = lanAddresses();
  const address = addresses[0];
  if (!address) {
    c.fail(
      "this PC has no LAN address to be reached at",
      "connect it to the network the machine is on (or a zero trust mesh network: bun run stolos mesh), or say which: --address <this-pc>",
    );
    return fail();
  }
  // Spec 097: this PC is a fleet machine too.
  await (await import("./controller.ts")).recordController();
  const choice = choosePort("boot-http", o.port);
  const code = newCode();
  const store = pairingStore();
  const handle = devicePairHandler(store);
  const record = newPairRecord({
    code,
    fleet: P.fleetId,
    engine: pairEngine(),
    ...compact({ name: o.name, owner: o.owner, title: o.title }),
  });
  let listener: { close(): void } | undefined;
  let port = choice.port;

  const doors = async (): Promise<boolean> => {
    // Door A: this command's own pair-only server on the boot server's port, else the boot server that holds it.
    let httpUp: DoorQuery["httpUp"];
    try {
      const started = await startPairOnly(handle, o.port);
      listener = started;
      port = started.port;
      httpUp = { via: `this command, on TCP ${port}` };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const body = await fetchText(`http://127.0.0.1:${choice.port}${DEVICE_PAIR_PATH}`);
      if (body?.startsWith(SCRIPT_START)) {
        httpUp = {
          via: `the boot server, on TCP ${choice.port} (it holds the port, and serves pairing)`,
        };
      } else {
        c.warn(
          `TCP ${choice.port} is not free for pairing${code ? ` (${code})` : ""}, and what holds it does not serve /device/pair`,
          choice.explicit
            ? "stop what uses it, or choose another: --port <n>"
            : "restart bun run stolos boot serve with this version, or stop what holds the port, or choose another: --port <n>",
        );
      }
    }
    // Door B: the console's TLS on its LAN names, when it is serving and the name is this PC's.
    const { loadFleet } = await import("../model/load.ts");
    const { consoleNames } = await import("../access/names.ts");
    const { controllerName } = await import("./controller.ts");
    const fleet = await loadFleet().catch(() => undefined);
    const n = fleet ? consoleNames(fleet, await controllerName()) : undefined;
    const found = await findDoors({
      address,
      port,
      httpUp,
      addresses,
      names: n ? (n.primary ? [n.base, n.own] : [n.own]) : [],
      resolve: resolveA,
      fetchText,
    });
    if (found.doors.length === 0) {
      c.fail(
        "no door is up: nothing can reach this PC to pair",
        `free TCP ${choice.port} (or choose another: --port <n>), or run bun run stolos console --lan`,
      );
      return false;
    }
    c.done(
      `${found.doors.map((d) => d.base).join(" · ")} · fleet ${P.fleetId} · one machine, for 10 minutes`,
    );
    for (const line of found.notes) c.note(line);
    // Read-only firewall checks, as actions (the exact command is in each line).
    const fw = ui.phase("Firewall");
    const { firewallWarnings } = await import("../../archon-boot/firewall.ts");
    const needs = found.doors.map((d) =>
      d.door === "tls"
        ? {
            protocol: "TCP" as const,
            port: standardPort("console-https"),
            what: "Stolos Console (HTTPS)",
          }
        : { protocol: "TCP" as const, port: choice.port, what: "Stolos pair (HTTP)" },
    );
    for (const w of await firewallWarnings(needs, { fresh: true })) {
      fw.action(w, "allow it, or the machine cannot reach this PC");
    }
    if (choice.explicit && found.doors.some((d) => d.door === "lan-http")) {
      fw.action(
        outsideStandardNote("tcp", choice.port),
        firewallRule(proc.build.os, "tcp", choice.port, "pair (HTTP)"),
      );
    }
    // The checks are done: close the phase before the instructions, so nothing spins under them.
    fw.done(fw.actions ? "see above" : "allows the pairing (or no firewall to check)");
    ui.pause();
    stdio.stdout.writeSync(pairInstructions(found.doors, code));
    ui.resume();
    // Now the command waits for the machine, and says so.
    const until = Date.now() + 10 * 60_000;
    w = ui.phase("Waiting");
    const say = (): void =>
      w?.status(
        `Waiting for a machine to run the line above (code expires in ${Math.max(1, Math.ceil((until - Date.now()) / 60_000))} minutes)`,
      );
    say();
    tick = proc.unrefTimer(say, 15_000);
    return true;
  };

  let w: ReturnType<typeof ui.phase> | undefined;
  let tick: { clear(): void } | undefined;
  let decision: { ok: boolean; message: string } | undefined;
  const end = await runPairing({
    store,
    record,
    doors,
    approve: async (text, hello) => (decision = await approve(text, hello, o)),
    close: () => {
      listener?.close();
      return Promise.resolve();
    },
    onInterrupt: (cb) => {
      proc.addSignalListener("SIGINT", cb);
      return () => proc.removeSignalListener("SIGINT", cb);
    },
  });
  tick?.clear();
  if (end === "no-door") return fail();
  endPairing(w ?? ui.phase("Waiting"), end, decision);
  return fail();
}

/**
 * How a pairing ends (spec 106-one-passphrase-speed FR-006): a pairing says what happened, in a line
 * that is always shown ("intrepid is adopted by the fleet lab"); a refusal, an expiry and too many
 * wrong codes are the failures they were.
 */
export function endPairing(
  wait: ReturnType<typeof ui.phase>,
  end: string,
  decision?: { ok: boolean; message: string },
): void {
  if (end === "paired") {
    wait.done("paired");
    ui.outcome(decision?.message ?? "the machine is adopted by the fleet");
  } else if (end === "expired") {
    wait.fail("the code expired; nothing was written", "bun run stolos pair");
  } else if (end === "tries") {
    wait.fail("5 wrong codes: the pairing ended; nothing was written", "bun run stolos pair");
  } else wait.warn("not approved; nothing was written", "bun run stolos pair");
}

/** A URL's text with the certificate checked, or undefined where it cannot be reached or does not answer 200. */
async function fetchText(url: string): Promise<string | undefined> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.text() : undefined;
  } catch {
    return undefined;
  }
}

/** A name's IPv4 addresses (the system's resolver), or none. */
async function resolveA(name: string): Promise<readonly string[]> {
  const r = await dns.resolveDns(name, "A");
  return r.kind === "ok" ? r.value : [];
}

/** Show who asked, ask the person, and adopt the machine when they say yes. */
async function approve(
  text: string,
  hello: Hello,
  o: { title?: string; owner?: string },
): Promise<{ ok: boolean; message: string }> {
  const { parseCheckIn } = await import("./checkin.ts");
  let ci;
  try {
    ci = parseCheckIn(`stolos1:${toBase64(new TextEncoder().encode(text))}`);
  } catch (e) {
    return { ok: false, message: `the PC could not read the check-in: ${(e as Error).message}` };
  }
  if (ci.fleet !== P.fleetId)
    return { ok: false, message: `this PC pairs for the fleet ${P.fleetId}` };
  if (!ci.hostKeys.length) {
    return { ok: false, message: "no SSH host keys were sent (is the SSH server on?)" };
  }
  const os = ci.observed ? `${ci.observed.os.name} ${ci.observed.os.version}`.trim() : "unknown OS";
  const fp = await proc.run(["ssh-keygen", "-lf", "-"], {
    input: `${ci.hostname} ${ci.hostKeys[0]}\n`,
  });
  const existing = (await loadAdopted()).some((a) => a.machine.name === hello.name);
  ui.pause();
  stdio.stdout.writeSync(
    `\n  ${hello.name} wants to join as an adopted machine${existing ? " (it replaces the one by that name)" : ""}\n` +
      `    ${os} · ${ci.user}@${ci.addresses.join(", ") || ci.hostname}${ci.macs[0] ? ` · ${ci.macs[0]}` : ""}\n` +
      `    SSH host key  ${fp.stdout.trim().split(/\s+/).slice(1, 2).join("") || ci.hostKeys[0]}\n` +
      (ci.kinds.includes("osquery") || ci.observed?.software.osquery
        ? `    osquery       ${ci.observed?.software.osquery ?? "asked for"}\n`
        : ""),
  );
  ui.resume();
  if (!(await ui.confirm("  Approve?"))) {
    return { ok: false, message: "the person at the PC did not approve it; nothing was kept" };
  }
  const { adoptCheckIn } = await import("./commands.ts");
  await adoptCheckIn(ci, { name: hello.name, spec: "098-pair", ...compact(o) });
  const failed = ui.problems.some((x) => x.level === "fail");
  return failed
    ? { ok: true, message: `${hello.name} is adopted, but the PC could not read its facts yet` }
    : { ok: true, message: `${hello.name} is adopted by the fleet ${P.fleetId}` };
}
