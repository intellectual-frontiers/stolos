/**
 * `deno task boot doctor` (spec 004): one read-only look at this boot machine,
 * with the fix for each problem: the checkout (hosts install from GitHub, so
 * local changes must be pushed), the model, secrets, Ubuntu's files, the
 * network, the ports, and the firewall. It changes nothing.
 *
 * @module
 */

import { join } from "../archon/core/path.ts";
import { exists } from "../archon/core/fsx.ts";
import { run } from "../archon/core/exec.ts";
import { P } from "../archon/core/paths.ts";
import { ui } from "../archon/core/ui.ts";
import { liveToken, loadTokens, SECRETS } from "../archon/core/secrets.ts";
import { lanAddresses } from "../archon/core/net.ts";
import { HOST_KEY_TYPES } from "../archon/install/host-keys.ts";
import { cacheDir } from "./assets.ts";
import { UBUNTU } from "./pins.ts";
import { firewallWarnings } from "./firewall.ts";

export async function doctor(
  o: { port: number; send?: string; embedded?: boolean },
): Promise<number> {
  // Embedded (vault restore runs it): its phases join the caller's run and summary.
  if (o.embedded) ui.say(`${ui.emoji ? "🩺" : "*"} ${ui.dim("boot doctor")}`);
  else ui.header("Archon boot doctor", "read-only");

  // ------------------------------------------------------------ checkout
  const g = ui.phase("Checkout");
  const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);
  g.status("fetching origin");
  const fetched = (await git(["fetch", "--quiet", "origin"])).ok;
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const dirty = (await git(["status", "--porcelain", "--", "src/", "specs/", "home/"])).stdout
    .split("\n").filter(Boolean);
  const ahead = Number((await git(["rev-list", "--count", `origin/${branch}..HEAD`])).stdout) || 0;
  const behind = Number((await git(["rev-list", "--count", `HEAD..origin/${branch}`])).stdout) || 0;
  if (!fetched) {
    g.warn("could not reach GitHub to compare", "check this PC's network and gh auth status");
  }
  if (dirty.length) {
    g.fail(
      `${dirty.length} change(s) not committed (${
        dirty.map((l) => l.slice(3)).slice(0, 3).join(", ")
      }${dirty.length > 3 ? ", ..." : ""}): hosts install from GitHub and would not see them`,
      'git add -A; git commit -m "<spec>: <what>"; git push',
    );
  }
  if (ahead) g.fail(`${ahead} commit(s) not pushed: hosts would not see them`, "git push");
  if (behind) g.warn(`${behind} new commit(s) on GitHub`, "git pull, then restart boot serve");
  g.done(dirty.length || ahead || behind ? "needs attention" : `${branch}, in step with GitHub`);

  // --------------------------------------------------------------- model
  const m = ui.phase("Model");
  const { loadModel } = await import("../archon/build.ts");
  const model = await loadModel().catch((e) => {
    m.fail((e as Error).message, "deno task archon fleet init");
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

  // ------------------------------------------------------------- secrets
  const s = ui.phase("Secrets");
  if (!(await exists(SECRETS.adminPasswordHash))) {
    s.fail("no admin password hash", "deno task archon fleet init");
  }
  for (const h of (model?.hosts ?? []).filter((x) => x.kind !== "workstation")) {
    if (!(await exists(SECRETS.deployKey(h.name)))) {
      s.warn(
        `${h.name} has no deploy key: it will clone over HTTPS and cannot push`,
        `deno task archon host add ${h.name} --force`,
      );
    }
    const keys = await Promise.all(HOST_KEY_TYPES.map((t) => exists(SECRETS.hostKey(h.name, t))));
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
    (va.severity === "red" ? s.fail : s.warn).call(
      s,
      `${names.length} secret(s) ${
        va.lastBackup ? "newer than the last backup" : "never backed up"
      }: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""}`,
      "deno task boot vault backup, then move the ZIP somewhere safe",
    );
  }
  await remind();
  await installPrePushHook().catch(() => false);
  s.done(SECRETS.dir);

  // ------------------------------------------------------- Ubuntu's files
  const u = ui.phase("Ubuntu files");
  const missing: string[] = [];
  for (const name of [...Object.keys(UBUNTU.files), UBUNTU.iso.name]) {
    if (!(await exists(join(cacheDir(), name)))) missing.push(name);
  }
  if (missing.length) {
    u.warn(
      `not downloaded yet: ${missing.join(", ")}`,
      "deno task boot serve downloads and verifies them",
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
    .then((r) => r.ok).catch(() => false);
  if (!up) {
    for (const [proto, port] of [["TCP", o.port], ["UDP", 69]] as const) {
      try {
        if (proto === "TCP") Deno.listen({ port, hostname: "0.0.0.0" }).close();
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

  // --------------------------------------------------------------- hosts
  const h = ui.phase("Hosts");
  const tokens = await loadTokens();
  const lines = (model?.hosts ?? []).filter((x) => x.kind !== "workstation").map((x) => {
    const t = tokens.find((y) => y.host === x.name);
    return `${x.name}: ${liveToken(tokens, x.name) ? "armed" : "not armed"}${
      x.mac ?? t?.mac ? ` · ${x.mac ?? t?.mac}` : ""
    }`;
  });
  h.done(lines.join(" · ") || "none");
  // --------------------------------------------------------------- email
  const em = ui.phase("Email");
  const { emailChecks } = await import("../archon/doctor/email.ts");
  const { bootSite } = await import("../archon/notify/notify.ts");
  const fleetForMail = await (await import("../archon/model/load.ts")).loadFleet().catch(() =>
    undefined
  );
  await emailChecks(
    fleetForMail ? bootSite(fleetForMail) : undefined,
    em,
    "deno task boot mail-setup",
    { send: o.send },
  );

  if (o.embedded) return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
  return ui.finish();
}
