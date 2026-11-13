# 051: Machine identity, facts from machines, and the blank-disk guard

## Why

People make typing errors; machines report facts. A host's hardware facts (its network card, memory,
disks, make, model, serial) come from the machine. A person states intent: which host a machine
becomes, and whether its disks may be erased.

## Requirements

- **FR-001** `archon host add` and `boot arm` require exactly one of `--claim` (the next unknown
  machine to network-boot in 30 minutes becomes the host) and `--mac-address <mac>` (only that
  network card). Neither, or both, is refused before anything is written, with both commands shown.
  A host whose MAC its own machine reported (`registration.ts`, `macSource: "installed"`) may be
  armed without either.
- **FR-002** A MAC is accepted with colons, dashes, dots, or none, any case, and stored as
  `aa:bb:cc:dd:ee:ff`; anything else is refused at once.
- **FR-003** The MAC lives in `registration.ts` with its source: `"operator"` (typed) or
  `"installed"` (reported by the machine when it installed or was bootstrapped). `host.ts` no longer
  carries one (an older `mac` there is still read).
- **FR-004** When an unknown machine network-boots while a host armed for another card waits, the
  boot server names both and the fix (`boot.mismatch`); nothing installs.
- **FR-005** Before the installer touches a disk, the machine reports its facts to the boot server
  (`boot.machine`), which answers. The install goes on only when every disk is blank, when a person
  gave `--confirm-destroy <host>` for this install, when the machine installed as this host before
  (`macSource: "installed"`), or when `boot reinstall` reached it over SSH. Otherwise it stops
  before writing anything and powers off (`boot.guarded`). No answer from the boot server: no
  install.
- **FR-006** `--confirm-destroy <host>` is typed by a person (never served over MCP, refused from an
  agent), must name the host, and is spent by the one install it allowed.
- **FR-007** A machine that takes the installer image and asks for nothing within 6 minutes is named
  (`boot.stalled`), with the likely cause (Ubuntu's network installer needs about 8 GiB of RAM) and
  the bootstrap path.
- **FR-009** Each machine records what it is, as it reports itself (make, model, serial, CPUs,
  memory, disks, network cards), in `archon.sql` (`archon_inventory`) at first boot and whenever a
  verify finds it changed; `archon state` and `fleet status` show it. A host whose MAC its machine
  reported warns at verify when that card is no longer in it.
- **FR-008** `archon host bootstrap` reads the machine first (release, make, model, RAM, network
  cards), refuses the wrong Ubuntu release or a machine without the registered card, and records the
  card it reported.

## Success criteria

- **SC-001** `tests/identity051_test.ts`: MAC parsing, the choice, the facts, every guard decision,
  the guard script (valid sh, reports facts, fails closed), the stall watch, the bootstrap probe.
- **SC-002** The engine's lab (`tests/e2e/ci.sh`, network): a claimed machine whose disk holds a
  partition table is stopped by the guard and powers off; after `boot arm --claim --confirm-destroy`
  it installs to Ready, and its learned MAC is in `registration.ts`.
- **SC-003** The synthetic fleet's lab (`fleet.sh`): the server is added with `--mac-address`.
- **SC-004** Both labs: `fleet query` answers `archon_inventory` for the server.

## Open

- Reading memory from the firmware's tables in GRUB, before the installer: depends on Ubuntu's
  signed GRUB carrying its `smbios` module (to verify). The stall watch covers it until then.
