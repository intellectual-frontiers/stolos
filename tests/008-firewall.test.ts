/**
 * Spec 008: ufw's defaults and the Archon profile; network configuration left to the installer.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { userData } from "../src/archon/render/autoinstall.ts";
import { fleet, host } from "./fixtures.ts";

proves(
  ["008-firewall FR-002"],
  "008: ufw denies incoming, allows outgoing, allows Archon, and is enabled",
  () => {
    const plan = resolvePlan(host(), fleet());
    const f = plan.files.find((x) => x.path === "/etc/ufw/applications.d/archon");
    assertExists(f);
    const runs = (f.onChange ?? []).flatMap((a) => (a.kind === "run" ? [a.argv.join(" ")] : []));
    const order = [
      "ufw app update Archon",
      "ufw default deny incoming",
      "ufw default allow outgoing",
      "ufw allow Archon",
      "ufw --force enable",
      "ufw reload",
    ].map((c) => runs.indexOf(c));
    assert(!order.includes(-1), runs.join("\n"));
    assertEquals(
      [...order].sort((a, b) => a - b),
      order,
      "in this order",
    );
    // ufw itself is Ubuntu's, enabled and verified active.
    const u = plan.units.find((x) => x.unitName === "ufw.service");
    assertEquals(
      [u?.managed, u?.state, u?.verify],
      [false, "enabled", "systemctl is-active ufw.service"],
    );
  },
);

proves(
  ["008-firewall FR-003"],
  "008: the network is netplan from the installer; Archon writes no network configuration, guests add LXD's bridge",
  () => {
    const plan = resolvePlan(host(), fleet());
    assert(!plan.files.some((f) => f.path.startsWith("/etc/netplan/")), "no netplan files");
    assert(
      !plan.files.some((f) => f.path.startsWith("/etc/systemd/network/")),
      "no networkd files",
    );
    const ai = (
      JSON.parse(
        userData({ fleet: fleet(), host: host(), base: "http://x/" }, { passwordHash: "x" }).slice(
          "#cloud-config\n".length,
        ),
      ) as {
        autoinstall: {
          network: { version: number; ethernets: Record<string, { dhcp4: boolean }> };
        };
      }
    ).autoinstall;
    assertEquals(ai.network.version, 2);
    assertEquals(ai.network.ethernets["uplink"]?.dhcp4, true);
    // A host with guests: LXD's own bridge (spec 017), not a change to the host's netplan.
    const g = resolvePlan(
      host({
        guests: [{ name: "db", kind: "container", image: "ubuntu:26.04", data: "ephemeral" }],
      }),
      fleet(),
    );
    assert(!g.files.some((f) => f.path.startsWith("/etc/netplan/")));
    const preseed = g.files.find((f) => f.path === "/etc/archon/lxd-preseed.yaml")?.content ?? "";
    assert(preseed.includes("- name: lxdbr0\n  type: bridge"), preseed);
  },
);
