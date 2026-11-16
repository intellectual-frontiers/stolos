# 097: The controller PC is a fleet machine

Issue intellectual-frontiers/stolos#34.

## Why

The PC that runs `stolos` (the controller, or boot machine) holds every secret of every fleet on
it, the signing keys, and the backups; it is the only place a destroy can be typed. An auditor asks
about it first. Until now it was not a fleet machine at all: adopted machines are observed over SSH,
and adopting the controller that way would turn on an SSH server on the one machine that must not
have one.

## Ontology

The terms this spec uses, defined in `ontology/stolos/` with this spec as their source where it is
theirs: `stolos:Controller` (a subclass of `stolos:AdoptedMachine`), the machine kind
`stolos:kind-controller` of `stolos:MachineKind`, `stolos:Fleet`, `stolos:Signer` and its role
`stolos:SignerRole` (`stolos:signer-daily`, `stolos:signer-recovery`), `stolos:Check` and
`stolos:Finding`.

## Requirements

- **FR-001** The PC records itself as an adopted machine with `role: "controller"`
  (`fleets/<fleet>/adopted/<name>/machine.ts`, the name from its hostname as a DNS label), with no
  host keys and no probe key: from `fleet init`, `keys setup`, `pair`, and `host observe`. It never
  takes a managed server's name or another adopted machine's.
- **FR-002** A controller is observed **locally**: Stolos runs the same probe script an adopted
  machine runs (`bin/stolos-probe.sh`, or `bin/stolos-probe.ps1` on Windows) from the engine, with
  the request in `SSH_ORIGINAL_COMMAND` as SSH would set it. Nothing listens, nothing is installed,
  and no key is made. `fleet query` reaches it the same way.
- **FR-003** A controller's observation adds its own facts (`observed.controller`): the daily
  signing key (locked by a passphrase, unlocked, or missing; held by an ssh-agent or not), the
  vault against the latest recorded backup (current, behind, or never; how many secrets it lacks),
  and the recovery key (in the vault or not; when it was last checked on this PC). No secret and no
  key material is recorded: only those states and dates.
- **FR-004** The policy pack adds four controller policies, each with SCF controls and a fix for
  the PC's OS: the signing key is locked and not in an agent (IAC-10); the latest backup holds every
  secret (BCD-24); the recovery key is in the vault and was checked in the last 6 months (BCD-24,
  IAC-10); no SSH server listens on the controller (CFG-04, NET-02). The usual policies apply too
  (disk encryption first: the vault is on that disk).
- **FR-005** On Windows the probe reads BitLocker without administrator rights where the usual
  ways need them (the Shell's `System.Volume.BitLockerProtection` property), so the controller's
  disk encryption is known when Stolos runs as the person, as it does.
- **FR-006** A fleet may have several controllers (each signer's PC). Each observes only itself;
  `host observe` on one passes over the others, saying so. `host release` of a controller removes
  only its model (nothing was installed on it).

## Success criteria

- **SC-001** `tests/controller097.test.ts`: the local probe answers `facts` on this machine; a
  controller's observation carries its facts; the four policies pass and fail as specified;
  another controller is not probed; the controller's declaration has no host keys.

## Decisions

- **Local, not SSH** (Article 28): adopting the controller must add no way in.
- **States, not secrets.** The observation says whether the key is locked and when the backup was
  made; it never holds a key, a hash of a secret, or a path inside the vault.
