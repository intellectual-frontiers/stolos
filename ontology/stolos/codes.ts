/**
 * The code lists of Stolos (spec 101-ladder FR-004, FR-006): each a list of individuals of one class, keyed by the word the engine
 * branches on, each citing the specification it comes from. `bun run gen` writes their keys as the unions and arrays of
 * `src/archon/ontology.auto.ts`, which the code imports instead of writing the words again.
 *
 * @module
 */
// Spec: 101-ladder FR-004, FR-006
import { palette, rdf } from "@intellectual-frontiers/commons/ts/kernel";
import {
  CommandTierSchema,
  codeList,
  DataClassSchema,
  DevicePathSchema,
  DoorSchema,
  FileKindSchema,
  IntegrationKindSchema,
  ListenerSchema,
  LineKindSchema,
  MachineKindSchema,
  OutcomeLevelSchema,
  OutputClassSchema,
  SignerRoleSchema,
  SigningOutcomeSchema,
  VerbositySchema,
  WayOfJoiningSchema,
  PairingStageSchema,
  AnswerStateSchema,
  TagCardinalitySchema,
  TagColourSchema,
  TagOriginSchema,
  TagTrustSchema,
  TagSourceSchema,
  SeamSchema,
  CompatStatusSchema,
  ApiKindSchema,
  ApiCapabilitySchema,
} from "./vocabulary.ts";

const { en } = rdf;

/** The marks of an outcome level, from commons' palette (commons 0006-signals FR-022, FR-027): the same in every command line. */
function marks(kind: palette.MarkKind): { readonly emoji: string; readonly ascii: string } {
  return { emoji: palette.MARKS[kind].emoji, ascii: palette.MARKS[kind].ascii };
}

/** How a step ended, as every command line and console shows it (spec 019-output, 052-self-describing, 099-engine-update FR-007). */
export const outcomeLevels = codeList(OutcomeLevelSchema, "outcome", {
  done: {
    label: en("done"),
    definition: en("The step did what it was asked."),
    spec: ["019-output"],
    ...marks("done"),
  },
  failed: {
    label: en("failed"),
    definition: en("The step failed: a problem with its fix."),
    spec: ["019-output"],
    ...marks("failed"),
  },
  warning: {
    label: en("warning"),
    definition: en("The step finished, with something to look at."),
    spec: ["019-output"],
    ...marks("warning"),
  },
  pending: {
    label: en("pending"),
    definition: en(
      "Not set up yet, expected until someone does it: shown with its next step, never a failure.",
    ),
    spec: ["052-self-describing"],
    ...marks("pending"),
  },
  action: {
    label: en("action"),
    definition: en(
      "A step that is the operator's to take (send a change, back up, approve): nothing is wrong.",
    ),
    spec: ["099-engine-update FR-007"],
    ...marks("action"),
  },
});

/** What a command is for, which decides how much it shows by default (spec 105-calm-output FR-001). */
export const outputClasses = codeList(OutputClassSchema, "output", {
  report: {
    label: en("report"),
    definition: en(
      "Meant to be read by a person as a whole (a doctor, a status, a long-running server): verbose by default, every line shown.",
    ),
    spec: ["105-calm-output FR-001"],
  },
  action: {
    label: en("action"),
    definition: en(
      "Does something (update, apply, upgrade, pair, adopt, back up): calm by default, only what needs a person is shown.",
    ),
    spec: ["105-calm-output FR-001"],
  },
});

/** How much of a run reaches the screen (spec 105-calm-output FR-002). */
export const verbosities = codeList(VerbositySchema, "verbosity", {
  quiet: {
    label: en("quiet"),
    definition: en("One verdict line and the exit code, nothing else (--quiet)."),
    spec: ["105-calm-output FR-002"],
  },
  calm: {
    label: en("calm"),
    definition: en(
      "Problems, what is the person's to do and the outcome lines, progress while working; a step that went well is not printed.",
    ),
    spec: ["105-calm-output FR-002"],
  },
  verbose: {
    label: en("verbose"),
    definition: en("Every line, steps that went well included (--verbose)."),
    spec: ["105-calm-output FR-002"],
  },
  json: {
    label: en("json"),
    definition: en("Nothing drawn: the result as JSON (--json)."),
    spec: ["105-calm-output FR-002"],
  },
});

/** What a line of a run is, which decides whether calm shows it (spec 105-calm-output FR-003). */
export const lineKinds = codeList(LineKindSchema, "line", {
  step: {
    label: en("step"),
    definition: en("A step or phase that went well: shown only with --verbose."),
    spec: ["105-calm-output FR-003"],
  },
  problem: {
    label: en("problem"),
    definition: en(
      "A failure or a warning (a cross or a warning mark): always shown, with its code.",
    ),
    spec: ["105-calm-output FR-003"],
  },
  yours: {
    label: en("yours"),
    definition: en(
      "Something that is the person's to do (a lightning mark): always shown, with its command.",
    ),
    spec: ["105-calm-output FR-003"],
  },
  waiting: {
    label: en("waiting"),
    definition: en(
      "Waiting on time or on someone else (an hourglass): shown in the closing block.",
    ),
    spec: ["105-calm-output FR-003"],
  },
  hint: {
    label: en("hint"),
    definition: en(
      "An optional feature that is merely off: shown at most once a week for each hint, and always with --verbose.",
    ),
    spec: ["105-calm-output FR-008"],
  },
  outcome: {
    label: en("outcome"),
    definition: en("A line the person needs (what was sent, what happens next): always shown."),
    spec: ["105-calm-output FR-003"],
  },
});

/** How an attempt to sign ended, and so what is done with the passphrase held in memory (spec 106-one-passphrase-speed FR-003). */
export const signingOutcomes = codeList(SigningOutcomeSchema, "signing", {
  unlocked: {
    label: en("unlocked"),
    definition: en(
      "The key unlocked and the commit was signed: the passphrase is kept for the rest of the command.",
    ),
    spec: ["106-one-passphrase-speed FR-003"],
  },
  refused: {
    label: en("refused"),
    definition: en(
      "The key did not unlock with the passphrase given: it is thrown away, the person is asked again (three tries in all), and what was kept before stays until a new one unlocks.",
    ),
    spec: ["106-one-passphrase-speed FR-003"],
  },
  failed: {
    label: en("failed"),
    definition: en(
      "Signing failed for another reason: a passphrase typed for this attempt is thrown away, one kept before stays.",
    ),
    spec: ["106-one-passphrase-speed FR-003"],
  },
});

/** What a machine of a fleet is to Stolos (spec 066-stolos-console FR-003, 097-controller FR-001). */
export const machineKinds = codeList(MachineKindSchema, "kind", {
  server: {
    label: en("server"),
    definition: en("A managed server, installed and converged by archon."),
    spec: ["002-model"],
  },
  workstation: {
    label: en("workstation"),
    definition: en("A managed workstation (Ubuntu, or Ubuntu on WSL)."),
    spec: ["020-workstation"],
  },
  adopted: {
    label: en("adopted"),
    definition: en("A machine Stolos did not install, observed by its probe."),
    spec: ["067-adopt"],
  },
  device: {
    label: en("device"),
    definition: en("An appliance read over SNMP."),
    spec: ["069-integrate FR-005"],
  },
  discovered: {
    label: en("discovered"),
    definition: en("A machine found on the network and recorded, not adopted yet."),
    spec: ["067-adopt"],
  },
  cloud: {
    label: en("cloud"),
    definition: en("A machine a connected cloud account reports."),
    spec: ["066-stolos-console FR-003"],
  },
  controller: {
    label: en("controller"),
    definition: en("The PC that runs stolos, an adopted machine observed locally."),
    spec: ["097-controller FR-001"],
  },
});

/** A signer's role (spec 047-intent-and-identity FR-001). */
export const signerRoles = codeList(SignerRoleSchema, "signer", {
  daily: {
    label: en("daily"),
    definition: en("Approves changes."),
    spec: ["047-intent-and-identity FR-001"],
  },
  recovery: {
    label: en("recovery"),
    definition: en("Kept offline, in the vault: replaces a lost or stolen daily key."),
    spec: ["047-intent-and-identity FR-001", "057-keys"],
  },
});

/** What a command may do (spec 030-agent-layer FR-003, FR-004). */
export const commandTiers = codeList(CommandTierSchema, "tier", {
  read: {
    label: en("read"),
    definition: en("Reads, and changes nothing."),
    spec: ["030-agent-layer FR-003"],
  },
  repo: {
    label: en("repo"),
    definition: en("Writes the fleet repository."),
    spec: ["030-agent-layer FR-003"],
  },
  mutate: {
    label: en("mutate"),
    definition: en("Changes the host."),
    spec: ["030-agent-layer FR-003"],
  },
  destructive: {
    label: en("destructive"),
    definition: en(
      "Removes users, packages, data or guests: never served to an agent (Article 17).",
    ),
    spec: ["030-agent-layer FR-004"],
  },
});

/** Whether data from end users is durable or ephemeral (Article 23, spec 044-durable FR-001). */
export const dataClasses = codeList(DataClassSchema, "data", {
  durable: {
    label: en("durable"),
    definition: en("It exists nowhere else."),
    spec: ["044-durable FR-001"],
  },
  ephemeral: {
    label: en("ephemeral"),
    definition: en("Losing it is harmless."),
    spec: ["044-durable FR-001"],
  },
});

/** What a machine integrates as, in this order (spec 069-integrate). */
export const integrationKinds = codeList(IntegrationKindSchema, "integration", {
  discover: {
    label: en("discover"),
    definition: en("Recorded as discovered."),
    spec: ["069-integrate"],
  },
  adopt: {
    label: en("adopt"),
    definition: en("Adopted: observed by its probe over SSH."),
    spec: ["069-integrate"],
  },
  osquery: {
    label: en("osquery"),
    definition: en("Adopted, with osquery installed."),
    spec: ["069-integrate", "093-osquery"],
  },
  server: {
    label: en("server"),
    definition: en("Made a managed server."),
    spec: ["069-integrate"],
  },
  workstation: {
    label: en("workstation"),
    definition: en("Made a managed workstation."),
    spec: ["069-integrate"],
  },
});

/** Whether a file Stolos writes in a fleet repository is a record or a decision (spec 099-engine-update FR-006, 100-remote-access). */
export const fileKinds = codeList(FileKindSchema, "file", {
  record: {
    label: en("record"),
    definition: en(
      "What happened (a registration, an observation): sent by stolos update, expected, never alarming.",
    ),
    spec: ["099-engine-update FR-006"],
  },
  decision: {
    label: en("decision"),
    definition: en(
      "What a person decided: sent by the command that decided, signed by whoever decided.",
    ),
    spec: ["100-remote-access"],
  },
});

/** The three ports the controller PC opens for Stolos (Article 29, spec 103-three-ports FR-001, FR-002). */
export const listeners = codeList(ListenerSchema, "listener", {
  "boot-tftp": {
    label: en("boot TFTP"),
    definition: en("The boot server's TFTP (PXE firmware speaks only plain TFTP)."),
    protocol: "udp",
    port: 69,
    spec: ["103-three-ports FR-001"],
  },
  "boot-http": {
    label: en("boot HTTP"),
    definition: en(
      "The boot server's plain HTTP (UEFI HTTP Boot and GRUB speak only plain HTTP); also door A of pairing.",
    ),
    protocol: "tcp",
    port: 8080,
    spec: ["103-three-ports FR-001", "103-three-ports FR-004"],
  },
  "console-https": {
    label: en("console HTTPS"),
    definition: en("The Stolos Console over TLS, on the LAN names; also door B of pairing."),
    protocol: "tcp",
    port: 443,
    spec: ["103-three-ports FR-001", "103-three-ports FR-004", "100-remote-access FR-003"],
  },
});

/** The ways a machine reaches pairing: both serve one handler (spec 103-three-ports FR-004). */
export const doors = codeList(DoorSchema, "door", {
  "lan-http": {
    label: en("LAN HTTP"),
    definition: en(
      "Plain HTTP on the boot server's port, on a trusted network (Article 28): the boot server's own, or a pair-only server `stolos pair` runs when boot serve is not.",
    ),
    onListener: listeners["boot-http"],
    spec: ["103-three-ports FR-004"],
  },
  tls: {
    label: en("TLS"),
    definition: en(
      "TLS on the console's port, for the console's LAN names only, when `stolos console --lan` is serving.",
    ),
    onListener: listeners["console-https"],
    spec: ["103-three-ports FR-004"],
  },
});

/** The URL namespaces reserved for device-specific endpoints (spec 103-three-ports FR-003). */
export const devicePaths = codeList(DevicePathSchema, "devicepath", {
  pair: {
    label: en("pair"),
    definition: en(
      "Pairing: the scripts, the hello and the check-in of a machine joining the fleet. `/device/` is reserved for device-specific endpoints; pairing is the first.",
    ),
    pathPrefix: "/device/pair",
    spec: ["103-three-ports FR-003"],
  },
});

/** How a machine came to be in the fleet (spec 107-pairing-and-query FR-007). */
export const waysOfJoining = codeList(WayOfJoiningSchema, "joined", {
  "auto-adopted": {
    label: en("auto-adopted"),
    definition: en(
      "The controller PC, which the fleet adopts by itself (spec 097): it needs no pairing and is observed by the local probe.",
    ),
    spec: ["107-pairing-and-query FR-007", "097-controller FR-001"],
  },
  paired: {
    label: en("paired"),
    definition: en("Adopted through `stolos pair`, after the person said yes to its prompt."),
    spec: ["107-pairing-and-query FR-007", "098-pair FR-006"],
  },
  integrated: {
    label: en("integrated"),
    definition: en(
      "Adopted by hand: `host adopt`, a check-in code from `host integrate`, or a device read over SNMP.",
    ),
    spec: ["107-pairing-and-query FR-007", "069-integrate"],
  },
  managed: {
    label: en("managed"),
    definition: en("A server or workstation Stolos installs and converges."),
    spec: ["107-pairing-and-query FR-007", "002-model"],
  },
  cloud: {
    label: en("cloud"),
    definition: en("A machine a connected cloud account reports."),
    spec: ["107-pairing-and-query FR-007", "066-stolos-console FR-003"],
  },
});

/** Where one machine is in a pairing session (spec 107-pairing-and-query FR-002, FR-003). */
export const pairingStages = codeList(PairingStageSchema, "stage", {
  hello: {
    label: en("said hello"),
    definition: en("The machine ran the line and its signed hello was answered."),
    spec: ["107-pairing-and-query FR-002"],
  },
  installing: {
    label: en("installing"),
    definition: en("The machine fetched the probe: it is turning on SSH and installing it."),
    spec: ["107-pairing-and-query FR-002"],
  },
  waiting: {
    label: en("waiting for you"),
    definition: en("The machine's signed check-in is queued for the person's yes or no."),
    spec: ["107-pairing-and-query FR-003"],
  },
  adopted: {
    label: en("adopted"),
    definition: en("The person said yes and the machine was adopted."),
    spec: ["107-pairing-and-query FR-003"],
  },
  refused: {
    label: en("refused"),
    definition: en("The person said no, or the machine could not be adopted."),
    spec: ["107-pairing-and-query FR-003"],
  },
});

/** Where one machine is in a question to every machine (spec 107-pairing-and-query FR-010, FR-011). */
export const answerStates = codeList(AnswerStateSchema, "answer", {
  asking: {
    label: en("asking"),
    definition: en("The machine is being asked: its answer has not come yet."),
    spec: ["107-pairing-and-query FR-010"],
  },
  answered: {
    label: en("answered"),
    definition: en("The machine answered, with rows or none."),
    spec: ["107-pairing-and-query FR-011"],
  },
  failed: {
    label: en("failed"),
    definition: en("The machine could not be asked, or refused, with its reason."),
    spec: ["107-pairing-and-query FR-011"],
  },
  "timed-out": {
    label: en("timed out"),
    definition: en("The machine did not answer within the time limit of each machine."),
    spec: ["107-pairing-and-query FR-010"],
  },
});

/** The colours a defined tag may be drawn in (spec 108-tags FR-001): names of the console's palette, never raw colours. */
export const tagColours = codeList(TagColourSchema, "colour", {
  grey: {
    label: en("grey"),
    definition: en("Neutral: the default of a tag that has no colour of its own."),
    spec: ["108-tags FR-001"],
  },
  red: {
    label: en("red"),
    definition: en("For what needs care: production, high criticality."),
    spec: ["108-tags FR-001"],
  },
  orange: {
    label: en("orange"),
    definition: en("A warm accent, between red and yellow."),
    spec: ["108-tags FR-001"],
  },
  yellow: {
    label: en("yellow"),
    definition: en("A caution accent."),
    spec: ["108-tags FR-001"],
  },
  green: {
    label: en("green"),
    definition: en("For what is safe to touch: lab, low criticality, public data."),
    spec: ["108-tags FR-001"],
  },
  teal: {
    label: en("teal"),
    definition: en("A cool accent, between green and blue."),
    spec: ["108-tags FR-001"],
  },
  blue: {
    label: en("blue"),
    definition: en("A calm accent for roles and sites."),
    spec: ["108-tags FR-001"],
  },
  violet: {
    label: en("violet"),
    definition: en("An accent for owners and teams."),
    spec: ["108-tags FR-001"],
  },
  pink: {
    label: en("pink"),
    definition: en("A soft accent for anything else."),
    spec: ["108-tags FR-001"],
  },
});

/** How many values of a dimension a machine may hold (spec 108-tags FR-001, FR-004). */
export const tagCardinalities = codeList(TagCardinalitySchema, "cardinality", {
  "one-of": {
    label: en("one of"),
    definition: en(
      "A machine holds at most one value of the dimension (an environment: prod, staging or lab).",
    ),
    spec: ["108-tags FR-004"],
  },
  "many-of": {
    label: en("many of"),
    definition: en("A machine may hold any number of the dimension's values (its roles)."),
    spec: ["108-tags FR-004"],
  },
});

/** Where a tag on a machine came from (spec 108-tags FR-009, FR-010, FR-011), strongest first. */
export const tagOrigins = codeList(TagOriginSchema, "origin", {
  person: {
    label: en("person"),
    definition: en(
      "Added by a person: `stolos tag add`, or the tags of `stolos pair`. It wins over a rule and over a group.",
    ),
    spec: ["108-tags FR-006, FR-008, FR-011"],
  },
  rule: {
    label: en("rule"),
    definition: en(
      "Given by a rule of the fleet's `tags.ts`, from what Stolos knows of the machine.",
    ),
    spec: ["108-tags FR-009"],
  },
  inherited: {
    label: en("inherited"),
    definition: en("Inherited from a group of the fleet's `tags.ts` the machine belongs to."),
    spec: ["108-tags FR-010"],
  },
  reported: {
    label: en("reported"),
    definition: en(
      "A claim the machine made about itself, read over the authenticated channel (SSH to a machine whose host key is pinned in Git). Below a group's tag; it never overrides what the fleet says.",
    ),
    spec: ["112-machine-reported-tags FR-001, FR-002"],
  },
  announced: {
    label: en("announced"),
    definition: en(
      "A claim heard on the network without authentication: a hint only, below a reported one. No source announces yet; the value exists so that a later spec has a place for it.",
    ),
    spec: ["112-machine-reported-tags FR-002"],
  },
});

/** What a fleet does with the tags machines report in one dimension (spec 112-machine-reported-tags FR-003). */
export const tagTrusts = codeList(TagTrustSchema, "trust", {
  accept: {
    label: en("accept"),
    definition: en(
      "A reported tag in the dimension is used like a rule's tag, below the fleet's own.",
    ),
    spec: ["112-machine-reported-tags FR-003"],
  },
  hint: {
    label: en("hint"),
    definition: en(
      "A reported tag in the dimension is shown with its origin, and never used to choose machines or scope policies. The default.",
    ),
    spec: ["112-machine-reported-tags FR-003"],
  },
  ignore: {
    label: en("ignore"),
    definition: en(
      "A reported tag in the dimension is dropped and counted; shown only in verbose.",
    ),
    spec: ["112-machine-reported-tags FR-003"],
  },
});

/** Where on a machine a reported tag was read (spec 112-machine-reported-tags FR-005, FR-007, FR-008). */
export const tagSources = codeList(TagSourceSchema, "source", {
  "machine-info": {
    label: en("machine-info"),
    definition: en(
      "The machine's `/etc/machine-info` (systemd machine-info(5)): DEPLOYMENT, LOCATION, CHASSIS and TAGS.",
    ),
    spec: ["112-machine-reported-tags FR-005"],
  },
  "archon-local": {
    label: en("archon-local"),
    definition: en(
      "A row of the machine's own `archon tag` table that a person on the machine added with `archon tag add`.",
    ),
    spec: ["112-machine-reported-tags FR-007"],
  },
  "archon-fleet": {
    label: en("archon-fleet"),
    definition: en(
      "A row of the machine's own `archon tag` table that the machine worked out from the fleet repository it holds, at its last apply.",
    ),
    spec: ["112-machine-reported-tags FR-008"],
  },
  smbios: {
    label: en("smbios"),
    definition: en(
      "The machine's firmware facts (DMTF DSP0134 SMBIOS: maker, model, chassis type, and a cloud provider's name), read from /sys/class/dmi/id.",
    ),
    spec: ["112-machine-reported-tags FR-006"],
  },
});

/** The seams between a PC and its machines (spec 115-compatibility FR-001): each is an interface versioned on its own. */
export const seams = codeList(SeamSchema, "seam", {
  model: {
    label: en("model"),
    definition: en(
      "The fleet model's schema: the types of the fleet, its hosts and its site, which `stolos` renders and `archon` applies.",
    ),
    spec: ["115-compatibility FR-001"],
  },
  "signed-records": {
    label: en("signed-records"),
    definition: en(
      "The formats of what is signed or recorded across the line: the signed commit and approval conventions, the pairing check-in text, and the observation and verify records.",
    ),
    spec: ["115-compatibility FR-001"],
  },
  "probe-facts": {
    label: en("probe-facts"),
    definition: en(
      "The facts an adopted machine's read-only probe answers with (its sections and keys), versioned by the probe's own version.",
    ),
    spec: ["115-compatibility FR-001", "115-compatibility FR-004"],
  },
  query: {
    label: en("query"),
    definition: en(
      "The machine query interface: the views of a machine's state database (archon_state, archon_query, osquery's archon_ tables) and their columns.",
    ),
    spec: ["115-compatibility FR-001"],
  },
  mcp: {
    label: en("mcp"),
    definition: en(
      "The MCP tool surface a machine serves: the tools, their arguments and their tiers.",
    ),
    spec: ["115-compatibility FR-001"],
  },
});

/** What a PC says of a machine against its own contract (spec 115-compatibility FR-005, FR-006). */
export const compatStatuses = codeList(CompatStatusSchema, "compat", {
  compatible: {
    label: en("compatible"),
    definition: en(
      "Every seam the machine reports is one this PC reads and the machine reads this PC's; the engine versions may differ.",
    ),
    spec: ["115-compatibility FR-005"],
  },
  "too-old": {
    label: en("too-old"),
    definition: en(
      "The machine reports a seam older than this PC's minimum: it cannot be read, or cannot read what this PC sends. The fix is on the machine (`archon update`).",
    ),
    spec: ["115-compatibility FR-005"],
  },
  newer: {
    label: en("newer"),
    definition: en(
      "The machine reports a seam this PC is too old to read (a higher major, or a minimum above this PC's version). The fix is on the PC (`stolos update`).",
    ),
    spec: ["115-compatibility FR-005"],
  },
  unknown: {
    label: en("unknown"),
    definition: en(
      "The machine has not reported its engine and seams (it has not been asked since it began reporting, or its engine is older than this contract).",
    ),
    spec: ["115-compatibility FR-005"],
  },
});

/** The kinds of API an integration may be (spec 109-integrations-api FR-001). */
export const apiKinds = codeList(ApiKindSchema, "api-kind", {
  router: {
    label: en("router"),
    definition: en(
      "A router and the controller that manages it: its clients, devices, networks, ports and firewall.",
    ),
    spec: ["109-integrations-api FR-001"],
  },
  dns: {
    label: en("DNS"),
    definition: en("A DNS provider: the zones it serves and their records."),
    spec: ["109-integrations-api FR-001"],
  },
  email: {
    label: en("email"),
    definition: en(
      "An email provider: the domains it handles, how it sends and how it routes inbound mail.",
    ),
    spec: ["109-integrations-api FR-001"],
  },
});

/** The capabilities of each kind of integration, written `<kind>-<capability>` (spec 109-integrations-api FR-001, FR-002). */
export const apiCapabilities = codeList(ApiCapabilitySchema, "api-capability", {
  "router-dhcp-leases": {
    label: en("router dhcp-leases"),
    definition: en("Reads the DHCP leases the router has given."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-clients": {
    label: en("router clients"),
    definition: en("Reads the clients connected to it."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-devices": {
    label: en("router devices"),
    definition: en("Reads the devices it manages."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-networks-and-vlans": {
    label: en("router networks-and-vlans"),
    definition: en("Reads its networks and VLANs."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-ports": {
    label: en("router ports"),
    definition: en("Reads the ports of its switches."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-port-forwards": {
    label: en("router port-forwards"),
    definition: en("Reads its port forwards."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-firewall-rules": {
    label: en("router firewall-rules"),
    definition: en("Reads its firewall rules."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-wifi": {
    label: en("router wifi"),
    definition: en("Reads its Wi-Fi networks."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-routes": {
    label: en("router routes"),
    definition: en("Reads its routes."),
    spec: ["109-integrations-api FR-001"],
  },
  "router-health": {
    label: en("router health"),
    definition: en("Reads its health."),
    spec: ["109-integrations-api FR-001"],
  },
  "dns-zones": {
    label: en("dns zones"),
    definition: en("Reads the zones the provider serves."),
    spec: ["109-integrations-api FR-001"],
  },
  "dns-records": {
    label: en("dns records"),
    definition: en("Reads the records of those zones."),
    spec: ["109-integrations-api FR-001"],
  },
  "email-domains": {
    label: en("email domains"),
    definition: en("Reads the domains it handles and their email DNS records."),
    spec: ["109-integrations-api FR-001"],
  },
  "email-sending": {
    label: en("email sending"),
    definition: en("Reads how the domains send mail through it."),
    spec: ["109-integrations-api FR-001"],
  },
  "email-routing": {
    label: en("email routing"),
    definition: en("Reads its rules for inbound mail."),
    spec: ["109-integrations-api FR-001"],
  },
});

/** Every code list, by the name of the type the generator writes for it, with the name of its array and what it is. */
export const CODE_LISTS = {
  OutcomeLevel: {
    array: "OUTCOME_LEVELS",
    list: outcomeLevels,
    what: "How a step ended, with its mark",
  },
  OutputClass: {
    array: "OUTPUT_CLASSES",
    list: outputClasses,
    what: "What a command is for, which decides how much it shows by default",
  },
  Verbosity: {
    array: "VERBOSITIES",
    list: verbosities,
    what: "How much of a run reaches the screen",
  },
  LineKind: {
    array: "LINE_KINDS",
    list: lineKinds,
    what: "What a line of a run is",
  },
  SigningOutcome: {
    array: "SIGNING_OUTCOMES",
    list: signingOutcomes,
    what: "How an attempt to sign ended, for the passphrase held in memory",
  },
  MachineKind: {
    array: "MACHINE_KINDS",
    list: machineKinds,
    what: "What a machine of a fleet is to Stolos",
  },
  WayOfJoining: {
    array: "WAYS_OF_JOINING",
    list: waysOfJoining,
    what: "How a machine came to be in the fleet",
  },
  PairingStage: {
    array: "PAIRING_STAGES",
    list: pairingStages,
    what: "Where one machine is in a pairing session",
  },
  AnswerState: {
    array: "ANSWER_STATES",
    list: answerStates,
    what: "Where one machine is in a question to every machine",
  },
  TagColour: {
    array: "TAG_COLOURS",
    list: tagColours,
    what: "The colours a defined tag may be drawn in",
  },
  TagCardinality: {
    array: "TAG_CARDINALITIES",
    list: tagCardinalities,
    what: "How many values of a tag dimension a machine may hold",
  },
  TagOrigin: {
    array: "TAG_ORIGINS",
    list: tagOrigins,
    what: "Where a tag on a machine came from",
  },
  TagTrust: {
    array: "TAG_TRUSTS",
    list: tagTrusts,
    what: "What a fleet does with the tags machines report in one dimension",
  },
  TagSource: {
    array: "TAG_SOURCES",
    list: tagSources,
    what: "Where on a machine a reported tag was read",
  },
  Seam: {
    array: "SEAM_IDS",
    list: seams,
    what: "One interface between a PC and its machines, versioned on its own",
  },
  CompatStatus: {
    array: "COMPAT_STATUSES",
    list: compatStatuses,
    what: "What a PC says of a machine against its own contract",
  },
  ApiKind: {
    array: "API_KINDS",
    list: apiKinds,
    what: "What an account's API is a kind of (an integration's kind)",
  },
  ApiCapability: {
    array: "API_CAPABILITIES",
    list: apiCapabilities,
    what: "One thing an integration of a kind may read, written <kind>-<capability>",
  },
  SignerRole: { array: "SIGNER_ROLES", list: signerRoles, what: "A signer's role" },
  CommandTier: { array: "COMMAND_TIERS", list: commandTiers, what: "What a command may do" },
  DataClass: {
    array: "DATA_CLASSES",
    list: dataClasses,
    what: "Whether data from end users is durable or ephemeral",
  },
  IntegrationKind: {
    array: "INTEGRATION_KINDS",
    list: integrationKinds,
    what: "What a machine integrates as",
  },
  FileKind: {
    array: "FILE_KINDS",
    list: fileKinds,
    what: "Whether a file Stolos writes is a record or a decision",
  },
  ListenerKind: {
    class: "Listener",
    array: "LISTENER_KINDS",
    list: listeners,
    what: "The three ports the controller opens",
    data: {
      name: "LISTENERS",
      doc: "Each listener's protocol and standard port, from the ontology",
      fields: { protocol: `"tcp" | "udp"`, port: "number" },
    },
  },
  PairingDoor: {
    class: "Door",
    array: "PAIRING_DOORS",
    list: doors,
    what: "The ways a machine reaches pairing",
    data: {
      name: "DOOR_LISTENERS",
      doc: "The listener each pairing door is served on",
      fields: { onListener: "ListenerKind" },
    },
  },
  DevicePathKind: {
    class: "DevicePath",
    array: "DEVICE_PATH_KINDS",
    list: devicePaths,
    what: "The URL namespaces reserved for device-specific endpoints",
    data: {
      name: "DEVICE_PATHS",
      doc: "Each device path's URL prefix",
      fields: { pathPrefix: "string" },
      after: `/** The URL prefix of pairing, \`/device/pair\`: every pairing route is relative to it (spec 103-three-ports FR-003). */\nexport const DEVICE_PAIR_PATH: string = DEVICE_PATHS.pair.pathPrefix;`,
    },
  },
} as const;

/** Every individual of the code lists, in order. */
export const individuals: readonly rdf.AnyIndividual[] = Object.values(CODE_LISTS).flatMap((c) =>
  Object.values<rdf.AnyIndividual>(c.list),
);
