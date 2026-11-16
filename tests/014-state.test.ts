/**
 * Spec 014: drift from the plan (capture), and provenance for the applies that changed something.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { assertEquals, proves } from "@intellectual-frontiers/commons/ts/runtime/test";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";

/** The lab in a sandbox, a folder of stand-in commands first on PATH, and a way to run a probe. */
async function lab(tools: Record<string, string>) {
  const sb = await sandbox("archon-state-test-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await fs.copy(
    path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
    path.join(repo, "fleets", "lab"),
  );
  await linkEngine(repo);
  const bin = path.join(sb.home, "bin");
  await fs.mkdir(bin);
  for (const [name, body] of Object.entries(tools)) {
    await fs.writeTextFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    await fs.chmod(path.join(bin, name), 0o755);
  }
  const src = (rel: string) =>
    JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", rel)).href);
  const run = async (code: string): Promise<unknown> => {
    const file = path.join(sb.home, `probe-${crypto.randomUUID()}.ts`);
    await fs.writeTextFile(
      file,
      code.replace(/@src\/([\w/.-]+)/g, (_, rel: string) => src(rel)),
    );
    const r = await sb.run(file, [], "", {
      ARCHON_REPO: repo,
      ARCHON_FLEET: "lab",
      PATH: `${bin}:${proc.env.get("PATH") ?? ""}`,
    });
    assertEquals(r.code, 0, r.out);
    return JSON.parse(r.out.trim().split("\n").pop() ?? "null");
  };
  return { sb, run };
}

proves(
  ["014-state FR-001"],
  "014: capture's drift: missing packages, units not in their state, unmodeled listening ports (DHCP clients excepted)",
  async () => {
    // A host where every modeled package is installed but ufw, every unit is enabled but the
    // backup timer, and something listens on TCP 8443 beside sshd and the DHCP client.
    const l = await lab({
      "dpkg-query": `cat <<'EOF'\n${["apparmor", "chrony", "git", "openssh-server", "fish", "tmux"].join("\n")}\nEOF`,
      systemctl: `case "$2" in archon-backup.timer) echo disabled;; *) echo enabled;; esac`,
    });
    try {
      const got = await l.run(
        `import { drift } from @src/state/capture.ts;
import { loadHosts } from @src/model/load.ts;
const alpha = (await loadHosts()).find((h) => h.name === "alpha");
const d = await drift(alpha, { host: "alpha", captured: "", ubuntu: "26.04", kernel: "", manualPackages: [], snaps: [], enabledUnits: [], users: [], tools: {},
  listening: ["tcp/0.0.0.0:22", "tcp/0.0.0.0:8443", "udp/10.0.30.57%enp1s0:68", "tcp/127.0.0.1:4318", "udp/127.0.0.53%lo:53"] });
console.log(JSON.stringify({ ufw: d.missingPackages.includes("ufw"), git: d.missingPackages.includes("git"), units: [...d.unitsNotInDesiredState].sort(), ports: d.unmodeledListeningPorts }));`,
      );
      assertEquals(got, {
        ufw: true,
        git: false,
        units: ["archon-backup.timer (want enabled)", ...unitsMaskedButEnabled()].sort(),
        ports: ["tcp/0.0.0.0:8443"],
      });
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "stand-in commands written as POSIX shell scripts" },
);

/** Units the plan masks: the stand-in systemctl calls every other unit enabled, so they drift. */
function unitsMaskedButEnabled(): string[] {
  return [
    "avahi-daemon.service (want masked)",
    "avahi-daemon.socket (want masked)",
    "smbd.service (want masked)",
    "nmbd.service (want masked)",
    "postgresql.service (want masked)",
    "archon-s3.service (want masked)",
    "archon-otel-ui.service (want masked)",
  ];
}

proves(
  ["014-state FR-002"],
  "014: an apply that changed something is a provenance activity; one that changed nothing is not",
  async () => {
    const l = await lab({ git: "echo 0123456789abcdef0123456789abcdef01234567" });
    try {
      const got = await l.run(
        `import { loadActivities, recordActivity } from @src/prov/prov.ts;
const none = await recordActivity("alpha", { started: new Date("2026-11-10T09:00:00Z"), ended: new Date("2026-11-10T09:00:05Z"), changes: [], failed: false });
const one = await recordActivity("alpha", { started: new Date("2026-11-10T10:00:00Z"), ended: new Date("2026-11-10T10:01:00Z"), changes: ["install tmux", "write /etc/archon/host"], failed: false });
const all = await loadActivities("alpha");
console.log(JSON.stringify({ none: none ?? null, one, all: all.map((a) => [a.started, a.ended, a.commit, a.changes, a.failed]) }));`,
      );
      assertEquals(got, {
        none: null,
        one: "2026-11-10T10:00:00.000Z",
        all: [
          [
            "2026-11-10T10:00:00.000Z",
            "2026-11-10T10:01:00.000Z",
            "0123456789abcdef0123456789abcdef01234567",
            ["install tmux", "write /etc/archon/host"],
            false,
          ],
        ],
      });
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "a stand-in git written as a POSIX shell script" },
);
