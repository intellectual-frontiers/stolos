/**
 * Firewall check for `boot serve` (spec 004): warn, with the exact command,
 * when this machine's firewall would block servers from reaching TFTP (UDP)
 * or HTTP (TCP). Read-only: it never changes a firewall rule. Windows Defender
 * Firewall, ufw, and firewalld; anything else is not checked.
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../archon/core/exec.ts";

/** A port the boot server needs reachable from the network. */
export interface Need {
  /** TCP (HTTP) or UDP (TFTP). */
  protocol: "TCP" | "UDP";
  /** The port number. */
  port: number;
  /** What it is for, in words ("HTTP", "TFTP"). */
  what: string;
}

/** One Windows inbound rule, as the PowerShell probe reports it. */
export interface WinRule {
  /** The rule's display name. */
  name: string;
  /** Allow or Block. */
  action: "Allow" | "Block";
  /** "Any", or a comma list of Domain, Private, Public. */
  profile: string;
  /** "Any", TCP, UDP. */
  protocol: string;
  /** Local ports: "Any", or a list such as ["8080"] or ["1000-2000"]. */
  ports: string[];
  /** Program path for an application rule, else "Any". */
  program: string;
  /** Remote addresses: "Any", "LocalSubnet", or addresses and ranges. */
  remote?: string[];
  /** Limited to a Windows user, service, app package, or interface: not the boot server's. */
  scoped?: boolean;
}

/** Windows Defender Firewall's state, as the PowerShell probe reports it. */
export interface WinState {
  /** Firewall profiles that are on, e.g. ["Domain", "Private", "Public"]. */
  enabled: string[];
  /** Categories of the connected networks, e.g. ["Public"]. */
  active: string[];
  /** The enabled inbound rules. */
  rules: WinRule[];
}

const covers = (profile: string, cat: string) =>
  profile === "Any" || profile.split(/,\s*/).some((p) => cat.startsWith(p));

const portIn = (ports: string[], port: number): boolean =>
  ports.some((p) => {
    if (p === "Any") return true;
    const [a = Number.NaN, b] = p.split("-").map(Number);
    return b ? port >= a && port <= b : port === a;
  });

/** The boot server's own program: Bun (or Node, its backup runtime), run by you. */
const isRuntime = (program: string): boolean => /(^|[\\/])(bun|node)(\.exe)?$/i.test(program);

/** Which needs Windows would block, and why. Block rules win over allow rules. */
export function evaluateWindows(
  s: WinState,
  needs: Need[],
): Array<Need & { reason: string; rule?: WinRule }> {
  const out: Array<Need & { reason: string; rule?: WinRule }> = [];
  const cats = s.active.filter((c) => s.enabled.some((e) => c.startsWith(e)));
  for (const n of needs) {
    for (const cat of cats) {
      const applies = (r: WinRule) =>
        covers(r.profile, cat) &&
        (r.protocol === "Any" || r.protocol.toUpperCase() === n.protocol) &&
        portIn(r.ports, n.port) &&
        !r.scoped &&
        (r.program === "Any" || isRuntime(r.program));
      const block = s.rules.find((r) => r.action === "Block" && applies(r));
      if (block) {
        out.push({
          ...n,
          reason: `the rule "${block.name}" blocks it on ${cat} networks`,
          rule: block,
        });
        break;
      }
      const allows = s.rules.filter((r) => r.action === "Allow" && applies(r));
      if (!allows.length) {
        out.push({
          ...n,
          reason: `no rule allows it on ${cat} networks (this PC's network is ${cat})`,
        });
        break;
      }
      // Servers are often on another network (VLAN) than the boot machine.
      if (!allows.some((r) => !r.remote?.length || r.remote.includes("Any"))) {
        out.push({
          ...n,
          reason: `it is allowed only from ${allows
            .flatMap((r) => r.remote ?? [])
            .join(", ")}, so servers on other networks cannot reach it`,
        });
        break;
      }
    }
  }
  return out;
}

// Reads every inbound rule with its port, program, and address filters in three bulk calls
// (a call per rule takes minutes on a typical PC).
const PROBE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$enabled = @(Get-NetFirewallProfile | Where-Object { $_.Enabled } | ForEach-Object { "$($_.Name)" })
$active = @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" })
$ports = @{}; Get-NetFirewallPortFilter -All | ForEach-Object { $ports[$_.InstanceID] = $_ }
$apps = @{}; Get-NetFirewallApplicationFilter -All | ForEach-Object { $apps[$_.InstanceID] = $_ }
$addrs = @{}; Get-NetFirewallAddressFilter -All | ForEach-Object { $addrs[$_.InstanceID] = $_ }
$secs = @{}; Get-NetFirewallSecurityFilter -All | ForEach-Object { $secs[$_.InstanceID] = $_ }
$svcs = @{}; Get-NetFirewallServiceFilter -All | ForEach-Object { $svcs[$_.InstanceID] = $_ }
$ifs = @{}; Get-NetFirewallInterfaceFilter -All | ForEach-Object { $ifs[$_.InstanceID] = $_ }
$ifts = @{}; Get-NetFirewallInterfaceTypeFilter -All | ForEach-Object { $ifts[$_.InstanceID] = $_ }
$rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True | ForEach-Object {
  $pf = $ports[$_.InstanceID]; $af = $apps[$_.InstanceID]; $ad = $addrs[$_.InstanceID]
  $sec = $secs[$_.InstanceID]; $svc = $svcs[$_.InstanceID]; $if = $ifs[$_.InstanceID]; $ift = $ifts[$_.InstanceID]
  $prog = "$($af.Program)"
  # Rules limited to a Windows user, a service, an app package, or particular
  # interfaces do not apply to the boot server (Bun, run by you).
  $scoped = ($sec.LocalUser -and "$($sec.LocalUser)" -ne 'Any') -or ($svc.Service -and "$($svc.Service)" -ne 'Any') -or
    ($af.Package -and "$($af.Package)" -ne 'Any' -and "$($af.Package)" -ne '') -or
    ($if.InterfaceAlias -and "$($if.InterfaceAlias)" -ne 'Any') -or ($ift.InterfaceType -and "$($ift.InterfaceType)" -ne 'Any')
  if (($pf.Protocol -in 'TCP','UDP','Any') -and ($prog -eq 'Any' -or $prog -like '*bun.exe' -or $prog -like '*node.exe')) {
    [pscustomobject]@{ name = $_.DisplayName; action = "$($_.Action)"; profile = "$($_.Profile)";
      protocol = "$($pf.Protocol)"; ports = @($pf.LocalPort | ForEach-Object { "$_" }); program = $prog;
      remote = @($ad.RemoteAddress | ForEach-Object { "$_" }); scoped = [bool]$scoped }
  }
})
@{ enabled = $enabled; active = $active; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`;

/** PowerShell's JSON as Archon reads it: single values made lists, empty remote entries dropped. */
export function normalizeWinState(raw: WinState): WinState {
  return {
    enabled: [raw.enabled ?? []].flat(),
    active: [raw.active ?? []].flat(),
    rules: [raw.rules ?? []].flat().map((x) => ({
      ...x,
      ports: [x.ports ?? []].flat(),
      // PowerShell returns empty entries for "any address": drop them, so a rule
      // open to every network is not mistaken for one limited to a few addresses.
      remote: [x.remote ?? []]
        .flat()
        .map((a: string) => String(a).trim())
        .filter((a: string) => a && a !== "*"),
      program: x.program || "Any",
    })),
  };
}

async function windows(needs: Need[]): Promise<string[]> {
  const r = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", PROBE]);
  if (!r.ok || !r.stdout.trim()) return [];
  const s = normalizeWinState(JSON.parse(r.stdout) as WinState);
  const blocked = evaluateWindows(s, needs);
  const lines: string[] = [];
  for (const b of blocked) {
    lines.push(`Windows Firewall: ${b.what} (${b.protocol} ${b.port}): ${b.reason}.`);
  }
  for (const b of blocked.filter((b) => b.reason.includes("only from"))) {
    lines.push(
      `Allow it from every network (PowerShell as Administrator): New-NetFirewallRule -DisplayName "Archon boot (${b.what})" -Direction Inbound -Protocol ${b.protocol} -LocalPort ${b.port} -Profile Any -RemoteAddress Any -Action Allow`,
    );
  }
  if (blocked.some((b) => b.rule && isRuntime(b.rule.program))) {
    lines.push(
      'Remove the rule that blocks Bun (PowerShell as Administrator): Get-NetFirewallRule -Direction Inbound -Action Block | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -like "*bun*" } | Remove-NetFirewallRule',
    );
  }
  for (const name of new Set(
    blocked.flatMap((b) => (b.rule && !isRuntime(b.rule.program) ? [b.rule.name] : [])),
  )) {
    lines.push(
      `"${name}" blocks every program; another tool created it. If servers cannot reach this PC, see what it is before disabling it: Get-NetFirewallRule -DisplayName "${name}" | Format-List`,
    );
  }
  for (const b of blocked.filter((b) => b.reason.startsWith("no rule"))) {
    lines.push(
      `Allow it (PowerShell as Administrator): New-NetFirewallRule -DisplayName "Archon boot (${b.what})" -Direction Inbound -Protocol ${b.protocol} -LocalPort ${b.port} -Profile Any -Action Allow`,
    );
  }
  return lines;
}

/** ufw status output: which needs it does not allow. */
export function evaluateUfw(status: string, needs: Need[]): Need[] {
  if (!/^Status: active/m.test(status)) return [];
  return needs.filter(
    (n) =>
      !status.split("\n").some((l) => {
        const m = l.match(/^(\d+)(?::(\d+))?(?:\/(tcp|udp))?\s+ALLOW IN/i);
        if (!m) return false;
        const lo = Number(m[1]),
          hi = Number(m[2] ?? m[1]);
        return n.port >= lo && n.port <= hi && (!m[3] || m[3].toUpperCase() === n.protocol);
      }),
  );
}

async function linux(needs: Need[]): Promise<string[]> {
  const lines: string[] = [];
  const ufwActive = (await run(["systemctl", "is-active", "--quiet", "ufw"])).ok;
  if (ufwActive) {
    const st = await run(["ufw", "status"]);
    const missing = st.ok ? evaluateUfw(st.stdout, needs) : needs;
    for (const n of missing) {
      lines.push(
        `ufw${
          st.ok ? "" : " is active (run boot serve with sudo to check its rules)"
        }: ${n.what} (${n.protocol} ${n.port}) may be blocked; allow it: sudo ufw allow ${n.port}/${n.protocol.toLowerCase()}`,
      );
    }
  }
  if ((await run(["firewall-cmd", "--state"])).ok) {
    const ports = await run(["firewall-cmd", "--list-ports"]);
    const services = await run(["firewall-cmd", "--list-services"]);
    for (const n of needs) {
      const open =
        ports.stdout.split(/\s+/).includes(`${n.port}/${n.protocol.toLowerCase()}`) ||
        (n.port === 69 && services.stdout.split(/\s+/).includes("tftp"));
      if (!open) {
        lines.push(
          `firewalld: ${n.what} (${n.protocol} ${n.port}) is not open; allow it: sudo firewall-cmd --permanent --add-port=${n.port}/${n.protocol.toLowerCase()} && sudo firewall-cmd --reload`,
        );
      }
    }
  }
  return lines;
}

/** Warnings for this machine's firewall; empty when it is fine or cannot be read. */
export async function firewallWarnings(needs: Need[]): Promise<string[]> {
  try {
    return proc.build.os === "windows" ? await windows(needs) : await linux(needs);
  } catch {
    return [];
  }
}
