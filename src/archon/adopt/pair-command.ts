/**
 * Specs 098 and 107-pairing-and-query: `stolos pair`, on the controller PC. Shows the short line to run on a machine for each door
 * that is up and a code the same for every machine, keeps the session's record in a short-lived file (spec 103-three-ports), and asks
 * the person to approve each machine, one after another, before anything is written to the fleet repository. The session stays open
 * until the person stops it (Ctrl+C). The doors answer the machines from that file: the boot server's HTTP on TCP 8080 (when `boot serve`
 * runs; otherwise this command serves just the `/device/pair` routes there, no TFTP and no downloads), and the console's TLS on TCP 443
 * (when `stolos console --lan` serves and its name resolves to this PC). The person still approves here, in the terminal.
 *
 * @module
 */
// Spec: 097-controller FR-001
// Spec: 098-pair FR-001, FR-005, FR-006, FR-007, FR-008
// Spec: 103-three-ports FR-004, FR-005, FR-006, FR-008, FR-011
// Spec: 106-one-passphrase-speed FR-006
// Spec: 107-pairing-and-query FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007
// Spec: 108-tags FR-008

import { dns, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { compact } from "@intellectual-frontiers/core";
import { toBase64 } from "@intellectual-frontiers/formats";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { choosePort, firewallRule, outsideStandardNote, standardPort } from "../core/listeners.ts";
import { DEVICE_PAIR_PATH, type PairingDoor } from "../ontology.auto.ts";
import { loadAdopted, MACHINE_NAME } from "./adopt.ts";
import { type Hello, newCode } from "./pair.ts";
import {
  blockedAddresses,
  machinesOf,
  type PairMachine,
  type PairRecord,
  type PairStore,
  newPairRecord,
} from "./pair-store.ts";
import type { PairingStage } from "../ontology.auto.ts";
import { devicePairHandler, pairEngine, pairingStore } from "./pair-service.ts";
import { addAssigned, classifyTag, tokensOf, type TagSet } from "../model/tags.ts";

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

/** What the terminal says for each stage a machine passes through (`stolos:PairingStage`). */
export const STAGE_WORDS: Record<PairingStage, string> = {
  hello: "said hello",
  installing: "is installing",
  waiting: "is waiting for you",
  adopted: "is adopted",
  refused: "was refused",
};

/** What `stolos pair` shows for the doors that are up: one line per door, HTTPS first, then the code and what the open session means. */
export function pairInstructions(doors: readonly DoorUp[], code: string): string {
  const out: string[] = [""];
  doors.forEach((d, i) => {
    out.push(
      i === 0
        ? `  On each machine, run (${d.door === "tls" ? "HTTPS" : "plain HTTP"}: ${d.via}):`
        : `  or (${d.door === "tls" ? "HTTPS" : "plain HTTP"}: ${d.via}):`,
      `    Linux, macOS, WSL:   curl -fsSL ${d.base} | sh`,
      `    Windows (admin):     irm ${d.base}/w | iex`,
    );
  });
  out.push(
    "",
    `  Then type this code:   ${code}      (the same for every machine)`,
    "",
    "  Session is open: Ctrl+C closes it. Any machine on this network that has the code can ask to",
    "  join, and you answer each one here, one after another. Nothing is adopted without your yes.",
    "  An open session is less safe than a short one: close it when the machines you expect have joined.",
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
  handle: (req: Request, from?: string) => Promise<Response | undefined>,
  explicit?: number,
): Promise<{ port: number; explicit: boolean; close(): void }> {
  const { listen } = await import("../../archon-boot/http.ts");
  const choice = choosePort("boot-http", explicit);
  const l = await listen(
    choice.port,
    async (req, from) => (await handle(req, from)) ?? new Response("not found\n", { status: 404 }),
  );
  return {
    port: (l.addr as { port: number }).port,
    explicit: choice.explicit,
    close: () => l.close(),
  };
}

/** What a pairing session needs from outside (the real ones in `pair`; fakes in tests). */
export interface PairRun {
  /** The session's record's home. */
  store: PairStore;
  /** The record to write (its code, fleet and hints). */
  record: PairRecord;
  /** Brings the doors up and shows them; false where no door is up (nothing can be paired). */
  doors: () => Promise<boolean>;
  /** The person's decision on one machine's check-in (shows who asked, asks, adopts). Called for one machine at a time. */
  approve: (checkIn: string, hello: Hello) => Promise<{ ok: boolean; message: string }>;
  /** Stops what `doors` started (the pair-only server). */
  close: () => Promise<void>;
  /** Calls back when the person interrupts (Ctrl+C); returns what stops listening. */
  onInterrupt?: (cb: () => void) => () => void;
  /** Called with the record each time it is looked at (the terminal shows what changed in it). */
  onState?: (record: PairRecord) => void;
  /** How often the record is looked at (500 ms by default). */
  pollMs?: number;
  /** How long to wait for the doors to tell the machines their decisions before the record goes (3 s by default). */
  graceMs?: number;
  /** Now, in milliseconds. */
  now?: () => number;
}

/** What a session came to when it closed. */
export interface PairSummary {
  /** Why it ended: the person closed it (or the record was replaced), or no door was up. */
  end: "closed" | "no-door";
  /** The machines adopted, refused, and still waiting when it closed. */
  adopted: PairMachine[];
  /** The machines the person refused. */
  refused: PairMachine[];
  /** The machines that had said hello and were not decided. */
  waiting: PairMachine[];
  /** The client addresses refused for sending 5 wrong codes. */
  blocked: string[];
}

/**
 * The terminal's part of a pairing session: write the record, bring the doors up, then watch the record: whenever a machine's check-in
 * is waiting, ask the person about it (`approve`, one machine at a time, in the order they came) and write the decision. The session
 * has no end of its own: it lasts until the person interrupts (Ctrl+C) or another `stolos pair` replaces the record. Whatever ends it,
 * the doors are closed and the record is removed in `finally`.
 */
export async function runPairing(r: PairRun): Promise<PairSummary> {
  const now = r.now ?? Date.now;
  const poll = r.pollMs ?? 500;
  await r.store.create(r.record);
  let interrupted = false;
  const off = r.onInterrupt?.(() => {
    interrupted = true;
  });
  let last: PairRecord = r.record;
  let up = false;
  try {
    if (await r.doors()) {
      up = true;
      let approving: Promise<void> | undefined;
      for (;;) {
        const cur = await r.store.read();
        if (!cur || cur.code !== r.record.code || interrupted || cur.ended) break;
        last = cur;
        r.onState?.(cur);
        const next = approving
          ? undefined
          : machinesOf(cur).find((m) => m.stage === "waiting" && m.checkIn && !m.decision);
        if (next?.checkIn) {
          const id = next.hostname.toLowerCase();
          const hello: Hello = {
            hostname: next.hostname,
            name: next.name,
            key: next.key,
            address: next.address,
          };
          approving = r
            .approve(next.checkIn.text, hello)
            .catch((e: unknown) => ({
              ok: false,
              message: `the PC could not decide: ${String(e)}`,
            }))
            .then(async (d) => {
              await r.store.update((x) => {
                const m = x.machines[id];
                if (!m || m.decision) return;
                m.decision = d;
                m.stage = d.ok ? "adopted" : "refused";
              });
            })
            .finally(() => {
              approving = undefined;
            });
        }
        await proc.sleep(poll);
      }
    }
  } finally {
    off?.();
    if (up) {
      // Let the machines read their last answers before the doors close and the record goes.
      const until = now() + (r.graceMs ?? 3000);
      while (now() < until) {
        const cur = await r.store.read().catch(() => undefined);
        if (!cur) break;
        last = cur;
        const undelivered = machinesOf(cur).some((m) => m.decision && !m.delivered);
        if (!undelivered) break;
        await proc.sleep(Math.min(poll, 50));
      }
      await r.store
        .update((x) => {
          x.ended = "closed";
        })
        .catch(() => undefined);
      // The machines still holding a request see that the session ended before the doors close.
      await proc.sleep(Math.min(poll, 100));
    }
    await r.close().catch(() => undefined);
    await r.store.remove().catch(() => undefined);
  }
  return up
    ? summary(last, "closed")
    : { end: "no-door", adopted: [], refused: [], waiting: [], blocked: [] };
}

/** What a record comes to, as a session summary. */
function summary(r: PairRecord, end: "closed"): PairSummary {
  const ms = machinesOf(r);
  return {
    end,
    adopted: ms.filter((m) => m.stage === "adopted"),
    refused: ms.filter((m) => m.stage === "refused"),
    waiting: ms.filter((m) => m.stage !== "adopted" && m.stage !== "refused"),
    blocked: blockedAddresses(r),
  };
}

/**
 * What the terminal shows as a session goes on: a line for each machine's stage as it changes, and one for an address that sent
 * too many wrong codes. `print` writes lines (it holds them while a prompt is on the screen).
 */
export function liveView(print: (line: string) => void): (record: PairRecord) => void {
  const seen = new Map<string, string>();
  const refusedSeen = new Set<string>();
  return (rec) => {
    for (const m of machinesOf(rec)) {
      const id = m.hostname.toLowerCase();
      const key = `${m.stage}|${m.name}|${m.seq}`;
      if (seen.get(id) === key || !m.name) continue;
      seen.set(id, key);
      print(`  ${m.name} (${m.address}) ${STAGE_WORDS[m.stage]}`);
    }
    for (const a of blockedAddresses(rec)) {
      if (refusedSeen.has(a)) continue;
      refusedSeen.add(a);
      print(`  ${a} sent 5 wrong codes: it is refused for the rest of this session`);
    }
  };
}

/** The status line of a session: it is open, and how many machines are where. */
export function sessionStatus(rec: PairRecord): string {
  const ms = machinesOf(rec);
  const count = (...st: PairingStage[]) => ms.filter((m) => st.includes(m.stage)).length;
  const parts = [
    count("hello", "installing") ? `${count("hello", "installing")} joining` : "",
    count("waiting") ? `${count("waiting")} waiting for you` : "",
    count("adopted") ? `${count("adopted")} adopted` : "",
    count("refused") ? `${count("refused")} refused` : "",
  ].filter(Boolean);
  return `Session is open: Ctrl+C closes it${parts.length ? ` · ${parts.join(" · ")}` : " · no machine yet"}`;
}

/** The tags a machine gets when it is paired (spec 108-tags FR-008): defined ones and free-form ones, apart. */
export interface PairTags {
  /** Defined tags (`env:lab`). */
  tags: string[];
  /** Free-form tags (`pilot`), always shown as custom. */
  customTags: string[];
}

/**
 * Read tags a person typed (`--tag`, or the answer at a machine's prompt): each defined or free-form, one value per one-of
 * dimension. The error says what is wrong with the fix; `none` (or `-`) is no tags at all.
 */
export function readPairTags(
  set: Pick<TagSet, "dimensions"> | undefined,
  words: readonly string[],
): { assigned: PairTags } | { error: string } {
  if (words.length === 1 && (words[0] === "-" || words[0]?.toLowerCase() === "none")) {
    return { assigned: { tags: [], customTags: [] } };
  }
  const tokens = words.map((w) => classifyTag(set, w));
  const bad = tokens.flatMap((t) => (t.kind === "bad" ? [t] : []));
  if (bad.length) return { error: bad.map((b) => `${b.why} (${b.fix})`).join("; ") };
  const { assigned, replaced } = addAssigned(set ?? { dimensions: {} }, {}, tokens);
  if (replaced.length) {
    return {
      error: replaced
        .map((r) => `${r.was} and ${r.by} are values of one dimension: a machine holds one`)
        .join("; "),
    };
  }
  return { assigned };
}

/** `stolos pair [--name n] [--port 8080] [--address a] [--tag t]`: pair machines with a short code, until you close the session. */
export async function pair(o: {
  name?: string;
  port?: number;
  address?: string;
  title?: string;
  owner?: string;
  tag?: string;
}): Promise<number> {
  const c = ui.phase("Pairing");
  // Spec 108-tags FR-008: the tags every machine of this session gets, checked before anything is opened.
  const { loadTagSet } = await import("../fleet/tags.ts");
  const loaded = await loadTagSet();
  if (loaded.error) {
    c.fail(loaded.error, "fix fleets/<fleet>/tags.ts, then run this again");
    return ui.finish();
  }
  const tagSet = loaded.set;
  const sessionTags = readPairTags(tagSet, tokensOf(o.tag));
  if ("error" in sessionTags) {
    c.fail(
      `--tag: ${sessionTags.error}`,
      "bun run stolos tag list shows the tags this fleet defines",
    );
    return ui.finish();
  }
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
  let w: ReturnType<typeof ui.phase> | undefined;
  let tick: { clear(): void } | undefined;
  let latest: PairRecord | undefined;
  // While the person is answering a prompt, lines about other machines wait for it to finish.
  let prompting = false;
  const held: string[] = [];
  const show = (text: string): void => {
    ui.pause();
    stdio.stdout.writeSync(text);
    ui.resume();
  };
  const print = (line: string): void => {
    if (prompting) held.push(line);
    else show(`${line}\n`);
  };
  const view = liveView(print);

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
      `${found.doors.map((d) => d.base).join(" · ")} · fleet ${P.fleetId} · many machines, until you close it${
        sessionTags.assigned.tags.length || sessionTags.assigned.customTags.length
          ? ` · tags: ${[...sessionTags.assigned.tags, ...sessionTags.assigned.customTags.map((x) => `${x} (custom)`)].join(" ")}`
          : ""
      }`,
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
      fw.action(w, "allow it, or the machines cannot reach this PC");
    }
    if (choice.explicit && found.doors.some((d) => d.door === "lan-http")) {
      fw.action(
        outsideStandardNote("tcp", choice.port),
        firewallRule(proc.build.os, "tcp", choice.port, "pair (HTTP)"),
      );
    }
    // The checks are done: close the phase before the instructions, so nothing spins under them.
    fw.done(fw.actions ? "see above" : "allows the pairing (or no firewall to check)");
    show(pairInstructions(found.doors, code));
    // Now the command waits for the machines, and says so, until the person closes it.
    w = ui.phase("Waiting");
    const say = (): void => w?.status(latest ? sessionStatus(latest) : sessionStatus(record));
    say();
    tick = proc.unrefTimer(say, 15_000);
    return true;
  };

  const sum = await runPairing({
    store,
    record,
    doors,
    approve: async (text, hello) => {
      prompting = true;
      try {
        return await approve(text, hello, o, { set: tagSet, session: sessionTags.assigned });
      } finally {
        prompting = false;
        for (const l of held.splice(0)) print(l);
      }
    },
    onState: (rec) => {
      latest = rec;
      view(rec);
    },
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
  if (sum.end === "no-door") return fail();
  endPairing(w ?? ui.phase("Waiting"), sum);
  return fail();
}

/**
 * How a pairing session ends (spec 106-one-passphrase-speed FR-006, spec 107-pairing-and-query FR-003): the person closed it, and it says
 * what came of it. Each adopted machine has had its own outcome line ("intrepid is adopted by the fleet lab"); a session where nobody
 * was adopted ends with a plain note, not a failure.
 */
export function endPairing(
  wait: ReturnType<typeof ui.phase>,
  sum: Pick<PairSummary, "adopted" | "refused" | "waiting">,
): void {
  const n = (k: number, what: string) => (k ? `${k} ${what}` : "");
  const left = [
    n(sum.adopted.length, "adopted"),
    n(sum.refused.length, "refused"),
    n(sum.waiting.length, "not decided (nothing was written for them)"),
  ].filter(Boolean);
  wait.done(`session closed${left.length ? `: ${left.join(", ")}` : ": no machine joined"}`);
  for (const m of sum.adopted) ui.outcome(`${m.name} is adopted by the fleet ${P.fleetId}`);
  if (sum.waiting.length) {
    wait.note(
      `not decided: ${sum.waiting.map((m) => m.name || m.hostname).join(", ")}; pair them again`,
    );
  }
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

/** Show who asked, ask the person, and adopt the machine when they say yes (spec 107-pairing-and-query FR-002). */
async function approve(
  text: string,
  hello: Hello,
  o: { title?: string; owner?: string },
  tagging: { set: TagSet | undefined; session: PairTags },
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
  // Spec 108-tags FR-008: the session's tags, which this machine may change here.
  const tags = await chooseTags(hello.name, tagging);
  const { adoptCheckIn } = await import("./commands.ts");
  await adoptCheckIn(ci, {
    name: hello.name,
    spec: "098-pair",
    joined: "paired",
    ...compact(o),
    ...(tags.tags.length ? { tags: tags.tags } : {}),
    ...(tags.customTags.length ? { customTags: tags.customTags } : {}),
  });
  const failed = ui.problems.some((x) => x.level === "fail");
  return failed
    ? { ok: true, message: `${hello.name} is adopted, but the PC could not read its facts yet` }
    : { ok: true, message: `${hello.name} is adopted by the fleet ${P.fleetId}` };
}

/**
 * The tags of one machine at its prompt (spec 108-tags FR-008): the session's by default (Enter keeps them), a list that replaces
 * them, `-` for none. A word that is not a tag is said plainly and asked again; with no terminal the session's tags stand.
 */
export async function chooseTags(
  name: string,
  t: { set: TagSet | undefined; session: PairTags },
): Promise<PairTags> {
  if (!t.set && !t.session.tags.length && !t.session.customTags.length) return t.session;
  const shown = [...t.session.tags, ...t.session.customTags.map((x) => `${x} (custom)`)];
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ui.ask(
      `  Tags for ${name} [${shown.join(" ") || "none"}] (Enter keeps them, a list replaces them, - for none):`,
    );
    const words = tokensOf(answer?.replace(/\s+/g, ","));
    if (!words.length) return t.session;
    const read = readPairTags(t.set, words);
    if ("assigned" in read) return read.assigned;
    stdio.stdout.writeSync(`  ${read.error}\n`);
  }
  stdio.stdout.writeSync(`  keeping the session's tags for ${name}\n`);
  return t.session;
}
