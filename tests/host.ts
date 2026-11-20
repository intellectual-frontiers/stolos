/**
 * A host root for tests of root's side (the seam of `core/paths.ts`: `ARCHON_ROOT`). The test's
 * own process acts as root on a host whose `/` is a temporary folder: `/etc/archon/host` names the
 * host (the example lab's `alpha`), `/etc/archon/fleet` the fleet, and the mail relay's credential
 * is in place, so a message is queued in the host's spool (`/var/spool/archon/notify`) as on a
 * server. The programs archon runs are stand-ins on `PATH` (POSIX shell scripts): each records its
 * argument vector in `calls.log` and does what the test gives it, by default nothing (exit 0).
 * `restore()` puts the environment back and removes the folder.
 *
 * @module
 */

import { fromBase64 } from "@intellectual-frontiers/formats";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { resetRoots } from "../src/archon/core/paths.ts";
import type { Queued } from "../src/archon/notify/notify.ts";

/** The programs every host root has a stand-in for (record and exit 0), unless a test gives its own. */
const DEFAULT_STANDINS = [
  "systemctl",
  "logger",
  "journalctl",
  "chown",
  "runuser",
  "systemd-tmpfiles",
  "loginctl",
  "ufw",
  "apt-get",
  "dpkg-query",
  "snap",
  "lxc",
  "podman",
  "etckeeper",
  "sudo",
  "systemd-sysusers",
  "useradd",
  "usermod",
  "debconf-set-selections",
  "add-shell",
  "apt-cache",
  // The machine's own package database and osquery: real ones read the test machine, not the
  // host root (dpkg --verify checks every installed file: minutes on a CI runner).
  "dpkg",
  "debsums",
  "osqueryi",
  // Changes the real machine's PAM configuration.
  "pam-auth-update",
];

/** A host root in this test's process (see the module). */
export interface HostRoot {
  /** The folder that stands in for `/`. */
  readonly root: string;
  /** The stand-ins' folder, first on PATH. */
  readonly bin: string;
  /** A path on the host (`/var/lib/archon/...`), inside the root. */
  at(p: string): string;
  /** Write a stand-in for `name`: `body` runs after the call is recorded (POSIX sh). */
  standIn(name: string, body?: string): Promise<void>;
  /** Every recorded call, `name arg arg ...`, in order. */
  calls(): Promise<string[]>;
  /** The messages queued in the host's spool, oldest first. */
  spool(): Promise<Queued[]>;
  /** Put the environment back and remove the root. */
  restore(): Promise<void>;
}

/**
 * Whether host roots work here: a host is Ubuntu, so root's side runs on Linux (a machine is a host
 * only there, `notify/events.ts`), with GNU tools beside the stand-ins (POSIX shell scripts).
 */
export const HOST_ROOT_SKIP: string | false =
  proc.build.os === "linux" ? false : "root's side runs on the hosts, which are Linux";

/** A new host root, active in this process until `restore()`. */
export async function hostRoot(o: { host?: string; fleet?: string } = {}): Promise<HostRoot> {
  const dir = await fs.makeTempDir({ prefix: "archon-host-root-" });
  const root = path.join(dir, "root");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  const at = (p: string): string => path.join(root, p);
  for (const d of [
    "/etc/archon",
    "/etc/postfix",
    "/var/lib/archon/status",
    "/var/lib/archon/reports",
    "/var/lib/archon-keys",
    "/var/log/archon",
    "/var/spool/archon/notify",
    "/run",
  ]) {
    await fs.ensureDir(at(d));
  }
  await fs.ensureDir(bin);
  await fs.writeTextFile(at("/etc/archon/host"), `${o.host ?? "alpha"}\n`);
  await fs.writeTextFile(at("/etc/archon/fleet"), `${o.fleet ?? "lab"}\n`);
  await fs.writeTextFile(
    at("/etc/postfix/sasl_passwd"),
    "[smtp.example.net]:465 api_token:test-token-not-a-secret\n",
  );
  const standIn = async (name: string, body = ""): Promise<void> => {
    const file = path.join(bin, name);
    await fs.writeTextFile(
      file,
      `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\nexit 0\n`,
    );
    await fs.chmod(file, 0o755);
  };
  for (const n of DEFAULT_STANDINS) await standIn(n);
  const saved = new Map<string, string | undefined>();
  const set = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, proc.env.get(k));
    if (v === undefined) proc.env.delete(k);
    else proc.env.set(k, v);
  };
  set("ARCHON_ROOT", root);
  set("PATH", `${bin}:${proc.env.get("PATH") ?? ""}`);
  set("ARCHON_FLEET", o.fleet ?? "lab");
  set("ARCHON_LOG", undefined);
  resetRoots();
  // The process-wide UI: quiet, and this root's problems only (put back by restore).
  const { ui } = await import("../src/archon/core/ui.ts");
  const quiet = ui.quiet;
  const problems = ui.problems.splice(0);
  const next = ui.next.splice(0);
  ui.quiet = true;
  return {
    root,
    bin,
    at,
    standIn,
    calls: async () =>
      ((await fs.readTextOr(log)) ?? "")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => l.trimEnd()),
    spool: async () => {
      const out: Queued[] = [];
      const d = at("/var/spool/archon/notify");
      for (const f of (await fs.listFiles(d, ".json")).sort()) {
        if (f === "keys.json") continue;
        out.push(JSON.parse(await fs.readTextFile(path.join(d, f))) as Queued);
      }
      return out;
    },
    restore: async () => {
      ui.quiet = quiet;
      ui.problems.splice(0, ui.problems.length, ...problems);
      ui.next.splice(0, ui.next.length, ...next);
      for (const [k, v] of saved) {
        if (v === undefined) proc.env.delete(k);
        else proc.env.set(k, v);
      }
      resetRoots();
      await fs.remove(dir, { recursive: true });
    },
  };
}

/** A queued message's attachment, decoded as text (gzip is not expected for small files). */
export function attachmentText(q: Queued, name: string): string | undefined {
  const a = q.attachments.find((x) => x.name === name);
  if (a === undefined) return undefined;
  const bytes = fromBase64(a.b64);
  return bytes.kind === "ok" ? new TextDecoder().decode(bytes.value) : undefined;
}
