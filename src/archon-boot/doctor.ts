/**
 * `bun run stolos boot doctor` (spec 004): one read-only look at this boot machine,
 * with the fix for each problem: the checkout (hosts install from GitHub, so
 * local changes must be pushed), the model, secrets, Ubuntu's files, the
 * network, the ports, and the firewall. It changes nothing.
 *
 * @module
 */
// Spec: 105-calm-output FR-008, FR-017
// Spec: 099-engine-update FR-006, FR-007
// Spec: 100-remote-access FR-012
// Spec: 103-three-ports FR-001, FR-009, FR-011
// Spec: 106-one-passphrase-speed FR-008

import { fs, path, proc, tcp } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../archon/core/exec.ts";
import { P } from "../archon/core/paths.ts";
import { ui } from "../archon/core/ui.ts";
import { liveToken, loadTokens, SECRETS } from "../archon/core/secrets.ts";
import { lanAddresses } from "../archon/core/net.ts";
import { standardPort } from "../archon/core/listeners.ts";
import { HEARTBEAT_STALE_MS } from "../archon/access/tls.ts";
import { HOST_KEY_TYPES } from "../archon/install/host-keys.ts";
import { cacheDir } from "./assets.ts";
import { UBUNTU } from "./pins.ts";
import { firewallWarnings } from "./firewall.ts";
import { fetchOnce } from "../archon/core/run-memo.ts";

/**
 * Whether a failed bind says "not allowed" (a port below 1024 on a system that keeps those for
 * privileged accounts) and not "taken": the check cannot tell, and says so as a warning.
 */
export function portNotCheckable(code: string, port: number, os: string): boolean {
  return code === "EACCES" && port < 1024 && os !== "windows";
}

/**
 * Run the boot doctor: check the checkout, model, secrets, Ubuntu's files,
 * network, ports and firewall, printing a fix for each problem. Read-only.
 * `port` is the boot server's HTTP port, `send` mails the findings, and
 * `embedded` joins a caller's run (vault restore) instead of starting one.
 * Returns the exit code (nonzero when a check fails).
 */
export async function doctor(o: {
  port: number;
  send?: string | undefined;
  embedded?: boolean;
}): Promise<number> {
  // Embedded (vault restore runs it): its phases path.join the caller's run and summary.
  if (o.embedded) ui.say(`${ui.emoji ? "🩺" : "*"} ${ui.dim("boot doctor")}`);
  else ui.header("Stolos boot doctor", "read-only");

  // The firewall check is the slowest (Windows reads every rule): it runs while the others do (spec
  // 106-one-passphrase-speed FR-008), and is read at its phase.
  const firewall = firewallWarnings([
    { protocol: "TCP", port: o.port, what: "HTTP" },
    { protocol: "UDP", port: standardPort("boot-tftp"), what: "TFTP" },
  ]);

  // ------------------------------------------------------------ checkout
  const g = ui.phase("Checkout");
  const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);
  g.status("fetching origin");
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  // Spec 106-one-passphrase-speed FR-009: the branch's fetch, once per run (an update did it already).
  const fetched = (await fetchOnce(P.repo, branch === "HEAD" ? undefined : branch)).ok;
  // The whole repository, new files included (fleets/<fleet>/ first of all); .gitignore keeps out/ out.
  const dirty = (await git(["status", "--porcelain", "--untracked-files=all"])).stdout
    .split("\n")
    .filter(Boolean);
  const ahead = Number((await git(["rev-list", "--count", `origin/${branch}..HEAD`])).stdout) || 0;
  const behind = Number((await git(["rev-list", "--count", `HEAD..origin/${branch}`])).stdout) || 0;
  if (!fetched) {
    g.warn("GitHub could not be reached to compare.", "gh auth status", "E105-GITHUB");
  }
  if (dirty.length) {
    // Spec 099: records Stolos wrote (an install's registration, ...) are expected, not a mistake.
    const { porcelainPath, splitChanges, yoursNamed } = await import("../archon/fleet/records.ts");
    const files = dirty.map(porcelainPath);
    // Spec 105-calm-output FR-014: an engine upgrade waiting for its signature is Stolos's, not yours.
    const { waitingUpgrade } = await import("../archon/fleet/upgrade.ts");
    const waiting = await waitingUpgrade(P.repo, files);
    const { records, yours } = splitChanges(waiting ? [] : files);
    if (waiting) {
      g.action(
        `The engine upgrade to ${waiting.to} is waiting for its signature, so nothing has been sent.`,
        "bun run stolos update",
        "E105-UPGRADE-WAITING",
      );
    }
    if (records.length) {
      g.action(
        `Not sent yet: ${records.map((r) => r.what).join("; ")}`,
        "bun run stolos update",
        "E105-UNSENT",
      );
    }
    if (yours.length) {
      g.action(
        `${yours.length} change${yours.length > 1 ? "s" : ""} of yours not sent yet (${yours.slice(0, 3).map(yoursNamed).join(", ")}${
          yours.length > 3 ? ", ..." : ""
        }): servers see them once they are sent.`,
        "bun run stolos apply",
        "E105-UNSENT",
      );
    }
  }
  if (ahead) {
    g.action(
      `${ahead} commit(s) not sent yet: servers see them once they are.`,
      "bun run stolos apply",
      "E105-UNSENT",
    );
  }
  if (behind) {
    g.warn(`${behind} new commit(s) on GitHub`, "bun run stolos update, then restart boot serve");
  }
  g.done(
    dirty.length || ahead || behind
      ? `${branch}: changes to send or receive (above)`
      : `${branch}, in step with GitHub`,
  );

  // --------------------------------------------------------------- model
  const m = ui.phase("Model");
  const { loadModel } = await import("../archon/build.ts");
  const model = await loadModel().catch((e) => {
    m.fail((e as Error).message, "bun run stolos fleet init");
    return undefined;
  });
  if (model) {
    for (const p of model.problems) m.fail(`${p.where}: ${p.message}`, p.fix);
    m.done(
      `${model.hosts.map((h) => h.name).join(", ") || "no hosts yet"}${
        model.problems.length ? "" : " · valid"
      }`,
    );
  }

  // ------------------------------------------------------------- signing keys
  // Spec 057: the same checks as stolos keys; nothing changes, nothing is asked.
  const k = ui.phase("Signing keys");
  const { keyChecksNow } = await import("../archon/identity/keys-commands.ts");
  for (const c of await keyChecksNow().catch(() => [])) {
    if (c.ok) k.note(c.what);
    else if (c.level === "fail") k.fail(c.what, c.fix, c.code);
    else k.warn(c.what, c.fix, c.code);
  }
  k.done();

  // ------------------------------------------------------------- secrets
  const s = ui.phase("Secrets");
  if (!(await fs.exists(SECRETS.adminPasswordHash))) {
    s.fail("no admin password hash", "bun run stolos fleet init");
  }
  for (const h of (model?.hosts ?? []).filter((x) => x.kind !== "workstation")) {
    if (!(await fs.exists(SECRETS.deployKey(h.name)))) {
      s.warn(
        `${h.name} has no deploy key: it will clone over HTTPS and cannot push`,
        `bun run stolos host add ${h.name} --force`,
      );
    }
    const keys = await Promise.all(
      HOST_KEY_TYPES.map((t) => fs.exists(SECRETS.hostKey(h.name, t))),
    );
    if (!keys.every(Boolean)) {
      s.note(`${h.name}: SSH host keys are created at its next install (or boot arm)`);
    }
  }
  // Spec 029: anything newer than the last vault backup.
  const { assess } = await import("../archon/vault/state.ts");
  const { remind, installPrePushHook, secretsInWords } =
    await import("../archon/vault/reminder.ts");
  const va = await assess();
  if (va.unbacked.length) {
    // Spec 099: a backup to make is your move (⚡); a week overdue, or keys never backed up, a warning.
    // Spec 105-calm-output FR-017: grouped by machine, in words, with the command on its own line.
    (va.severity === "red" ? s.warn.bind(s) : s.action.bind(s))(
      `Your secrets ${va.lastBackup ? "changed since the last backup" : "were never backed up"}: ${secretsInWords(va)}`,
      "bun run stolos vault backup",
      "E105-BACKUP",
    );
  }
  await remind();
  await installPrePushHook().catch(() => false);
  s.done(SECRETS.dir);

  // ------------------------------------------------------- Ubuntu's files
  const u = ui.phase("Ubuntu files");
  const missing: string[] = [];
  for (const name of [...Object.keys(UBUNTU.files), UBUNTU.iso.name]) {
    if (!(await fs.exists(path.join(cacheDir(), name)))) missing.push(name);
  }
  if (missing.length) {
    u.pending(
      `not downloaded yet: ${missing.join(", ")} (about 3 GB, once)`,
      "bun run stolos boot serve downloads and verifies them the first time it starts",
    );
  }
  u.done(
    missing.length
      ? `${cacheDir()}`
      : `all present in ${cacheDir()} (serve verifies each against its pin)`,
  );

  // ------------------------------------------------------ network, ports
  const n = ui.phase("Network");
  const ips = lanAddresses();
  if (!ips.length) n.fail("no LAN address", "connect this PC to the network the servers boot from");
  const up = await fetch(`http://127.0.0.1:${o.port}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) {
    for (const [proto, port] of [
      ["TCP", o.port],
      ["UDP", standardPort("boot-tftp")],
    ] as const) {
      try {
        if (proto === "TCP") (await tcp.listen({ port, hostname: "0.0.0.0" })).close();
        else {
          const { default: dgram } = await import("node:dgram");
          const sock = dgram.createSocket("udp4");
          await new Promise<void>((res, rej) => {
            sock.once("error", rej);
            sock.bind(port, "0.0.0.0", () => res());
          });
          sock.close();
        }
      } catch (e) {
        const code = (e as { code?: string }).code ?? (e as Error).name;
        // A port below 1024 is a privilege, not a neighbour: where this account may not bind it, it is
        // not known to be taken (the check cannot say), and what serves it runs with that privilege.
        if (portNotCheckable(code, port, proc.build.os)) {
          n.warn(
            `${proto} port ${port} could not be checked (${code}: this account may not bind a port below 1024)`,
            "run the doctor with sudo to check it, or serve with the privilege that binds it",
          );
          continue;
        }
        n.fail(
          `${proto} port ${port} is not free (${code})`,
          port === standardPort("boot-tftp")
            ? "stop the other TFTP server (Tftpd64, Windows Deployment Services)"
            : `stop what uses port ${port}, or use --port`,
        );
      }
    }
  }
  n.done(
    `${ips[0] ?? "no address"}${
      ips.length > 1 ? ` (also ${ips.slice(1).join(", ")})` : ""
    } · boot serve ${up ? "is running" : "is not running"}`,
  );

  // ------------------------------------------------------------ firewall
  const f = ui.phase("Firewall");
  const warnings = await firewall;
  for (const w of warnings) f.warn(w);
  f.done(warnings.length ? "see the warnings" : "allows TFTP and HTTP (or no firewall to check)");

  // ------------------------------------------------------- remote access
  // Spec 100: the Stolos Console on the LAN: listener, certificate, devices, firewall.
  const ra = ui.phase("Remote access");
  try {
    const { accessFacts } = await import("../archon/access/commands.ts");
    const { accessDoctor } = await import("../archon/access/doctor.ts");
    const { proc } = await import("@intellectual-frontiers/commons/ts/runtime");
    const facts = await accessFacts();
    const port = facts.listening?.port ?? standardPort("console-https");
    // Spec 103: where the console is not serving, can it have TCP 443? If not, what holds it.
    const live =
      facts.listening && Date.now() - Date.parse(facts.listening.at) < HEARTBEAT_STALE_MS;
    if (facts.configured && !live) {
      const { bindProblem, portHolder } = await import("../archon/access/holder.ts");
      const code = await bindProblem(port);
      if (code) facts.blocked = { port, code, holder: await portHolder(port) };
    }
    const fw = facts.configured
      ? await firewallWarnings([{ protocol: "TCP", port, what: "Stolos Console (HTTPS)" }])
      : [];
    for (const l of accessDoctor(facts, Date.now(), fw, proc.build.os)) {
      if (l.level === "hint") ra.hint("remote-access", l.msg, l.fix?.split(" (")[0]);
      else if (l.level === "action") ra.action(l.msg, l.fix ?? "", "E105-YOURS");
      else if (l.level === "pending") ra.pending(l.msg, l.fix ?? "");
      else ra.note(l.msg);
    }
    ra.done(facts.configured ? `${facts.devices} device(s) approved` : "this PC only");
  } catch (e) {
    ra.done(`not checked (${(e as Error).message})`);
  }

  // --------------------------------------------------------------- hosts
  const h = ui.phase("Hosts");
  const tokens = await loadTokens();
  const lines = (model?.hosts ?? [])
    .filter((x) => x.kind !== "workstation")
    .map((x) => {
      const t = tokens.find((y) => y.host === x.name);
      return `${x.name}: ${liveToken(tokens, x.name) ? "armed" : "not armed"}${
        (x.mac ?? t?.mac) ? ` · ${x.mac ?? t?.mac}` : ""
      }`;
    });
  h.done(lines.join(" · ") || "none");
  // --------------------------------------------------------------- email
  const em = ui.phase("Email");
  const { emailChecks } = await import("../archon/doctor/email.ts");
  const { bootSite } = await import("../archon/notify/notify.ts");
  const fleetForMail = await (
    await import("../archon/model/load.ts")
  )
    .loadFleet()
    .catch(() => undefined);
  await emailChecks(
    fleetForMail ? bootSite(fleetForMail) : undefined,
    em,
    "bun run stolos boot mail-setup",
    { send: o.send },
  );

  if (o.embedded) return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
  return ui.finish();
}
