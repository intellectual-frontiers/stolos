/**
 * Spec 017: guests in the host model, LXD from a rendered preseed, and guest sync (create and
 * start, never delete).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { guestSync, launchArgs } from "../src/archon/guests/guests.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import type { GuestDef } from "../src/archon/model/types.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import { fleet, host } from "./fixtures.ts";

const posix = proc.build.os !== "windows";
const DB: GuestDef = {
  name: "db",
  kind: "vm",
  image: "ubuntu:26.04",
  data: "durable",
  cpus: 2,
  memory: "4GiB",
};
const WEB: GuestDef = { name: "web", kind: "container", image: "ubuntu:26.04", data: "ephemeral" };

proves(
  ["017-guests FR-001"],
  "017: a host lists its guests: name, container or vm, image, optional CPU and memory limits",
  () => {
    assertEquals(validateFleet(fleet(), [host({ guests: [DB, WEB] })]), []);
    assertEquals(launchArgs(DB), [
      "lxc",
      "launch",
      "ubuntu:26.04",
      "db",
      "--vm",
      "-c",
      "limits.cpu=2",
      "-c",
      "limits.memory=4GiB",
    ]);
    assertEquals(launchArgs(WEB), ["lxc", "launch", "ubuntu:26.04", "web"]);
    const bad = validateFleet(fleet(), [
      host({
        guests: [
          { ...WEB, name: "Bad_Name" },
          { ...WEB, name: "x", image: "noremote" },
          { ...DB, memory: "lots" },
        ],
      }),
    ]).map((p) => p.message);
    assert(
      bad.some((m) => m.includes("'Bad_Name' is not a valid, unique name")),
      bad.join("\n"),
    );
    assert(
      bad.some((m) => m.includes("image 'noremote' is not remote:alias")),
      bad.join("\n"),
    );
    assert(
      bad.some((m) => m.includes("memory 'lots'")),
      bad.join("\n"),
    );
  },
);

proves(
  ["017-guests FR-002"],
  "017: with guests, apply installs the lxd snap, initializes LXD once from a preseed, and syncs the guests",
  () => {
    assert(
      !resolvePlan(host(), fleet()).packages.some((p) => p.name === "lxd"),
      "no guests, no LXD",
    );
    const plan = resolvePlan(host({ guests: [DB] }), fleet());
    assert(plan.packages.some((p) => p.name === "lxd" && p.source === "snap"));
    const preseed = plan.files.find((f) => f.path === "/etc/archon/lxd-preseed.yaml");
    assertExists(preseed);
    const text = preseed.content ?? "";
    assertStringIncludes(text, "- name: lxdbr0\n  type: bridge");
    assertStringIncludes(text, "storage_pools:\n- name: default\n  driver: dir");
    // Once: only where LXD has no storage pool yet.
    const init = (preseed.onChange ?? []).flatMap((a) =>
      a.kind === "run" ? [a.argv.join(" ")] : [],
    );
    assertEquals(init, [
      "sh -c lxc storage list -f csv 2>/dev/null | grep -q . || lxd init --preseed < /etc/archon/lxd-preseed.yaml",
    ]);
    // A change to any guest runs archon guest sync.
    const manifest = plan.files.find((f) => f.path === "/etc/archon/guests");
    assertExists(manifest);
    assertStringIncludes(manifest.content ?? "", JSON.stringify(DB));
    assertEquals(
      (manifest.onChange ?? []).flatMap((a) => (a.kind === "run" ? [a.argv] : [])),
      [["/usr/local/bin/archon", "guest", "sync"]],
    );
  },
);

proves(
  ["017-guests FR-003"],
  "017: guest sync creates missing instances and starts stopped ones; it never deletes",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-guests-test-" });
    const saved = proc.env.get("PATH") ?? "";
    try {
      // An LXD with web stopped and old (not in the model) running; db is missing.
      await fs.writeTextFile(
        path.join(dir, "lxc"),
        `#!/bin/sh
echo "$*" >> "${dir}/lxc.log"
case "$1" in
  list) echo '[{"name":"web","status":"Stopped","type":"container"},{"name":"old","status":"Running","type":"container"}]';;
esac
`,
      );
      await fs.chmod(path.join(dir, "lxc"), 0o755);
      proc.env.set("PATH", `${dir}:${saved}`);
      assert(await guestSync(host({ guests: [DB, WEB] })));
      const calls = (await fs.readTextFile(path.join(dir, "lxc.log"))).trim().split("\n");
      assertEquals(calls, [
        "list --format json",
        "launch ubuntu:26.04 db --vm -c limits.cpu=2 -c limits.memory=4GiB",
        "start web",
      ]);
      assert(!calls.some((c) => /^(delete|stop|rm)\b/.test(c)), "old is kept (Article 11)");
    } finally {
      proc.env.set("PATH", saved);
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: posix ? false : "a stand-in lxc written as a POSIX shell script" },
);
