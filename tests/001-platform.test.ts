/**
 * Spec 001: Ubuntu Server's own components, verified and never replaced; the host's name and
 * Archon's state directories; overrides of Ubuntu defaults documented in the spec that makes them.
 *
 * @module
 */
import { fs, path } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { platform, RELIED_ON } from "../src/archon/capabilities/platform.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { userData } from "../src/archon/render/autoinstall.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

proves(
  ["001-platform FR-001"],
  "001: platform verifies Ubuntu's relied-on defaults and installs nothing of its own",
  () => {
    const c = platform()({ host: host(), fleet: fleet(), users: [] });
    // Exactly the packages Ubuntu Server installs (the spec's table), nothing added.
    assertEquals(
      (c.packages ?? []).map((p) => p.name),
      [...RELIED_ON],
    );
    for (const p of c.packages ?? []) {
      assertEquals(p.source, undefined, `${p.name} comes from Ubuntu's archive`);
      assertEquals(p.ppa, undefined, p.name);
      assertEquals(p.repo, undefined, p.name);
    }
    // No tools, no repositories, no ports.
    assertEquals(c.tools, undefined);
    assertEquals(c.aptRepos, undefined);
    assertEquals(c.ports, undefined);
    // Ubuntu's own units: no unit file written, each verified.
    const units = c.units ?? [];
    for (const u of units) {
      assertEquals(u.managed, false, u.unitName);
      assertEquals(u.content, undefined, u.unitName);
      assert(u.verify !== "", u.unitName);
    }
    for (const name of [
      "systemd-networkd.service",
      "systemd-resolved.service",
      "chrony.service",
      "snapd.socket",
      "apparmor.service",
    ]) {
      const u = units.find((x) => x.unitName === name);
      assertExists(u, name);
      assertEquals(u.state, "ignore", `${name} is left as Ubuntu set it`);
      assertEquals(u.verify, `systemctl is-active ${name}`);
    }
  },
);

proves(
  ["001-platform FR-002"],
  "001: /etc/archon/host names the host, written by apply and by the install",
  () => {
    // What `archon` reads (main.ts localHostName) to pick the host's model; the VM end-to-end run
    // (tests/e2e) then runs `archon verify` on the installed host, which picks its model this way.
    for (const name of ["alpha", "beta"]) {
      const plan = resolvePlan(host({ name }), fleet());
      const f = plan.files.find((x) => x.path === "/etc/archon/host");
      assertExists(f);
      assertEquals(f.content, `${name}\n`);
      assertEquals([f.mode, f.owner], ["0644", "root"]);
    }
    const u = userData(
      {
        fleet: fleet(),
        host: host({ name: "beta" }),
        base: "http://10.0.0.5:8080/install/beta/t/",
      },
      { passwordHash: "x" },
    );
    const ai = (
      JSON.parse(u.slice("#cloud-config\n".length)) as {
        autoinstall: { "user-data": { write_files: Array<{ path: string; content: string }> } };
      }
    ).autoinstall;
    const written = ai["user-data"].write_files.find((f) => f.path === "/etc/archon/host");
    assertEquals(written?.content, "beta\n");
  },
);

proves(
  ["001-platform FR-003"],
  "001: /var/lib/archon and its state directories come from tmpfiles.d",
  () => {
    const plan = resolvePlan(host(), fleet());
    const f = plan.files.find((x) => x.path === "/etc/tmpfiles.d/archon.conf");
    assertExists(f);
    const lines = (f.content ?? "").split("\n");
    for (const d of [
      "/var/lib/archon",
      "/var/lib/archon/reports",
      "/var/lib/archon/status",
      "/var/lib/archon/prov",
      "/var/lib/archon/snapshots",
    ]) {
      assert(
        lines.some((l) => new RegExp(`^d ${d} \\d{4} root archon-ops -$`).test(l)),
        `${d} is a tmpfiles.d directory`,
      );
    }
    // Applied at once when it changes, not only at the next boot.
    assert(
      (f.onChange ?? []).some(
        (a) =>
          a.kind === "run" &&
          a.argv.join(" ") === "systemd-tmpfiles --create /etc/tmpfiles.d/archon.conf",
      ),
    );
  },
);

/**
 * The overrides this engine makes of Ubuntu's own configuration (a drop-in into one of Ubuntu's
 * `*.d` folders, or `/etc/default`), each with a word its spec's section must say.
 */
const OVERRIDES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/etc\/systemd\/resolved\.conf\.d\//, "resolved"],
  [/^\/etc\/ssh\/sshd_config\.d\//, "Password authentication"],
  [/^\/etc\/apt\/apt\.conf\.d\/52archon-updates$/, "-updates"],
  [/^\/etc\/apt\/apt\.conf\.d\/52archon-network$/, "IPv4"],
  [/^\/etc\/apt\/apt\.conf\.d\/52archon-ppas$/, "PPAs"],
  [/^\/etc\/systemd\/journald\.conf\.d\//, "journald"],
  [/^\/etc\/default\/pmlogger_timers$/, "PCP"],
  [/^\/etc\/pcp\/pmproxy\/pmproxy\.options$/, "pmproxy"],
  [/^\/etc\/systemd\/system\/podman\.socket\.d\//, "podman.socket"],
  [/^\/etc\/postgresql-common\/createcluster\.d\//, "create_main_cluster"],
];

/**
 * A file that may change an Ubuntu default: a drop-in or an option file of Ubuntu's own
 * configuration. Archon's own namespace, and drop-ins that only add Archon's own things (its
 * groups, directories, containers, login banners, firewall profile, PAM services, and the operators' sudo rule),
 * change nothing Ubuntu set.
 */
function overridesUbuntu(p: string): boolean {
  if (!p.startsWith("/etc/")) return false;
  if (
    /^\/etc\/(archon\/|tmpfiles\.d\/|sysusers\.d\/|containers\/systemd\/|update-motd\.d\/|ufw\/applications\.d\/|sudoers\.d\/archon$|pam\.d\/archon-)/.test(
      p,
    )
  ) {
    return false;
  }
  return /\.d\//.test(p) || p.startsWith("/etc/default/") || p.endsWith(".options");
}

/** The body of a spec's "Overrides of Ubuntu defaults" section. */
async function overridesSection(spec: string): Promise<string> {
  const text = await fs.readTextFile(path.join(ENGINE_ROOT, "specs", spec, "spec.md"));
  const head = "### Overrides of Ubuntu defaults";
  const at = text.indexOf(head);
  assert(at >= 0, `${spec}/spec.md has no "${head}" section`);
  const rest = text.slice(at + head.length);
  const end = rest.search(/\n#{1,3} /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

proves(
  ["001-platform FR-004"],
  "001: every override of an Ubuntu default is in its spec's 'Overrides of Ubuntu defaults' section",
  async () => {
    // An IPv4-only network, so the apt network drop-in is rendered too.
    const plan = resolvePlan(host(), fleet({ network: { ipv6: false } }));
    const files = plan.files.filter((f) => overridesUbuntu(f.path));
    assert(files.length >= 8, files.map((f) => f.path).join(", "));
    for (const f of files) {
      const known = OVERRIDES.find(([re]) => re.test(f.path));
      assertExists(known, `${f.path} (${f.spec}) overrides an Ubuntu default no spec documents`);
      const section = await overridesSection(f.spec);
      assertStringIncludes(section, known[1], `${f.spec} documents ${f.path}`);
    }
    // Specs that override nothing say so.
    assertEquals(await overridesSection("006-accounts"), "None.");
  },
);
