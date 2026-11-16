/**
 * # Stolos: the fleet engine
 *
 * Stolos installs, converges, and verifies a fleet of Ubuntu servers and
 * workstations from a model written in TypeScript. Its command is `archon`.
 * The engine (this repository, public) holds no fleet: each fleet lives in a
 * fleet repository (private), under `fleets/<id>/`, and depends on the
 * engine's package of a released tag.
 *
 * Start with: `bun run stolos` in a fleet repository (where you are, and the
 * one thing to do next), then the model's types ({@link FleetDef} and
 * {@link HostDef} in `archon/model/types.ts`), then the guides: each folder's `mod.ts`
 * documents it (listed in `archon/core/guides.ts`; offline: `bun run stolos docs`).
 *
 * ## Two repositories, one approval
 *
 * ```mermaid
 * flowchart TB
 *   subgraph engine["intellectual-frontiers/stolos (public)"]
 *     src["src/: the engine"] --> tag["tag vX.Y.Z<br/>(immutable): the release"]
 *   end
 *   subgraph fleet["fleet repository (private)"]
 *     pin["package.json: github:...<br/>stolos#vX.Y.Z"] --- lock["bun.lock: the tag's<br/>commit, its integrity"]
 *     model["fleets/&lt;id&gt;/: fleet.ts, hosts/, signers.ts,<br/>registration.ts, decisions.ts"]
 *     tip["main: its tip signed by<br/>a key in signers.ts"]
 *   end
 *   tag -->|"stolos fleet upgrade"| pin
 *   model --> tip
 *   lock --> tip
 *   tip -->|"read-only deploy key"| hosts["hosts: /srv/archon<br/>bun install --frozen-lockfile"]
 *   hosts -->|"refuse unsigned,<br/>untrusted, or rolled back"| tip
 * ```
 *
 * A host moves only to a tip signed by a signer it trusts, descending from the
 * one it runs. The lock makes that signature cover the engine's code too.
 *
 * ## How a machine becomes a host
 *
 * ```mermaid
 * sequenceDiagram
 *   actor P as Person (boot machine)
 *   participant B as Boot server
 *   participant M as Machine
 *   P->>B: host add olympia --claim (or --mac-address)
 *   M->>B: network boot (PXE): shim, GRUB
 *   B->>M: GRUB menu: install olympia
 *   M->>B: installer image, its configuration
 *   M->>B: its facts: make, model, serial, RAM, disks
 *   B-->>M: ok (blank, confirmed, or its own machine) or stop
 *   M->>M: Ubuntu's installer, then the first boot
 *   M->>B: events: Packages, Tools, Verify, Ready
 *   B->>P: the MAC it reported, for registration.ts
 * ```
 *
 * ## What a machine knows about itself
 *
 * ```mermaid
 * flowchart LR
 *   run["archon apply / verify /<br/>first boot"] --> sql["archon.sql<br/>(readable SQL, canonical)"]
 *   sql --> db["archon.auto.sqlite.db"]
 *   db --> osq["osquery<br/>(allowlisted views)"]
 *   osq --> mcp["MCP server<br/>(ssh as ops)"]
 *   mcp --> fq["stolos fleet query /<br/>fleet status"]
 * ```
 *
 * Git holds intent (the model, decisions, who each host is); each machine holds
 * what it observed, and is asked, never pushed from.
 *
 * ## Four states, everywhere
 *
 * ```mermaid
 * stateDiagram-v2
 *   direction LR
 *   [*] --> ok
 *   [*] --> pending: not set up yet (exit 3)
 *   [*] --> warn
 *   [*] --> fail
 *   pending --> ok: its next step done
 *   fail --> [*]: the run exits 1
 * ```
 *
 * Every problem has a stable code: `archon explain <code>`.
 *
 * ## Where things are
 *
 * - `archon/model/`: the model's types, loading, and validation.
 * - `archon/capabilities/`: what a host gets (packages, files, units, checks).
 * - `archon/install/`: host add, the first boot, bootstrap, recognition.
 * - `archon-boot/`: the boot server (PXE, GRUB, the blank-disk guard).
 * - `archon/identity/`: signers and signatures.
 * - `archon/fleet/`: upgrade, registration, decisions, scaffolding.
 * - `archon/state/`: archon.sql, verify, query, inventory.
 * - `archon/telemetry/` and `archon/core/telemetry.ts`: OpenTelemetry.
 * - `archon/guide/`: where am I, and the guide.
 * - `archon/core/`: paths, the terminal UI, explain, secrets.
 *
 * @module
 */

export type { FleetDef, HostDef } from "./archon/model/types.ts";
export { VERSION } from "./archon/version.ts";
