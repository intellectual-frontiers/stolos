/**
 * Spec 065: the Archon Console with fakes (no PAM, no systemd), for the browser test
 * (tests/console/browser.cjs, CI's console-browser job). Usage: bun tests/console/serve.ts <port>
 *
 * @module
 */

import { fs, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/net";
import { consoleHandler } from "../../src/archon/console/server.ts";
import { Sessions, Throttle } from "../../src/archon/console/auth.ts";
import type { ActivityEntry } from "../../src/archon/console/pages.ts";

const PEOPLE: Record<string, { pw: string; groups: string[]; name: string }> = {
  alice: { pw: "right-password", groups: ["alice", "sudo"], name: "Alice Example" },
  bob: { pw: "bob-password", groups: ["bob"], name: "Bob Example" },
};
const log: ActivityEntry[] = [];
const h = consoleHandler({
  host: "alpha",
  auth: { check: (u, p) => Promise.resolve(PEOPLE[u]?.pw === p) },
  accounts: (u) =>
    Promise.resolve(
      PEOPLE[u] ? { user: u, name: PEOPLE[u].name, groups: PEOPLE[u].groups } : undefined,
    ),
  runner: {
    async run(_u, argv, line) {
      for (let i = 0; i < 30; i++) {
        line(
          i === 7
            ? "[!!] Web              certificate renews in 9 days"
            : `[ok] Check ${i}          passed`,
        );
        await new Promise((r) => setTimeout(r, 20));
      }
      line(`[ok] ${argv.join(" ")} done`);
      return 0;
    },
  },
  sessions: new Sessions(),
  throttle: new Throttle(),
  data: () =>
    Promise.resolve({
      host: "alpha",
      fqdn: "alpha.lab.example.net",
      title: "lab",
      os: "Ubuntu 26.04.1 LTS",
      address: "10.0.30.59",
      repo: { slug: "example/fleet", url: "https://github.com/example/fleet" },
      verify: { at: new Date().toISOString(), passed: 141, total: 142, failed: ["apt:ipv4-only"] },
      data: {
        class: "ephemeral" as const,
        reasons: ["nothing here holds end users' data that exists nowhere else"],
      },
      services: [
        {
          name: "cockpit",
          url: "https://cockpit.alpha.lab.example.net",
          description: "Cockpit",
          source: "model" as const,
        },
      ],
      unrouted: [],
      guide: [],
      guides: [{ name: "guide", title: "Your Archon server: a guide for newcomers" }],
      admin: "alice",
      mailbox: "ops@example.net",
      generated: "now",
    }),
  repo: () =>
    Promise.resolve({
      commit: {
        sha: "a7c1e94",
        subject: "lab: approve",
        author: "alice",
        at: new Date().toISOString(),
      },
      signer: "alice-daily",
      engine: "stolos-v0.0.0",
      signers: [
        { name: "alice-daily", role: "daily" },
        {
          name: "alice-recovery",
          role: "recovery",
        },
      ],
    }),
  activity: {
    add: (e) => (log.push(e), Promise.resolve()),
    recent: (n) => Promise.resolve(log.slice(-n).reverse()),
  },
  guideDoc: () => Promise.resolve(undefined),
  cacheDir: await fs.makeTempDir(),
  services: () =>
    Promise.resolve({
      optIns: [
        {
          name: "pg",
          title: "PostgreSQL",
          on: false,
          commands: { on: "archon pg on", off: "archon pg off", status: "archon pg status" },
        },
      ],
      units: [
        {
          unit: "traefik.service",
          spec: "032-web",
          active: "active",
          sub: "running",
          enabled: "enabled",
        },
      ],
    }),
  journal: async (unit, each, signal) => {
    for (let i = 0; i < 25 && !signal.aborted; i++) {
      each(
        `2026-11-15T01:${String(i).padStart(2, "0")}:00 alpha ${unit ?? "kernel"}[1]: line ${i}`,
      );
      await new Promise((r) => setTimeout(r, 10));
    }
  },
});
// Plain HTTP on loopback for the test: the Secure flag is dropped so the browser keeps the cookie.
await serve({ port: Number(proc.args[0] ?? 8099), hostname: "127.0.0.1" }, (req, info) =>
  h(req, info).then((r) => {
    const c = r.headers.get("set-cookie");
    if (!c) return r;
    const hh = new Headers(r.headers);
    hh.set("set-cookie", c.replace("; Secure", ""));
    return new Response(r.body, { status: r.status, headers: hh });
  }),
);
console.log("listening");
