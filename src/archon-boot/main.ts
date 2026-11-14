/**
 * archon-boot (spec 004): the boot machine's side of a zero-touch install.
 * Runs with Deno on Windows or Linux:
 *
 *   deno task boot serve [--port 8080]   serve PXE (TFTP, UDP 69), UEFI HTTP Boot, and installs
 *   deno task boot reinstall <host> [--confirm-destroy <host>]
 *                                        push its state, arm it, network-boot it once (over SSH);
 *                                        a durable host needs --confirm-destroy (Article 23)
 *   deno task boot retire <host> --confirm-destroy <host> [--no-push]
 *                                        a server leaves the fleet, committed and pushed (spec 045)
 *   deno task boot arm <host> --claim | --mac-address <mac> [--confirm-destroy <host>]
 *                                        allow one (re)install of a host
 *   deno task boot status                hosts, Boot URIs, MACs, armed or not
 *   deno task boot doctor                check this boot machine, with a fix for each problem
 *   deno task boot observe               recent installs from the boot server's own telemetry
 *   deno task boot vault <sub>           back up and restore this PC's secrets (spec 029)
 *   deno task boot mail-setup            store the mail relay's token (Cloudflare, spec 027)
 *   deno task boot mail-push <host>      give a running host that token over SSH
 *   deno task boot web-setup             store the Cloudflare DNS token (HTTPS, spec 032)
 *   deno task boot web-push <host>       give a running server that token over SSH
 *   deno task boot notify --subject ...  email the mailbox from this PC (also: notify test | status)
 *
 * @module
 */

import { VERSION } from "../archon/version.ts";
import { ui } from "../archon/core/ui.ts";
import { P, resetRoots } from "../archon/core/paths.ts";
import { join } from "../archon/core/path.ts";
import { ensureDir } from "../archon/core/fsx.ts";
import { armHost, liveToken, loadTokens } from "../archon/core/secrets.ts";
import { loadFleet, loadServers } from "../archon/model/load.ts";
import { ensureAssets } from "./assets.ts";
import { handler, serve } from "./server.ts";
import { serveTftp } from "./tftp.ts";
import { trustHost } from "../archon/install/host-keys.ts";
import { reinstall } from "./reinstall.ts";
import { initBootTelemetry, recordEvents, SINK, startSink, TELEMETRY_DIR } from "./telemetry.ts";
import { firewallWarnings, type Need } from "./firewall.ts";
import { UBUNTU } from "./pins.ts";
import { render } from "./pretty.ts";
import { type ArchonEvent, plainLine } from "../archon/telemetry/events.ts";
import { addressFacing, bootUri, lanAddresses, preferAddress } from "../archon/core/net.ts";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

/** The boot server's log (spec 004): %LOCALAPPDATA%\\archon\\boot\\boot.log, one previous copy kept. */
async function openBootLog(): Promise<{ path: string; write: (line: string) => void }> {
  const path = join(P.bootCache, "boot.log");
  await ensureDir(P.bootCache);
  const size = await Deno.stat(path).then((s) => s.size).catch(() => 0);
  if (size > 5_000_000) await Deno.rename(path, `${path}.1`).catch(() => {});
  const f = await Deno.open(path, { create: true, append: true });
  const enc = new TextEncoder();
  f.writeSync(enc.encode(`${new Date().toISOString()} == boot serve started\n`));
  return {
    path,
    write: (line) => {
      try {
        f.writeSync(enc.encode(line + "\n"));
      } catch { /* the log is best effort */ }
    },
  };
}

async function main(args: string[]): Promise<number> {
  const cmd = args[0];
  if (cmd === "arm") {
    const name = args[1];
    if (!name || !(await loadServers()).some((h) => h.name === name)) {
      console.error(
        `usage: deno task boot arm <host> --claim | --mac-address <mac> [--confirm-destroy <host>]  (known: ${
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
      console.error(`${refusal} (from the records in this checkout: git pull first)`);
      return 1;
    }
    // Spec 051: how its machine is recognized: --claim or --mac-address (or the MAC
    // its own machine reported when it installed).
    const { recognition, describeRecognition, CLAIM_MINUTES } = await import(
      "../archon/install/recognize.ts"
    );
    const { loadRegistration, writeRegistration } = await import(
      "../archon/fleet/registration.ts"
    );
    const reg = await loadRegistration(name);
    const how = recognition(name, {
      claim: args.includes("--claim"),
      macAddress: opt(args, "mac-address"),
      command: "deno task boot arm",
    }, reg);
    if ("refusal" in how) {
      console.error(how.refusal);
      return 2;
    }
    const claim = how.kind === "claim";
    if (how.kind === "mac" && reg && reg.mac !== how.mac) {
      // A person named the network card: that is the host's registered MAC from now on.
      const file = await writeRegistration(name, { ...reg, mac: how.mac, macSource: "operator" });
      console.log(`${file}: mac ${how.mac} (commit and push it, signed, to keep it)`);
    }
    const confirmed = opt(args, "confirm-destroy") === name;
    const t = await armHost(name, claim ? CLAIM_MINUTES : 0, claim ? undefined : how.mac, {
      confirmDestroy: confirmed,
    });
    // Its install brings its own SSH host keys (kept on this machine): trust them now.
    const names = await trustHost(name, t.addresses ?? []);
    console.log(`This PC trusts ${name}'s SSH host keys (${names.join(", ")}).`);
    console.log(
      `${name} is armed for one install: ${
        describeRecognition(name, how)
      }. Power it on while 'deno task boot serve' runs.`,
    );
    if (confirmed) {
      console.log(
        claim
          ? `--confirm-destroy with --claim: the next unknown machine to network-boot in ${CLAIM_MINUTES} minutes is erased, whatever its disks hold.`
          : `--confirm-destroy: its disks are erased even if they are not blank (this install only).`,
      );
    } else {
      console.log(
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
    return await reinstall(args[1], {
      force: args.includes("--force"),
      port: Number(opt(args, "port") ?? 8080),
      confirmDestroy: opt(args, "confirm-destroy"),
    });
  }
  if (cmd === "vault") {
    // Spec 029: the vault commands live in the one registry (Article 6).
    const { main: archon } = await import("../archon/main.ts");
    return await archon(["vault", ...args.slice(1)]);
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
      port: Number(opt(args, "port") ?? 8080),
      send: args.includes("--send") ? "deno task boot doctor --send" : undefined,
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
      const claim = t?.claimUntil && Date.parse(t.claimUntil) > Date.now()
        ? ` · claims the next unknown machine until ${new Date(t.claimUntil).toLocaleTimeString()}`
        : "";
      const mac = (h.mac ?? (learned ? `${learned} (learned)` : "MAC not known yet")) + claim;
      const mark = ui.emoji ? (t ? "🎯" : "💤") : (t ? ">" : "-");
      console.log(
        `${mark} ${ui.bold(ui.cyan(h.name.padEnd(14)))} ${
          t ? ui.green(`armed since ${new Date(t.armed).toLocaleString()}`) : ui.dim("not armed")
        }\n` +
          `${" ".repeat(ui.emoji ? 3 : 2)}${"".padEnd(14)} ${ui.dim("Boot URI")} ${
            ui.blue(bootUri(ip, Number(opt(args, "port") ?? 8080), h.name))
          } ${ui.dim(`· ${mac}`)}`,
      );
    }
    return 0;
  }
  if (cmd !== "serve") {
    console.error(
      "usage: deno task boot serve [--address <this-pc>] [--port 8080] [--tftp-port 69 | --no-tftp] [--stall-watch]\n" +
        "       deno task boot reinstall <host> [--force] [--confirm-destroy <host>]\n" +
        "       deno task boot arm <host> --claim | --mac-address <mac> [--confirm-destroy <host>]\n" +
        "       deno task boot retire <host> --confirm-destroy <host> [--no-push]\n" +
        "       deno task boot status | doctor | observe [--last 5]\n" +
        "       deno task boot vault status | backup | verify | restore | rehearse | list | prune | recover-host-keys <host>\n" +
        "       deno task boot mail-setup | mail-push <host> | web-setup | web-push <host>\n" +
        "       deno task boot notify --subject <s> ... | notify test | status",
    );
    return 2;
  }

  const port = Number(opt(args, "port") ?? 8080);
  // Spec 023: the boot server's own telemetry, kept in local files on this PC.
  await initBootTelemetry();
  await startSink().catch((e) =>
    console.error(
      `telemetry: could not listen on ${SINK.hostname}:${SINK.port} (${(e as Error).message})`,
    )
  );
  // The address servers reach this PC at (the router's next-server), when auto-detection picks another.
  preferAddress(opt(args, "address"));
  const proxy = opt(args, "proxy") ?? Deno.env.get("ARCHON_BOOT_PROXY");
  const caFile = opt(args, "ca-file") ?? Deno.env.get("ARCHON_BOOT_CA_FILE");
  const githubApi = opt(args, "github-api") ?? Deno.env.get("ARCHON_GITHUB_API");
  ui.header("Archon boot", `Ubuntu ${UBUNTU.point} · port ${port}`);
  // Spec 029: the backup panel at the start, and the reminders hourly while serving.
  {
    const { showPanelNow, remind } = await import("../archon/vault/reminder.ts");
    await showPanelNow();
    await remind();
    setInterval(() => remind(), 3600_000);
  }
  const f = ui.phase("Fleet");
  const fleet = await loadFleet();
  const hosts = await loadServers();
  const tokens = await loadTokens();
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
    "service.version": `v${VERSION}`,
  };
  const serveOpts = {
    port,
    // Spec 051: a hint, off unless asked for.
    stallWatch: args.includes("--stall-watch"),
    proxy,
    caPem: caFile ? await Deno.readTextFile(caFile) : undefined,
    githubApi,
    emit: (e: ArchonEvent) => {
      // Spec 049: the event is the source. It is recorded as an OpenTelemetry
      // log record; boot.log and the window are renderings of it (the window
      // with icons and color, without GRUB's harmless probing).
      const ev = { ...e, time: e.time ?? Date.now() };
      recordEvents([ev], resource).catch(() => {});
      logFile.write(`${new Date(ev.time).toISOString()} ${plainLine(ev)}`);
      const shown = render(ev);
      if (shown !== undefined) console.log(shown);
    },
  };
  // One handler for HTTP and TFTP (PXE): identical files and menus, and one
  // memory of what each machine fetched (Boot URIs, progress, HTTP arrivals).
  const h = handler(assets, serveOpts);
  serve(serveOpts, h);
  const tftpPort = Number(opt(args, "tftp-port") ?? 69);
  if (!args.includes("--no-tftp")) {
    await serveTftp({
      port: tftpPort,
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
      : `PXE: DHCP next-server ${ip}, boot file bootx64.efi (TFTP, UDP ${tftpPort}) · HTTP port ${port}`,
  );
  const icon = (e: string, a: string) => (ui.emoji ? e : a);
  console.log(
    `\n   ${icon("🌐", "*")} ${ui.bold("UEFI HTTP Boot URIs")} ${
      ui.dim("(for firmware that takes one)")
    }`,
  );
  for (const h of hosts) {
    console.log(`      ${ui.cyan(h.name.padEnd(14))} ${ui.blue(bootUri(ip, port, h.name))}`);
  }
  console.log(
    `      ${ui.dim("any machine".padEnd(14))} ${ui.blue(bootUri(ip, port))}  ${
      ui.dim("(by MAC, else a menu; default: its own disk)")
    }`,
  );
  for (const other of ips.slice(1)) {
    console.log(`      ${"".padEnd(14)} ${ui.dim(`also reachable at ${other}`)}`);
  }
  console.log(`   ${icon("📝", "*")} ${ui.dim("log".padEnd(10))} ${logFile.path}`);
  console.log(
    `   ${icon("📈", "*")} ${ui.dim("telemetry".padEnd(10))} ${TELEMETRY_DIR} ${
      ui.dim("(OpenTelemetry, this PC only)")
    }`,
  );
  console.log(
    `\n   ${icon("👀", "...")} ${ui.bold("Waiting for machines")} ${ui.dim("(Ctrl+C to stop)")}\n`,
  );
  // Read-only check of this machine's firewall; warnings only, in the background.
  const needs: Need[] = [{ protocol: "TCP", port, what: "HTTP" }];
  if (!args.includes("--no-tftp")) needs.push({ protocol: "UDP", port: tftpPort, what: "TFTP" });
  firewallWarnings(needs).then((lines) => {
    for (const l of lines) serveOpts.emit({ name: "boot.firewall", message: l });
  });
  await new Promise(() => {});
  return 0;
}

/**
 * Run as a program and exit: from this file, or from a fleet repository's own
 * entry file, which imports this one through `@stolos/` (spec 046-engine-instance).
 */
export async function run(argv: string[] = Deno.args): Promise<never> {
  // Spec 046: --fleet <id> (anywhere) chooses the fleet of this repository.
  const i = argv.findIndex((a) => a === "--fleet" || a.startsWith("--fleet="));
  if (i >= 0) {
    const id = argv[i].includes("=") ? argv[i].split("=", 2)[1] : argv[i + 1];
    argv = [...argv.slice(0, i), ...argv.slice(i + (argv[i].includes("=") ? 1 : 2))];
    if (id) {
      Deno.env.set("ARCHON_FLEET", id);
      resetRoots();
    }
  }
  const code = await main(argv);
  ui.printPanel(); // spec 029: a secret changed and is not backed up yet
  Deno.exit(code);
}

if (import.meta.main) await run();
