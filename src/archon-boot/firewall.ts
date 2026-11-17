/**
 * Firewall check for `boot serve` (spec 004): warn, with the exact command,
 * when this machine's firewall would block servers from reaching TFTP (UDP)
 * or HTTP (TCP). Read-only: it never changes a firewall rule. Windows Defender
 * Firewall, ufw, and firewalld; anything else is not checked.
 *
 * @module
 */
// Spec: 004-install
// Spec: 106-one-passphrase-speed FR-008

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../archon/core/exec.ts";
import { probed } from "../archon/core/probe-cache.ts";

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

/**
 * Windows Defender Firewall's rules, read once per run (spec 106-one-passphrase-speed FR-008): the
 * boot server's check and the console's share one PowerShell run. Never written to a file (rule
 * names are the person's); undefined where they could not be read.
 */
let winState: Promise<WinState | undefined> | undefined;

/** Forget the rules read in this run (a test's). */
export function forgetWindowsState(): void {
  winState = undefined;
}

function windowsState(signal?: AbortSignal): Promise<WinState | undefined> {
  winState ??= (async () => {
    const r = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", PROBE], {
      ...(signal ? { signal } : {}),
    });
    if (!r.ok || !r.stdout.trim()) return undefined;
    return normalizeWinState(JSON.parse(r.stdout) as WinState);
  })();
  return winState;
}

/** The warnings for these needs, or undefined where the rules could not be read. */
async function windows(needs: Need[], signal?: AbortSignal): Promise<string[] | undefined> {
  const s = await windowsState(signal);
  if (!s) return undefined;
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

async function linux(needs: Need[], signal?: AbortSignal): Promise<string[]> {
  const lim = signal ? { signal } : {};
  const lines: string[] = [];
  const ufwActive = (await run(["systemctl", "is-active", "--quiet", "ufw"], lim)).ok;
  if (ufwActive) {
    const st = await run(["ufw", "status"], lim);
    const missing = st.ok ? evaluateUfw(st.stdout, needs) : needs;
    for (const n of missing) {
      lines.push(
        `ufw${
          st.ok ? "" : " is active (run boot serve with sudo to check its rules)"
        }: ${n.what} (${n.protocol} ${n.port}) may be blocked; allow it: sudo ufw allow ${n.port}/${n.protocol.toLowerCase()}`,
      );
    }
  }
  if ((await run(["firewall-cmd", "--state"], lim)).ok) {
    const ports = await run(["firewall-cmd", "--list-ports"], lim);
    const services = await run(["firewall-cmd", "--list-services"], lim);
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

/** How long the firewall may be read before the check gives up (spec 106-one-passphrase-speed FR-008). */
export const FIREWALL_LIMIT_MS = 20_000;

/** How the firewall is read: the warnings, or undefined where it could not be (tests replace it). */
export type FirewallProbe = (needs: Need[], signal: AbortSignal) => Promise<string[] | undefined>;

/** What a firewall check is given (tests replace the reading and the limit). */
export interface FirewallOptions {
  /** `pair` opens a window that is only useful if the answer is true now: do not use a kept answer. */
  fresh?: boolean;
  /** The hard limit on reading the firewall (default: {@link FIREWALL_LIMIT_MS}). */
  limitMs?: number;
  /** Reads the firewall (default: this system's). */
  probe?: FirewallProbe;
}

/** What is said where the firewall could not be read in time: a warning, with what to do by hand. */
export function unreadable(limitMs: number): string {
  const seconds = Math.max(1, Math.round(limitMs / 1000));
  return proc.build.os === "windows"
    ? `The firewall could not be checked in ${seconds} seconds, so it is not known whether it blocks the boot server. Look at the rules yourself (PowerShell): Get-NetFirewallRule -Direction Inbound -Enabled True -Action Block | Format-Table DisplayName, Profile; or ask again with: stolos boot doctor --fresh`
    : `The firewall could not be checked in ${seconds} seconds, so it is not known whether it blocks the boot server. Look at it yourself (sudo ufw status, or sudo firewall-cmd --list-all); or ask again with: stolos boot doctor --fresh`;
}

/**
 * Warnings for this machine's firewall; empty when it is fine. Reading it has a hard time limit
 * ({@link FIREWALL_LIMIT_MS}, spec 106-one-passphrase-speed FR-008): where it could not be read in
 * time (or at all) the answer is one warning saying so, with what to do by hand, and nothing waits
 * longer. The answer is kept for five minutes in the program's state folder, unless the run is a
 * report, `--verbose` or `--fresh` (or the caller asks for `fresh`), and is not kept where the check
 * could not be completed.
 */
export async function firewallWarnings(needs: Need[], o: FirewallOptions = {}): Promise<string[]> {
  const key = JSON.stringify([
    "firewall",
    proc.build.os,
    needs.map((n) => `${n.protocol} ${n.port} ${n.what}`).sort(),
  ]);
  const limit = o.limitMs ?? FIREWALL_LIMIT_MS;
  const read: FirewallProbe =
    o.probe ??
    ((n, signal) => (proc.build.os === "windows" ? windows(n, signal) : linux(n, signal)));
  const answer = await probed<{ done: boolean; lines: string[] }>(
    key,
    async () => {
      const stop = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The limit is a race, not only a signal: a program stopped on Windows can leave a child that
      // keeps its pipes open, and the run's own end would then never come.
      const cut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          stop.abort();
          resolve(undefined);
        }, limit);
      });
      try {
        const lines = await Promise.race([read(needs, stop.signal), cut]);
        return lines ? { done: true, lines } : { done: false, lines: [unreadable(limit)] };
      } catch {
        return { done: false, lines: [unreadable(limit)] };
      } finally {
        clearTimeout(timer);
      }
    },
    { keep: (v) => (v as { done: boolean }).done, ...(o.fresh ? { bypass: true } : {}) },
  );
  return answer.lines;
}
