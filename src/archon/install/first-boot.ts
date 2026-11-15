/**
 * `archon first-boot` (spec 005): run once by cloud-init on a freshly
 * installed host, after the first-boot script cloned the repository with this
 * host's deploy key. Converges the host, hands the deploy key to ops, verifies,
 * and pushes the host's first record, which proves the key works.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant H as The new host
 *   participant B as Boot server
 *   H->>H: clone the fleet repository, verify its signature
 *   H->>B: event: First boot
 *   H->>H: packages, accounts, files, units, tools, dotfiles
 *   H->>H: verify (ok, not set up yet, warnings, failures)
 *   H->>H: archon.sql: install record, inventory
 *   H->>B: event: Ready (or Done with problems)
 *   H->>H: start Ubuntu's daily upgrades
 * ```
 *
 * @module
 */

import { putRecord } from "../state/store.ts";
import { P } from "../core/paths.ts";
import { join } from "../core/path.ts";
import { ensureDir, exists } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { apply } from "../apply/apply.ts";
import { failedChecks, verify } from "../state/verify.ts";
import { loadFleet } from "../model/load.ts";
import type { HostDef } from "../model/types.ts";
import { UBUNTU_POINT } from "./ubuntu.ts";
import { BOOT_EVENTS, bootEvent } from "./report.ts";

const DEPLOY_KEY = "/etc/archon/deploy_key";
const OPS_KEY = "/home/ops/.ssh/archon_deploy_key";
/** The mail relay's token as the install delivered it (spec 027). */
const MAIL_DELIVERED = "/etc/archon/mail_credential.json";
/** The Cloudflare DNS token as the install delivered it (spec 032). */
const WEB_DELIVERED = "/etc/archon/web_credential.json";

/**
 * Runs first boot on a freshly installed host: converge, hand over the
 * delivered credentials and deploy key, verify, and push the first record.
 * Returns 1 when verification found failures, else 0.
 */
export async function firstBoot(host: HostDef): Promise<number> {
  const fleet = await loadFleet();
  // Each phase shows up in the boot server's window as it ends.
  const pending: Promise<void>[] = [];
  ui.onPhaseEnd = (phase, level, summary) =>
    void pending.push(bootEvent({ phase, level, summary }));
  await apply(host, { check: false });

  // The mail relay's token (spec 027): Postfix's sasl_passwd, root only.
  if (await exists(MAIL_DELIVERED)) {
    const { installCredential } = await import("../notify/commands.ts");
    await installCredential(await Deno.readTextFile(MAIL_DELIVERED));
    await Deno.remove(MAIL_DELIVERED);
  }

  // Spec 032: the Let's Encrypt store carried from the previous install, in
  // place before the tools sync installs and starts Traefik.
  {
    const { importAcme } = await import("../web/acme.ts");
    const done = await importAcme();
    if (done) ui.phase("Certificate").done(done);
  }

  // The Cloudflare DNS token (spec 032): root only, then this server's records.
  if (await exists(WEB_DELIVERED)) {
    const { installWebCredential, webDns } = await import("../web/commands.ts");
    await installWebCredential(await Deno.readTextFile(WEB_DELIVERED));
    await Deno.remove(WEB_DELIVERED);
    await webDns(host.name);
  }

  const k = ui.phase("GitHub");
  if (await exists(DEPLOY_KEY)) {
    await ensureDir("/home/ops/.ssh");
    await Deno.copyFile(DEPLOY_KEY, OPS_KEY);
    for (const [path, mode] of [["/home/ops/.ssh", 0o700], [OPS_KEY, 0o600]] as const) {
      await Deno.chmod(path, mode);
      await run(["chown", "ops:ops", path]);
    }
    await Deno.remove(DEPLOY_KEY);
  }
  // The checkout belongs to ops and the archon-ops group, shared (spec 006).
  await run(["chown", "-R", "ops:archon-ops", P.installedRepo]);
  await run(["chmod", "-R", "g+w", P.installedRepo]);
  await run(["find", P.installedRepo, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"]);
  await run(["git", "-C", P.installedRepo, "config", "core.sharedRepository", "group"]);
  await run(["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon.conf"]);
  await run(["git", "config", "--system", "--add", "safe.directory", P.installedRepo]);
  const git = (args: string[]) => run(["git", "-C", P.installedRepo, ...args], { asUser: "ops" });
  const branch = fleet.repository.branch ?? "main";
  const viaKey = await exists(OPS_KEY);
  if (viaKey) {
    await git(["remote", "set-url", "origin", `git@github.com:${fleet.repository.slug}.git`]);
  }
  const fetch = await git(["fetch", "-q", "origin", branch]);
  k.done(
    fetch.ok
      ? `ops reaches ${fleet.repository.slug} (${branch}) ${
        viaKey ? "with this host's deploy key" : "over HTTPS"
      }`
      : `fetch failed: ${fetch.stderr.trim()}`,
  );

  // Tools (spec 010), then the dotfiles that need chezmoi (spec 011).
  const { syncTools } = await import("../tools/sync.ts");
  await syncTools(host, { reportOnly: false });
  await apply(host, { check: false, only: ["dotfiles"] });

  const checks = await verify(host);

  const rec = ui.phase("Record");
  const head = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
  const failures = ui.problems.filter((p) => p.level === "fail").length +
    failedChecks(checks).length;
  // Spec 048: the install record stays on this machine (archon.sql, table
  // archon_install), read over SSH by fleet status; nothing is pushed.
  const pendingChecks = checks.filter((c) => !c.ok && c.level === "pending").length;
  const tally = {
    passed: checks.filter((c) => c.ok).length,
    total: checks.length - pendingChecks,
    pending: pendingChecks,
  };
  await putRecord(host.name, "install", "install", {
    host: host.name,
    ubuntu: UBUNTU_POINT,
    archon: head,
    // Spec 052: not set up yet is neither passed nor failed: counted apart.
    checks: { passed: tally.passed, total: tally.total, pending: tally.pending },
    // Every step that failed or warned, so a partial first boot shows.
    // Warnings (a transient network failure, a warning-level check) leave it ok;
    // the next successful apply settles anything left (spec 009).
    ok: !failures,
    problems: ui.problems.map((p) => ({
      level: p.level,
      step: p.phase,
      message: p.message,
      ...(p.fix ? { fix: p.fix } : {}),
    })),
  });
  // Spec 051: what this machine is, as it reports itself.
  const { recordInventory, collectInventory, describeInventory } = await import(
    "../state/inventory.ts"
  );
  await recordInventory(host.name).catch(() => false);
  // Spec 095: the birth snapshot, once: what Ubuntu put here is never drift.
  const { recordBirth } = await import("../proposal/collect.ts");
  await recordBirth(host.name).catch((e) =>
    rec.warn(
      `birth snapshot not taken: ${(e as Error).message}`,
      "sudo archon drift --collect takes it (late)",
    )
  );
  const machine = await collectInventory().then(describeInventory).catch(() => "");
  rec.done(
    `recorded in ${P.state}/archon.sql (${head})${failures ? ` · ${failures} problem(s)` : ""}${
      machine ? ` · ${machine}` : ""
    }`,
  );
  await ensureDir(P.varLib);
  await Deno.writeTextFile(join(P.varLib, ".installed"), new Date().toISOString() + "\n");
  const { nextSteps } = await import("../observe/next.ts");
  const address = (await run(["hostname", "-I"])).stdout.trim().split(/\s+/)[0] || undefined;
  ui.next.push(
    `${host.name} is ready. Next:`,
    ...nextSteps({ host, fleet, address }).map((l) => `  ${l}`),
  );
  const failed = ui.problems.filter((p) => p.level === "fail").length +
    failedChecks(checks).length;
  pending.push(bootEvent({
    phase: failed ? "Done with problems" : "Ready",
    level: failed ? "fail" : "ok",
    summary: `${tally.passed}/${tally.total} checks${
      tally.pending ? ` · ${tally.pending} not set up yet` : ""
    } · ssh ${host.name}${
      failed ? ` · ${failed} problem(s), see archon query "select * from archon_install"` : ""
    }`,
  }));
  await Promise.all(pending);
  await Deno.remove(BOOT_EVENTS).catch(() => {});
  // Spec 026: the doctor's email checks, their findings mailed through archon
  // and Postfix, so every new server proves its mail on its first boot.
  const { emailChecks } = await import("../doctor/email.ts");
  const { localSite } = await import("../notify/events.ts");
  await emailChecks(
    await localSite(host.name),
    ui.phase("Email"),
    `on the boot machine: deno task stolos boot mail-push ${host.name}`,
    { send: "installed" },
  ).catch((e) => ui.active("Email").warn(`email checks: ${(e as Error).message}`));
  // Spec 025: the install finished, to the shared mailbox, with its record.
  const { notify } = await import("../notify/events.ts");
  await notify({
    event: failed ? "✗ Done with problems" : "✓ Ready",
    level: failed ? "fail" : "info",
    what:
      `${host.name} installed Ubuntu ${UBUNTU_POINT} with Archon ${head}: ${tally.passed}/${tally.total} checks passed${
        tally.pending ? ` (${tally.pending} not set up yet)` : ""
      }${failed ? `, ${failed} problem(s)` : ""}.`,
    todo: failed
      ? `ssh ${host.name}, then archon verify (the install record: archon query "select * from archon_install").`
      : `ssh ${host.name}; archon observe; Cockpit at https://${host.name}:9090 from the local network.`,
    key: `install:${host.name}:${head}:${new Date().toISOString().slice(0, 13)}`,
  }, host.name);
  // Ubuntu's updates published since the installer image (spec 009): start the
  // daily run now, in the background, instead of waiting up to a day.
  await run(["systemctl", "start", "--no-block", "apt-daily.service", "apt-daily-upgrade.service"]);
  return failed ? 1 : 0;
}
