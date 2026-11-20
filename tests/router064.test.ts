/**
 * Spec 064: the router filters networks; the machine restricts none. Traefik, smb.conf, the
 * firewall's one profile, and PostgreSQL's publishing admit every network; what decides how a person
 * signs in (SSH passwords, Cockpit) still follows the fleet's local networks; and the messages say
 * who reaches what is the router's decision.
 *
 * @module
 */

import { fs, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  the,
} from "@intellectual-frontiers/test";
import { fleet, host } from "./fixtures.ts";
import { at, parse } from "./console/tree.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { traefikDynamic, traefikStatic } from "../src/archon/web/config.ts";
import { smbConf } from "../src/archon/smb/config.ts";
import { usersFor } from "../src/archon/model/load.ts";
import { sshdConfig } from "../src/archon/capabilities/ssh.ts";
import { archonMotd } from "../src/archon/render/motd.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import type { HostPlan } from "../src/archon/model/types.ts";

const webFleet = () => fleet({ web: { domain: "lab.example.net" } });
const otelOn = { "otel-ui": { enabled: true, by: "alice", at: "t", data: "ephemeral" as const } };
const ufwProfile = (plan: HostPlan): string =>
  the(plan.files.find((f) => f.path === "/etc/ufw/applications.d/archon")).content ?? "";
const tcpPorts = (plan: HostPlan): string[] =>
  (/^ports=([^|\n]*)/m.exec(ufwProfile(plan))?.[1] ?? "").replace("/tcp", "").split(",");

proves(
  ["064-router-filters FR-003"],
  "064: no allow list in Traefik or smb.conf; Cockpit's 9090 and the intake's 4318 open to every network",
  () => {
    const plan = resolvePlan(host({ optIn: otelOn }), webFleet());
    // Traefik: no middleware anywhere (an IP allow list is one), on no entry point and no route.
    const dyn = parse(traefikDynamic(plan));
    assertEquals(at(dyn, "http", "middlewares"), undefined);
    for (const r of Object.values((at(dyn, "http", "routers") ?? {}) as Record<string, unknown>)) {
      assertEquals(at(r, "middlewares"), undefined, JSON.stringify(r));
    }
    const st = parse(traefikStatic(plan));
    for (const ep of ["web", "websecure"]) {
      assertEquals(at(st, "entryPoints", ep, "http", "middlewares"), undefined, ep);
    }
    assert(
      !/ipallowlist|ipwhitelist|sourcerange/i.test(traefikDynamic(plan) + traefikStatic(plan)),
    );
    // smb.conf: no hosts allow or deny.
    assert(!/hosts (allow|deny)/.test(smbConf(webFleet(), host(), usersFor(webFleet(), host()))));
    // The firewall: one profile, with 9090 and 4318, and no rule from a network.
    for (const port of [9090, 4318]) {
      const p = the(plan.ports.find((x) => x.port === port));
      assertEquals(Object.keys(p).includes("from"), false, `${port} has no from`);
      assert(tcpPorts(plan).includes(String(port)), `${port} in the Archon profile`);
    }
    const profile = ufwProfile(plan);
    assertEquals(profile.split("\n").filter((l) => l.startsWith("[")).length, 1, profile);
  },
);

proves(
  ["064-router-filters FR-004"],
  "064: pg publish has no --local-only; a recorded localOnly from before is ignored",
  async () => {
    const { PRIME } = await import("../src/archon/pg/config.ts");
    const pgHost = (published: Record<string, unknown>) =>
      host({
        ip: "10.0.30.57",
        pg: { instances: [{ ...PRIME, databases: [] }] },
        optIn: { pg: { enabled: true, by: "alice", at: "2026-11-12T18:00:00Z" } },
        pgState: {
          instances: {
            prime: {
              version: 18,
              port: 5432,
              created: "2026-11-12T18:00:00Z",
              by: "alice",
              // A record an earlier engine wrote: localOnly is no longer read.
              published: published as { at: string; by: string },
            },
          },
        },
      });
    const before = resolvePlan(pgHost({ at: "x", by: "alice", localOnly: true }), webFleet());
    const now = resolvePlan(pgHost({ at: "x", by: "alice" }), webFleet());
    assertEquals(ufwProfile(before), ufwProfile(now));
    assert(tcpPorts(before).includes("5432"), ufwProfile(before));
    assertEquals(
      Object.keys(the(before.ports.find((p) => p.port === 5432))).includes("from"),
      false,
    );
    // pg_hba admits every address over TLS with scram-sha-256, and refuses postgres first.
    const { ANYWHERE, hbaConf } = await import("../src/archon/pg/config.ts");
    const hba = hbaConf(true, ANYWHERE);
    assertStringIncludes(hba, "hostssl  all       all       0.0.0.0/0        scram-sha-256");
    assert(hba.indexOf("postgres  0.0.0.0/0        reject") < hba.indexOf("all       0.0.0.0/0"));
    assertStringIncludes(
      await fs.readTextFile("src/archon/pg/converge.ts"),
      "hbaConf(inst.published, ANYWHERE)",
    );
    // No command and no message offers --local-only any more.
    const pub = the(COMMANDS.find((c) => c.name === "pg publish"));
    assert(!pub.args.some((a) => a.name === "local-only"));
    const offered: string[] = [];
    for (const c of COMMANDS) {
      if (/--local-only/.test(`${c.description} ${c.summary}`)) offered.push(c.name);
    }
    for (const f of ["src/archon/pg/connections.ts", "src/archon/pg/commands.ts"]) {
      if ((await fs.readTextFile(f)).includes("--local-only")) offered.push(f);
    }
    assertEquals(offered, []);
  },
);

proves(
  ["064-router-filters FR-005"],
  "064: SSH passwords only from the fleet's local networks; Cockpit closed when the fleet allows no passwords",
  () => {
    const lan = fleet({ ssh: { passwordFrom: ["192.168.10.0/24"] } });
    const sshd = sshdConfig(["192.168.10.0/24"]);
    assertStringIncludes(sshd, "PasswordAuthentication no\n");
    assertStringIncludes(sshd, "Match Address 192.168.10.0/24\n    PasswordAuthentication yes");
    const conf = (f: ReturnType<typeof fleet>) =>
      the(
        resolvePlan(host(), f).files.find(
          (x) => x.path === "/etc/ssh/sshd_config.d/50-archon.conf",
        ),
      ).content ?? "";
    assertStringIncludes(conf(lan), "Match Address 192.168.10.0/24");
    // Keys only: no Match block, and Cockpit installed but closed (9090 not in the profile).
    const keysOnly = fleet({ ssh: { passwordFrom: [] } });
    assert(!conf(keysOnly).includes("Match Address"), conf(keysOnly));
    const closed = resolvePlan(host(), keysOnly);
    assert(!closed.ports.some((p) => p.port === 9090));
    assert(!tcpPorts(closed).includes("9090"), ufwProfile(closed));
    assert(resolvePlan(host(), lan).ports.some((p) => p.port === 9090));
  },
);

proves(
  ["064-router-filters FR-006"],
  "064: the firewall's note, the login banner, the welcome guide, and the commands say the router decides",
  async () => {
    const plan = resolvePlan(host(), webFleet());
    const notes = Object.values(plan.notes).flat();
    assert(
      notes.some((n) => n.includes("which networks reach the server is the router's decision")),
      notes.join("\n"),
    );
    // The login banner, as a login shell prints it.
    const motd = await proc.output(["sh", "-c", archonMotd(webFleet(), host(), true)]);
    assertStringIncludes(
      new TextDecoder().decode(motd.stdout),
      "who reaches this server is the router's decision",
    );
    const { guideFor } = await import("../src/archon/guide/guide.ts");
    const guide = JSON.stringify(guideFor(plan));
    assertStringIncludes(guide, "Who can reach them is the router's decision.");
    assertStringIncludes(guide, "which networks reach the server is the router's decision");
    assert(!/local networks only/.test(guide), "no restriction the machine no longer makes");
    const web = the(COMMANDS.find((c) => c.name === "web status"));
    assertStringIncludes(web.description, "the router's decision");
    assert(!/answers the local networks only/.test(web.description));
    // The guides (docs) say so too: the web and firewall guides.
    const { engineFile } = await import("../src/archon/core/assets.ts");
    assertStringIncludes(engineFile("docs/web.md"), "router");
  },
);
