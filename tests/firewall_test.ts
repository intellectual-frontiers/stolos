import { assert, assertEquals } from "./assert.ts";
import {
  evaluateUfw,
  evaluateWindows,
  normalizeWinState,
  type WinRule,
} from "../src/archon-boot/firewall.ts";

const needs = [
  { protocol: "TCP" as const, port: 8080, what: "HTTP" },
  { protocol: "UDP" as const, port: 69, what: "TFTP" },
];
const rule = (r: Partial<WinRule>): WinRule => ({
  name: "r",
  action: "Allow",
  profile: "Any",
  protocol: "TCP",
  ports: ["8080"],
  program: "Any",
  remote: ["Any"],
  ...r,
});

Deno.test("Windows firewall: allow rules, block rules, profiles, and remote scope", () => {
  const s = {
    enabled: ["Domain", "Private", "Public"],
    active: ["Public"],
    rules: [] as WinRule[],
  };
  assertEquals(evaluateWindows(s, needs).length, 2);
  s.rules = [rule({}), rule({ protocol: "UDP", ports: ["69"] })];
  assertEquals(evaluateWindows(s, needs), []);
  // A Private-only rule does not cover a Public network.
  s.rules = [rule({ profile: "Private" }), rule({ protocol: "UDP", ports: ["69"] })];
  assertEquals(evaluateWindows(s, needs).map((b) => b.what), ["HTTP"]);
  // The rule Windows adds when you decline Deno on public networks wins over allows.
  s.rules = [
    rule({}),
    rule({ protocol: "UDP", ports: ["69"] }),
    rule({
      name: "deno",
      action: "Block",
      profile: "Public",
      protocol: "TCP",
      ports: ["Any"],
      program: "C:\\deno\\deno.exe",
    }),
  ];
  const b = evaluateWindows(s, needs);
  assertEquals(b.map((x) => x.what), ["HTTP"]);
  assert(b[0].reason.includes('"deno" blocks'));
  // A block rule limited to another Windows user (a sandbox's) does not apply to the boot server.
  s.rules = [
    rule({}),
    rule({ protocol: "UDP", ports: ["69"] }),
    rule({
      name: "codex_sandbox_offline_block_inbound",
      action: "Block",
      protocol: "Any",
      ports: ["Any"],
      scoped: true,
    }),
  ];
  assertEquals(evaluateWindows(s, needs), []);
  // Local subnet only: servers on another VLAN are blocked.
  s.rules = [rule({ remote: ["LocalSubnet"] }), rule({ protocol: "UDP", ports: ["69"] })];
  assert(evaluateWindows(s, needs)[0].reason.includes("only from LocalSubnet"));
  // Firewall off for the active profile: nothing to warn about.
  assertEquals(evaluateWindows({ enabled: ["Domain"], active: ["Public"], rules: [] }, needs), []);
});

Deno.test("ufw: active status without the ports warns; allowed ports pass", () => {
  assertEquals(evaluateUfw("Status: inactive\n", needs), []);
  assertEquals(
    evaluateUfw("Status: active\n\nTo Action From\n22/tcp ALLOW IN Anywhere\n", needs).length,
    2,
  );
  const ok =
    "Status: active\n8080/tcp                   ALLOW IN    Anywhere\n69/udp ALLOW IN Anywhere\n";
  assertEquals(evaluateUfw(ok, needs), []);
});

Deno.test("Windows firewall: PowerShell's empty remote entries mean any address (no false warning)", () => {
  // What BOOTPC's PowerShell returned: rules open to every address, with blank entries.
  const raw = {
    enabled: "Public",
    active: "Public",
    rules: [
      rule({ name: "Archon boot (HTTP)", protocol: "TCP", ports: ["8080"], remote: ["", "", ""] }),
      rule({
        name: "Archon boot (TFTP)",
        protocol: "UDP",
        ports: ["69"],
        remote: [""] as string[],
      }),
    ],
  } as unknown as Parameters<typeof normalizeWinState>[0];
  const s = normalizeWinState(raw);
  assertEquals(s.rules.map((r) => r.remote), [[], []]);
  assertEquals(evaluateWindows(s, needs), []);
  // A real address list still warns, and names the addresses.
  const limited = normalizeWinState(
    { ...raw, rules: [rule({ remote: ["10.0.1.0/24"] })] } as typeof raw,
  );
  const w = evaluateWindows(limited, [needs[0]]);
  assert(w[0]?.reason.includes("10.0.1.0/24"), JSON.stringify(w));
});
