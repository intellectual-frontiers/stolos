/**
 * Spec 007: the installer's SSH settings, port 22 in the model, and GitHub's host key.
 *
 * @module
 */
import { assertEquals, assertExists, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { GITHUB_KNOWN_HOSTS, userData } from "../src/archon/render/autoinstall.ts";
import { ufwProfile } from "../src/archon/capabilities/firewall.ts";
import { fleet, host, KEY } from "./fixtures.ts";

proves(
  ["007-ssh FR-001"],
  "007: the installer turns password SSH off and installs the fleet admin's GitHub keys",
  () => {
    const second =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsecondsecondsecondsecondsecondsecondsec b@laptop";
    const f = fleet();
    f.admin.github.sshKeys = [KEY, second];
    const u = userData({ fleet: f, host: host(), base: "http://x/" }, { passwordHash: "x" });
    const ai = (
      JSON.parse(u.slice("#cloud-config\n".length)) as {
        autoinstall: {
          ssh: { "install-server": boolean; "allow-pw": boolean; "authorized-keys": string[] };
        };
      }
    ).autoinstall;
    assertEquals(ai.ssh, {
      "install-server": true,
      "allow-pw": false,
      "authorized-keys": [KEY, second],
    });
  },
);

proves(["007-ssh FR-003"], "007: port 22/tcp is modeled, so the firewall admits it", () => {
  const plan = resolvePlan(host(), fleet());
  assertEquals(
    plan.ports.filter((p) => p.port === 22),
    [{ port: 22, protocol: "tcp", spec: "007-ssh" }],
  );
  const profile = ufwProfile(plan);
  const ports = profile.split("\n").find((l) => l.startsWith("ports="));
  assertExists(ports);
  assertEquals(ports.slice("ports=".length).split("|")[0]?.split("/")[0]?.split(",")[0], "22");
});

proves(
  ["007-ssh FR-004"],
  "007: /etc/ssh/ssh_known_hosts holds GitHub's published host key",
  () => {
    const plan = resolvePlan(host(), fleet());
    const f = plan.files.find((x) => x.path === "/etc/ssh/ssh_known_hosts");
    assertExists(f);
    assertEquals([f.mode, f.owner], ["0644", "root"]);
    // GitHub's ed25519 key, as https://api.github.com/meta publishes it.
    assertEquals(
      f.content,
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
    );
    assertEquals(f.content, GITHUB_KNOWN_HOSTS);
  },
);
