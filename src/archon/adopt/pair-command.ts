/**
 * Spec 098: `stolos pair`, on the controller PC. Shows the one short line to run on a machine and
 * a code, serves the pairing (pair.ts) on the LAN until one machine has paired or the code expires,
 * and asks the person to approve the machine before anything is written to the fleet repository.
 *
 * @module
 */

import { proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { compact, toBase64 } from "@intellectual-frontiers/commons/ts/kernel";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { VERSION } from "../version.ts";
import { ensureProbeKey, loadAdopted, MACHINE_NAME } from "./adopt.ts";
import { type Hello, newCode, PAIR_PORT, PairSession } from "./pair.ts";

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** `stolos pair [--name n] [--port 7457] [--address a]`: pair one machine with a short code. */
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
  const address = lanAddresses()[0];
  if (!address) {
    c.fail(
      "this PC has no LAN address to be reached at",
      "connect it to the network the machine is on (or a zero trust mesh network: bun run stolos mesh), or say which: --address <this-pc>",
    );
    return fail();
  }
  // Spec 097: this PC is a fleet machine too.
  await (await import("./controller.ts")).recordController();
  const port = o.port ?? PAIR_PORT;
  const url = `http://${address}:${port}`;
  const code = newCode();
  const { loadHosts } = await import("../model/load.ts");
  const managed = new Set((await loadHosts()).map((h) => h.name));

  const session: PairSession = new PairSession({
    fleet: P.fleetId,
    engine: `v${VERSION}`,
    url,
    code,
    nameFor: async (hostname) => {
      const { nameFor } = await import("./checkin.ts");
      const name = o.name ?? nameFor(hostname);
      if (managed.has(name)) {
        return {
          refuse: `${name} is a managed server in this fleet: on the PC, pair again with --name <another>`,
        };
      }
      if (!MACHINE_NAME.test(name)) {
        return { refuse: `${name} is not a name: on the PC, pair again with --name <name>` };
      }
      return { name, key: await ensureProbeKey(name, P.fleetId) };
    },
    approve: (text, hello) => approve(text, hello, o),
  });

  const { listen } = await import("../../archon-boot/http.ts");
  let listener;
  try {
    listener = await listen(port, (req) => session.handle(req));
  } catch (e) {
    c.fail(
      `could not listen on port ${port}: ${(e as Error).message}`,
      "is another stolos pair running? or choose another: --port <n>",
    );
    return fail();
  }
  c.done(`${url} · fleet ${P.fleetId} · one machine, for 10 minutes`);
  {
    const { firewallWarnings } = await import("../../archon-boot/firewall.ts");
    for (const w of await firewallWarnings([{ protocol: "TCP", port, what: "Stolos pair" }])) {
      ui.phase("Firewall").warn(w, "allow it, or the machine cannot reach this PC");
    }
  }
  ui.pause();
  stdio.stdout.writeSync(
    `\n  On the machine, run:\n` +
      `    Linux, macOS, WSL:   curl -fsSL ${url} | sh\n` +
      `    Windows (admin):     irm ${url}/w | iex\n\n` +
      `  Then type this code:   ${code}      (expires in 10 minutes)\n\n` +
      `  Plain HTTP, on purpose: this LAN is trusted. A machine elsewhere joins over a zero trust\n` +
      `  mesh network (bun run stolos mesh), never over the internet.\n\n`,
  );
  ui.resume();
  const w = ui.phase("Waiting");
  const timer = setTimeout(() => session.end("expired"), session.expiresAt - Date.now());
  const onInt = (): void => session.end("refused");
  proc.addSignalListener("SIGINT", onInt);
  const end = await session.done();
  clearTimeout(timer);
  proc.removeSignalListener("SIGINT", onInt);
  // Let the machine read the last answer before the listener closes.
  await new Promise((r) => setTimeout(r, 500));
  listener.close();
  if (end === "paired") w.done("paired");
  else if (end === "expired")
    w.fail("the code expired; nothing was written", "bun run stolos pair");
  else if (end === "tries") {
    w.fail("5 wrong codes: the pairing ended; nothing was written", "bun run stolos pair");
  } else w.warn("not approved; nothing was written", "bun run stolos pair");
  return fail();
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
