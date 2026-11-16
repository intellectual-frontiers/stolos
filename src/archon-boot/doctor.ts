/**
 * `bun run stolos boot doctor` (spec 004): one read-only look at this boot machine,
 * with the fix for each problem: the checkout (hosts install from GitHub, so
 * local changes must be pushed), the model, secrets, Ubuntu's files, the
 * network, the ports, and the firewall. It changes nothing.
 *
 * @module
 */

import { fs, path, tcp } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../archon/core/exec.ts";
import { P } from "../archon/core/paths.ts";
import { ui } from "../archon/core/ui.ts";
import { liveToken, loadTokens, SECRETS } from "../archon/core/secrets.ts";
import { lanAddresses } from "../archon/core/net.ts";
import { HOST_KEY_TYPES } from "../archon/install/host-keys.ts";
import { cacheDir } from "./assets.ts";
import { UBUNTU } from "./pins.ts";
import { firewallWarnings } from "./firewall.ts";

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

  // ------------------------------------------------------------ checkout
  const g = ui.phase("Checkout");
  const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);
  g.status("fetching origin");
  const fetched = (await git(["fetch", "--quiet", "origin"])).ok;
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  // The whole repository, new files included (fleets/<fleet>/ first of all); .gitignore keeps out/ out.
  const dirty = (await git(["status", "--porcelain", "--untracked-files=all"])).stdout
    .split("\n")
    .filter(Boolean);
  const ahead = Number((await git(["rev-list", "--count", `origin/${branch}..HEAD`])).stdout) || 0;
  const behind = Number((await git(["rev-list", "--count", `HEAD..origin/${branch}`])).stdout) || 0;
  if (!fetched) {
    g.warn("could not reach GitHub to compare", "check this PC's network and gh auth status");
  }
  if (dirty.length) {
    // Spec 099: records Stolos wrote (an install's registration, ...) are expected, not a mistake.
    const { porcelainPath, splitChanges, yoursNamed } = await import("../archon/fleet/records.ts");
    const { records, yours } = splitChanges(dirty.map(porcelainPath));
    if (records.length) {
      g.action(
        `not sent yet: ${records.map((r) => r.what).join("; ")}`,
        "bun run stolos update (it sends them with one signed commit)",
      );
    }
    if (yours.length) {
      g.action(
        `${yours.length} change(s) of yours not sent yet (${yours.slice(0, 3).map(yoursNamed).join(", ")}${
          yours.length > 3 ? ", ..." : ""
        }): servers see them once they are sent`,
        "bun run stolos apply (or bun run stolos update, which offers to send them)",
      );
    }
  }
  if (ahead) {
    g.action(
      `${ahead} commit(s) not sent yet: servers see them once they are`,
      "bun run stolos apply",
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
  const { remind, installPrePushHook } = await import("../archon/vault/reminder.ts");
  const va = await assess();
  if (va.unbacked.length) {
    const names = va.unbacked.map((x) => x.name);
    // Spec 099: a backup to make is your move (⚡); a week overdue, or keys never backed up, a warning.
    (va.severity === "red" ? s.warn.bind(s) : s.action.bind(s))(
      `${names.length} secret(s) ${
        va.lastBackup ? "newer than the last backup" : "never backed up"
      }: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""}`,
      "bun run stolos vault backup, then move the ZIP somewhere safe",
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
      ["UDP", 69],
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
        n.fail(
          `${proto} port ${port} is not free (${code})`,
          port === 69
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
  const warnings = await firewallWarnings([
    { protocol: "TCP", port: o.port, what: "HTTP" },
    { protocol: "UDP", port: 69, what: "TFTP" },
  ]);
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
    const port = facts.listening?.port ?? 443;
    const fw = facts.configured
      ? await firewallWarnings([{ protocol: "TCP", port, what: "Stolos Console (HTTPS)" }])
      : [];
    for (const l of accessDoctor(facts, Date.now(), fw, proc.build.os)) {
      if (l.level === "action") ra.action(l.msg, l.fix ?? "");
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
