# 117: Every machine the fleet knows is in `fleet status`, and "no evidence" is not a failure

A small change to `stolos fleet status` (spec 021, extended by 107-pairing-and-query FR-009, 108-tags FR-015, 110-network-assets FR-009, 112-machine-reported-tags FR-010 and
115-compatibility FR-008) and to how a control with no evidence is printed (spec 068-compliance FR-002, spec 074-change-impact, spec 073 on freshness, spec 105-calm-output
FR-004 and FR-006). It builds on 067-adopt (adopted machines and their policies), 107-pairing-and-query (the way of joining) and 110-network-assets (network assets).

## Why

Two defects of one real run (a PC, after two machines were paired: a Windows PC and an Omarchy Linux PC):

1. `stolos fleet status` listed the controller (this PC) and the managed server, and nothing else. The two paired machines, and any adopted device or network asset, were
   in the fleet and in the Stolos Console, but not in the command that says what the fleet is. A person who pairs a machine and runs `fleet status` sees nothing happen.
2. `stolos apply` printed `⚠️  BCD-24 Data Backups (observed): no evidence -> fail [E105-WARNING]` and `⚠️  CRY-07 Encrypting Data At Rest (observed): no evidence -> fail`.
   A control that nothing was observed for is not failing and is nothing to be warned about: the machine has not been observed (or what the control looks at cannot be
   observed yet). It is the "not set up yet" class of spec 099 and spec 105 (⏳): expected, waiting for one command, never a failure and never a warning.

## Ontology

No term of `stolos:` is new. The spec uses the ones that exist: `stolos:WayOfJoining` (`auto-adopted`, `paired`, `integrated`, `integration`, `managed`, `cloud`, spec 107),
`stolos:MachineKind`, `stolos:DeviceClass` (spec 110) and the code lists of spec 105 (`stolos:OutputClass`, `stolos:Verbosity`); the code imports their unions from
`src/archon/ontology.auto.ts`. The words "not observed yet" are display, not a term the code branches on.

## Requirements

Requirement words follow RFC 2119 as RFC 8174 clarifies it: they are requirements only where written in capitals.

**Standards considered.** RFC 2119 and RFC 8174 (requirement words); NIST SP 800-53 Rev 5 CM-8 (system component inventory: the inventory lists every component, with its
identity, kind and where it is known to be: an inventory that leaves out an adopted machine is not accurate); the Secure Controls Framework controls AST-04 (Asset
Inventories) and MON-02 (Continuous Monitoring), which `compliance/scf.ts` already cites; NIST SP 800-53 Rev 5
CA-7 (continuous monitoring: a control that is not yet monitored is reported as not yet monitored, not as failed); and spec 105-calm-output (the output contract, marks
and codes). No standard defines how a command line draws an inventory, so the line below is this engine's decision, stated in the Decisions section.

### `fleet status` lists every machine

- **FR-001** `stolos fleet status` MUST list every machine the fleet knows, in this order: the controller PC first (its line unchanged: spec 107-pairing-and-query FR-009), the
  managed servers and workstations as now, then the adopted machines (paired, integrated, auto-adopted other than the controller), then the SNMP devices, then the network
  assets adopted through an integration. A fleet with no managed host MUST still list its adopted machines, devices and network assets.
- **FR-002** Each of those machines MUST have one line: its name, its kind, how it joined, its operating system, when it was last observed, its policy result, and its tags.
  The kind is `workstation` or `server` for an adopted machine, `device (<kind>)` for an SNMP device (`device (router)`) and `network asset (<class>)` for a network asset
  (`network asset (switch)`). How it joined is the mark of spec 107-pairing-and-query FR-007 and FR-009 (`paired`, `integrated`, `adopted via an integration (read, never probed)`,
  `auto-adopted ...`), from `joinedMark`. The operating system is what the probe reported (a device's model, a network asset's model). The last observation is
  `observed <date time>` or `not observed yet`. The policy result is short: `N passing`, and `N failing`, `N not observed yet` where they are not zero. The tags are the
  text of spec 108-tags FR-015 and 112-machine-reported-tags (`tagLine`: defined tags, then `custom: ...` for the free-form ones).
- **FR-003** The line of a network asset MUST also say the connector it came through, the account (the controller's address), and its state at the controller (`ONLINE`, or
  `gone from the integration`, or `not read yet`).
- **FR-004** Beneath its line a machine MUST show detail lines only for what is wrong or waiting: each failing policy as a warning with its fix and its code (as `host check`
  prints it), and, once for the machine, the policies that were not observed as one waiting item (⏳, FR-007) naming the command that observes them. A machine with nothing wrong
  has its line alone. A network asset's presence and state are said by the Network phase (spec 110-network-assets FR-009) and are not repeated as warnings.
- **FR-005** `fleet status` is a report (spec 105-calm-output FR-001): it MUST print these lines in the default mode, as it prints the others. `--json` MUST keep printing
  nothing on the screen. `stolos discover` and `stolos host check` MUST keep their output and their exit code, apart from FR-006.

### "No evidence" is not a failure

- **FR-006** A control whose evidence is none MUST NOT be printed as a failure or a warning, by `apply` (the compliance impact phase), `update`, `fleet status`, `host check`,
  `device check`, `stolos compliance drift`, the message of a drift mailed to the fleet's mailbox, and the Stolos Console's list of what a machine fails (a machine never observed fails nothing there). In the compliance impact and the drift, a control that went from no evidence
  to a failing status, where none of its changed evidence is a current failure (a check that was observed and failed within its service level), MUST be shown as
  waiting: `⏳ BCD-24 Data Backups: not observed yet` (`not observed recently` where what exists is stale), with ONE fix line, and the code `P117-NO-EVIDENCE`. In `host check`
  and `device check`, and in `fleet status`, a machine never observed, or a policy that could not tell (`unknown`), MUST be shown the same way, once per machine.
  A control that has evidence and fails MUST stay a warning or a failure exactly as before.
- **FR-007** A waiting item of FR-006 MUST count as not set up yet in the phase and in the closing verdict (`✨ ... · N not set up yet`), MUST NOT count as a warning or a
  failure, and a run with only such items MUST exit 0, as the other waiting items do (spec 105-calm-output FR-004 and FR-006).
- **FR-008** The one fix line MUST say what to run to observe it: `bun run stolos host observe <machine>` for an adopted machine, `bun run stolos fleet status` for a managed
  server, `bun run stolos device observe <device>` for a device, `bun run stolos estate observe <connector>` for a cloud account; and, where the policy cannot be observed for
  a reason of the machine, the reason: a machine's disk encryption needs the probe's `disk_encryption` fact (BitLocker on Windows, FileVault on macOS, LUKS on Linux), which
  the probe could not read.
- **FR-009** The display only MUST change: the evidence, the SCF statuses of a control (`no evidence`, `pass`, `partial`, `fail`), the requirement statuses, the OSCAL
  and the evidence bundles, the compliance score of spec 068-compliance FR-002 ("none is no evidence") and the gate of spec 074-change-impact MUST NOT change.
- **FR-010** The code `P117-NO-EVIDENCE` MUST be one `stolos explain` knows, with a plain explanation (what, why, the fix).

## Decisions

- **Kind of an adopted machine.** The probe does not say workstation or server. A machine whose probe reported Windows or macOS, or a Linux flavor of a desktop distribution
  (`omarchy`), is a `workstation`; any other adopted Linux machine is a `server`; a machine not observed yet is a `machine`.
- **Order.** The Network phase (spec 110-network-assets FR-009) stays where it is, the group of the integration; the machines of FR-001 follow the managed servers.
- **The gate.** The compliance gate (spec 074-change-impact, `compliance.gate.evidence`) still blocks on a control that turned to failing, and still says so in its own words;
  only what the impact prints as a warning is changed, so no gate changes meaning.

## Success criteria

- In the lab example fleet and in a sandbox fleet with a paired machine, an SNMP device and a network asset, `fleet status` has a line for each, with its kind, how it joined,
  its operating system, its last observation, its policy result, its tags, and (an asset) its account and state.
- A compliance impact whose only changes went from no evidence to failing prints ⏳ lines, no ⚠️, exits 0 and its verdict counts them as not set up yet.
