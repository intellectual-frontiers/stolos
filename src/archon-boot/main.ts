/**
 * archon-boot (spec 004): the boot machine's side of a zero-touch install.
 * Runs with Bun (or Node 26) on Windows or Linux:
 *
 *   bun run stolos boot serve [--port 8080]   serve PXE (TFTP, UDP 69), UEFI HTTP Boot, and installs
 *   bun run stolos boot reinstall <host> [--confirm-destroy <host>]
 *                                        push its state, arm it, network-boot it once (over SSH);
 *                                        a durable host needs --confirm-destroy (Article 23)
 *   bun run stolos boot retire <host> --confirm-destroy <host> [--no-push]
 *                                        a server leaves the fleet, committed and pushed (spec 045)
 *   bun run stolos boot arm <host> --claim | --mac-address <mac> [--confirm-destroy <host>]
 *                                        allow one (re)install of a host
 *   bun run stolos boot status                hosts, Boot URIs, MACs, armed or not
 *   bun run stolos boot doctor                check this boot machine, with a fix for each problem
 *   bun run stolos boot observe               recent installs from the boot server's own telemetry
 *   bun run stolos vault <sub>           back up and restore this PC's secrets (spec 029)
 *   bun run stolos boot mail-setup            store the mail relay's token (Cloudflare, spec 027)
 *   bun run stolos boot mail-push <host>      give a running host that token over SSH
 *   bun run stolos boot web-setup             store the Cloudflare DNS token (HTTPS, spec 032)
 *   bun run stolos boot web-push <host>       give a running server that token over SSH
 *   bun run stolos boot notify --subject ...  email the mailbox from this PC (also: notify test | status)
 *
 * @module
 */
// Spec: 105-calm-output FR-001, FR-002
// Spec: 004-install
// Spec: 103-three-ports FR-001, FR-004, FR-010, FR-011
// Spec: 106-one-passphrase-speed FR-006, FR-008
// Spec: 114-release-record FR-005

import { fs, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { TAG } from "../archon/version.ts";
import { muteOutput, ui } from "../archon/core/ui.ts";
import { setFresh } from "../archon/core/probe-cache.ts";
import { P, resetRoots } from "../archon/core/paths.ts";
import { armHost, liveToken, loadTokens } from "../archon/core/secrets.ts";
import { loadFleet, loadServers } from "../archon/model/load.ts";
import { ensureAssets } from "./assets.ts";
import { openBootLog } from "./boot-log.ts";
import { handler, serve } from "./server.ts";
import { serveTftp } from "./tftp.ts";
import { trustHost } from "../archon/install/host-keys.ts";
import { reinstall } from "./reinstall.ts";
import { initBootTelemetry, recordEvents, stopBootTelemetry, TELEMETRY_DIR } from "./telemetry.ts";
import { firewallWarnings, type Need } from "./firewall.ts";
import { UBUNTU } from "./pins.ts";
import { render } from "./pretty.ts";
import { type ArchonEvent, plainLine } from "../archon/telemetry/events.ts";
import { addressFacing, bootUri, lanAddresses, preferAddress } from "../archon/core/net.ts";
import { choosePort, firewallRule, outsideStandardNote } from "../archon/core/listeners.ts";

/** The HTTP port: the ontology's `boot-http` unless `--port` says another (an explicit choice). */
function bootPort(args: readonly string[]): number {
  const given = opt(args, "port");
  return choosePort("boot-http", given === undefined ? undefined : Number(given)).port;
}

function opt(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}

async function main(args: readonly string[]): Promise<number> {
  const cmd = args[0];
  if (cmd === "arm") {
    const name = args[1];
    if (!name || !(await loadServers()).some((h) => h.name === name)) {
      ui.say(
        `usage: bun run stolos boot arm <host> --claim | --mac-address <mac> [--confirm-destroy <host>]  (known: ${
          (await loadServers()).map((h) => h.name).join(", ") || "none"
        })`,
      );
      return 2;
    }
    // Article 23: arming lets the host's next network boot erase it.
    const { destroyRefusal, recordedData } = await import("./reinstall.ts");
    const refusal = destroyRefusal(
      name,
      recordedData((await loadServers()).find((h) => h.name === name)),
      opt(args, "confirm-destroy"),
    );
    if (refusal) {
      ui.say(`${refusal} (from the records in this checkout: git pull first)`);
      return 1;
    }
    // Spec 051: how its machine is recognized: --claim or --mac-address (or the MAC
    // its own machine reported when it installed).
    const { recognition, describeRecognition, CLAIM_MINUTES } =
      await import("../archon/install/recognize.ts");
    const { loadRegistration, writeRegistration } = await import("../archon/fleet/registration.ts");
    const reg = await loadRegistration(name);
    const macAddress = opt(args, "mac-address");
    const how = recognition(
      name,
      {
        claim: args.includes("--claim"),
        ...(macAddress === undefined ? {} : { macAddress }),
        command: "bun run stolos boot arm",
      },
      reg,
    );
    if ("refusal" in how) {
      ui.say(how.refusal);
      return 2;
    }
    const claim = how.kind === "claim";
    if (how.kind === "mac" && reg && reg.mac !== how.mac) {
      // A person named the network card: that is the host's registered MAC from now on.
      const file = await writeRegistration(name, { ...reg, mac: how.mac, macSource: "operator" });
      ui.say(`${file}: mac ${how.mac} (to keep it: bun run stolos apply)`);
    }
    // Spec 063: what its first boot will run must be on GitHub, signed by a fleet signer.
    {
      const { checkRunnable } = await import("../archon/install/runnable.ts");
      const rn = await checkRunnable([name]);
      if (rn.unreachable) {
        ui.say(`could not ask GitHub (${rn.unreachable}); checked the last fetched commit`);
      }
      if (rn.problems.length) {
        for (const p of rn.problems) {
          ui.say(`${p.what}\n  fix: ${p.fix}  (bun run stolos explain ${p.code})`);
        }
        ui.say(`${name} is not armed: nothing will be installed until this is fixed.`);
        return 1;
      }
    }
    const confirmed = opt(args, "confirm-destroy") === name;
    const t = await armHost(name, claim ? CLAIM_MINUTES : 0, claim ? undefined : how.mac, {
      confirmDestroy: confirmed,
    });
    // Its install brings its own SSH host keys (kept on this machine): trust them now.
    const names = await trustHost(name, t.addresses ?? []);
    ui.say(`This PC trusts ${name}'s SSH host keys (${names.join(", ")}).`);
    ui.say(
      `${name} is armed for one install: ${describeRecognition(
        name,
        how,
      )}. Power it on while 'bun run stolos boot serve' runs.`,
    );
    if (confirmed) {
      ui.say(
        claim
          ? `--confirm-destroy with --claim: the next unknown machine to network-boot in ${CLAIM_MINUTES} minutes is erased, whatever its disks hold.`
          : `--confirm-destroy: its disks are erased even if they are not blank (this install only).`,
      );
    } else {
      ui.say(
        "Its installer erases no disk that is not blank: if it finds one, it stops before writing anything and says what it found.",
      );
    }
    return 0;
  }
  if (cmd === "retire") {
    const { retire } = await import("./retire.ts");
    return await retire(args[1], opt(args, "confirm-destroy"), !args.includes("--no-push"));
  }
  if (cmd === "reinstall") {
    if (args.includes("--force")) {
      // Never did anything; the decision it stood for is --confirm-destroy.
      ui.say(
        "boot reinstall has no --force: to reinstall a durable host, or one that cannot be reached, repeat its name: --confirm-destroy <host>",
      );
      return 2;
    }
    return await reinstall(args[1], {
      port: bootPort(args),
      confirmDestroy: opt(args, "confirm-destroy"),
    });
  }
  if (cmd === "vault") {
    // Spec 029: the vault commands live in the one registry (Article 6).
    const { main: archon } = await import("../archon/main.ts");
    return await archon(["vault", ...args.slice(1)], "pc");
  }
  if (cmd === "web-setup") {
    const { webSetup } = await import("./web.ts");
    return await webSetup();
  }
  if (cmd === "web-push") {
    const { webPush } = await import("./web.ts");
    return await webPush(args[1]);
  }
  if (cmd === "mail-setup") {
    const { mailSetup } = await import("./mail.ts");
    return await mailSetup();
  }
  if (cmd === "mail-push") {
    const { mailPush } = await import("./mail.ts");
    return await mailPush(args[1]);
  }
  if (cmd === "notify") {
    const { bootNotify } = await import("./mail.ts");
    return await bootNotify(args.slice(1));
  }
  if (cmd === "observe") {
    const { bootObserve } = await import("./observe.ts");
    return await bootObserve({ count: Number(opt(args, "last") ?? 5) });
  }
  if (cmd === "doctor") {
    const { doctor } = await import("./doctor.ts");
    return await doctor({
      port: bootPort(args),
      send: args.includes("--send") ? "bun run stolos boot doctor --send" : undefined,
    });
  }
  if (cmd === "status") {
    // Spec 029: unbacked secrets first, until they are backed up.
    const { showPanelNow, remind } = await import("../archon/vault/reminder.ts");
    await showPanelNow();
    await remind();
    const tokens = await loadTokens();
    const ip = lanAddresses()[0] ?? "<this-pc>";
    for (const h of await loadServers()) {
      const t = liveToken(tokens, h.name);
      const learned = tokens.find((x) => x.host === h.name)?.mac;
      const claim =
        t?.claimUntil && Date.parse(t.claimUntil) > Date.now()
          ? ` · claims the next unknown machine until ${new Date(t.claimUntil).toLocaleTimeString()}`
          : "";
      const mac = (h.mac ?? (learned ? `${learned} (learned)` : "MAC not known yet")) + claim;
      const mark = ui.emoji ? (t ? "🎯" : "💤") : t ? ">" : "-";
      ui.say(
        `${mark} ${ui.bold(ui.cyan(h.name.padEnd(14)))} ${
          t ? ui.green(`armed since ${new Date(t.armed).toLocaleString()}`) : ui.dim("not armed")
        }\n` +
          `${" ".repeat(ui.emoji ? 3 : 2)}${"".padEnd(14)} ${ui.dim("Boot URI")} ${ui.blue(
            bootUri(ip, bootPort(args), h.name),
          )} ${ui.dim(`· ${mac}`)}`,
      );
    }
    return 0;
  }
  if (cmd !== "serve") {
    ui.say(
      "usage: bun run stolos boot serve [--address <this-pc>] [--port 8080] [--tftp-port 69 | --no-tftp] [--stall-watch]\n" +
        "       bun run stolos boot reinstall <host> [--confirm-destroy <host>]\n" +
        "       bun run stolos boot arm <host> --claim | --mac-address <mac> [--confirm-destroy <host>]\n" +
        "       bun run stolos boot retire <host> --confirm-destroy <host> [--no-push]\n" +
        "       bun run stolos boot status | doctor | observe [--last 5]\n" +
        "       bun run stolos vault status | backup | restore | list | recover-host-keys <host>\n" +
        "       bun run stolos boot mail-setup | mail-push <host> | web-setup | web-push <host>\n" +
        "       bun run stolos boot notify --subject <s> ... | notify test | status",
    );
    return 2;
  }

  const port = bootPort(args);
  const tftpPort = choosePort(
    "boot-tftp",
    opt(args, "tftp-port") === undefined ? undefined : Number(opt(args, "tftp-port")),
  );
  // Spec 023: the boot server's own telemetry, in this process, kept in local files on this PC.
  initBootTelemetry();
  // Ctrl+C: what the telemetry still holds goes to its journal first.
  proc.addSignalListener("SIGINT", () => {
    void stopBootTelemetry().finally(() => proc.exit(130));
  });
  // The address servers reach this PC at (the router's next-server), when auto-detection picks another.
  preferAddress(opt(args, "address"));
  const proxy = opt(args, "proxy") ?? proc.env.get("ARCHON_BOOT_PROXY");
  const caFile = opt(args, "ca-file") ?? proc.env.get("ARCHON_BOOT_CA_FILE");
  const githubApi = opt(args, "github-api") ?? proc.env.get("ARCHON_GITHUB_API");
  ui.header("Stolos boot serve", `Ubuntu ${UBUNTU.point} · port ${port}`);
  // Spec 029: the backup panel at the start, and the reminders hourly while serving.
  {
    const { showPanelNow, remind } = await import("../archon/vault/reminder.ts");
    await showPanelNow();
    await remind();
    setInterval(() => void remind(), 3600_000);
  }
  const f = ui.phase("Fleet");
  const fleet = await loadFleet();
  const hosts = await loadServers();
  const tokens = await loadTokens();
  // Spec 063: what an armed host's first boot will run (GitHub's tip, its model).
  {
    const { checkRunnable } = await import("../archon/install/runnable.ts");
    const rn = await checkRunnable(
      hosts.filter((h) => liveToken(tokens, h.name)).map((h) => h.name),
    );
    for (const p of rn.problems) f.warn(p.what, p.fix, p.code);
    if (rn.unreachable) {
      f.note(`could not ask GitHub (${rn.unreachable}); checked the last fetched commit`);
    }
  }
  f.done(
    `${fleet.repository.slug} · ${
      hosts.map((h) => `${h.name}${liveToken(tokens, h.name) ? " (armed)" : ""}`).join(", ") ||
      "no hosts yet"
    }`,
  );
  const a = ui.phase("Ubuntu files");
  const assets = await ensureAssets(a);
  a.done(`shim, GRUB, kernel, initrd, ${UBUNTU.iso.name} · SHA-256 verified`);
  const ips = lanAddresses();
  const ip = ips[0] ?? "<this-pc>";
  const s = ui.phase("Serving");
  // Everything the window shows also goes to a log file, to look back at or send.
  const logFile = await openBootLog();
  const resource = {
    "service.name": "archon-boot",
    "service.namespace": P.fleetId,
    "service.version": TAG,
  };
  const serveOpts = {
    port,
    // Spec 051: a hint, off unless asked for.
    stallWatch: args.includes("--stall-watch"),
    proxy,
    caPem: caFile ? await fs.readTextFile(caFile) : undefined,
    githubApi,
    // Spec 103: door A of the pairing: /device/pair on this port, from the file `stolos pair` writes.
    devicePair: (await import("../archon/adopt/pair-service.ts")).devicePairHandler(),
    emit: (e: ArchonEvent) => {
      // Spec 049: the event is the source. It is recorded as an OpenTelemetry
      // log record; boot.log and the window are renderings of it (the window
      // with icons and color, without GRUB's harmless probing).
      const ev = { ...e, time: e.time ?? Date.now() };
      recordEvents([ev], resource).catch(() => {});
      logFile.write(`${new Date(ev.time).toISOString()} ${plainLine(ev)}`);
      const shown = render(ev);
      if (shown !== undefined) ui.say(shown);
    },
  };
  // One handler for HTTP and TFTP (PXE): identical files and menus, and one
  // memory of what each machine fetched (Boot URIs, progress, HTTP arrivals).
  const h = handler(assets, serveOpts);
  await serve(serveOpts, h);
  if (!args.includes("--no-tftp")) {
    await serveTftp({
      port: tftpPort.port,
      emit: serveOpts.emit,
      read: async (name, from) => {
        const local = addressFacing(from) ?? "127.0.0.1";
        const path = name.replace(/\\/g, "/").replace(/^\/*/, "/");
        const res = await h(
          new Request(`http://${local}:${port}${path}`, {
            headers: { host: `${local}:${port}`, "x-archon-via": "tftp" },
          }),
          from,
        );
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
      },
    });
  }
  s.done(
    args.includes("--no-tftp")
      ? `HTTP Boot on port ${port}`
      : `PXE: DHCP next-server ${ip}, boot file bootx64.efi (TFTP, UDP ${tftpPort.port}) · HTTP port ${port}`,
  );
  const icon = (e: string, a: string) => (ui.emoji ? e : a);
  ui.say(
    `\n   ${icon("🌐", "*")} ${ui.bold("UEFI HTTP Boot URIs")} ${ui.dim(
      "(for firmware that takes one)",
    )}`,
  );
  for (const h of hosts) {
    ui.say(`      ${ui.cyan(h.name.padEnd(14))} ${ui.blue(bootUri(ip, port, h.name))}`);
  }
  ui.say(
    `      ${ui.dim("any machine".padEnd(14))} ${ui.blue(bootUri(ip, port))}  ${ui.dim(
      "(by MAC, else a menu; default: its own disk)",
    )}`,
  );
  for (const other of ips.slice(1)) {
    ui.say(`      ${"".padEnd(14)} ${ui.dim(`also reachable at ${other}`)}`);
  }
  ui.say(`   ${icon("📝", "*")} ${ui.dim("log".padEnd(10))} ${logFile.path}`);
  ui.say(
    `   ${icon("📈", "*")} ${ui.dim("telemetry".padEnd(10))} ${TELEMETRY_DIR} ${ui.dim(
      "(OpenTelemetry, this PC only)",
    )}`,
  );
  ui.say(
    `\n   ${icon("👀", "...")} ${ui.bold("Waiting for machines")} ${ui.dim("(Ctrl+C to stop)")}\n`,
  );
  // Read-only check of this machine's firewall; warnings only, in the background.
  const needs: Need[] = [{ protocol: "TCP", port, what: "HTTP" }];
  if (!args.includes("--no-tftp"))
    needs.push({ protocol: "UDP", port: tftpPort.port, what: "TFTP" });
  // Spec 103: a port other than the three standard ones is the person's explicit choice, with its own firewall rule.
  for (const [what, protocol, p, explicit] of [
    ["HTTP", "tcp", port, port !== choosePort("boot-http").port],
    ["TFTP", "udp", tftpPort.port, tftpPort.explicit && !args.includes("--no-tftp")],
  ] as const) {
    if (explicit) {
      ui.phase("Firewall").action(
        outsideStandardNote(protocol, p),
        firewallRule(proc.build.os, protocol, p, `boot ${what}`),
      );
    }
  }
  void firewallWarnings(needs).then((lines) => {
    for (const l of lines) serveOpts.emit({ name: "boot.firewall", message: l });
  });
  await new Promise(() => {});
  return 0;
}

/**
 * Run as a program and exit: from this file, or from a fleet repository's own
 * entry file, which imports this one through `@stolos/` (spec 046-engine-instance).
 */
export async function run(argv: readonly string[] = proc.args): Promise<never> {
  const code = await bootMain(argv);
  ui.printPanel(); // spec 029: a secret changed and is not backed up yet
  proc.exit(code);
}

/** `stolos boot <sub>` (spec 059): the boot server's commands; returns the exit code. */
export async function bootMain(argv: readonly string[]): Promise<number> {
  // Spec 046: --fleet <id> (anywhere) chooses the fleet of this repository.
  const i = argv.findIndex((a) => a === "--fleet" || a.startsWith("--fleet="));
  const flag = argv[i];
  if (flag !== undefined) {
    const inline = flag.includes("=");
    const id = inline ? flag.split("=", 2)[1] : argv[i + 1];
    argv = [...argv.slice(0, i), ...argv.slice(i + (inline ? 1 : 2))];
    if (id) {
      proc.env.set("ARCHON_FLEET", id);
      resetRoots();
    }
  }
  // Spec 105-calm-output FR-001, FR-002: `boot doctor`, `serve`, `status` and `observe` are reports
  // (verbose by default); the others do something (calm). `vault` is the registry's own.
  const at = argv.findIndex((a) => !a.startsWith("-"));
  const cmd = at >= 0 ? argv[at] : undefined;
  if (cmd === "vault") return await main(argv);
  const quiet = argv.some((a) => a === "-q" || a === "--quiet");
  const verbose = argv.some((a) => a === "-v" || a === "--verbose");
  const rest = argv.filter((a) => !["-q", "--quiet", "-v", "--verbose", "--fresh"].includes(a));
  // Spec 106-one-passphrase-speed FR-008: --fresh asks the system again (children follow).
  if (argv.includes("--fresh")) setFresh(true);
  if (verbose) ui.verbose = true;
  const report = cmd === undefined || ["doctor", "serve", "status", "observe"].includes(cmd);
  ui.setMode(quiet ? "quiet" : verbose || report ? "verbose" : "calm");
  if (report) ui.verdictTitle = "Checked";
  if (!quiet) return await main(rest);
  const restore = muteOutput();
  let code = 1;
  try {
    code = await main(rest);
  } finally {
    restore();
    if (!ui.closed) ui.quietVerdict(`boot ${cmd ?? ""}`.trim(), code);
  }
  return code;
}

/**
 * `stolos boot doctor` as a phase of the run that is running now, in this process (spec
 * 106-one-passphrase-speed FR-006): the doctor's checks, with the parent's mode and log. Gives the
 * exit code, or undefined for any other boot command, which is a process of its own.
 */
export async function bootNested(argv: readonly string[]): Promise<number | undefined> {
  const rest = argv.filter((a) => !a.startsWith("-"));
  if (rest[0] !== "doctor" || argv.includes("--send")) return undefined;
  return await main(
    argv.filter(
      (a) => a !== "--fresh" && a !== "-v" && a !== "--verbose" && a !== "-q" && a !== "--quiet",
    ),
  );
}

if (import.meta.main) await run();
