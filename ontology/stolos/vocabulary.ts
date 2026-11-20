/**
 * The vocabulary of Stolos' ontology (spec 101-ladder FR-004): its namespace, its terms (classes and properties), the class schemas its
 * individuals are made with, and the one way a code list is made, on commons' kernel RDF (commons 0012-ontology). Every schema here
 * carries a `spec` field, so that every individual names the specification it comes from and `bun run check:trace` holds it (commons
 * 0015-trace FR-008).
 *
 * @remarks
 * The namespace is `https://intellectual-frontiers.github.io/stolos/ontology#`: Stolos is public, its documentation site is published at
 * `https://intellectual-frontiers.github.io/stolos/`, so the IRI is one the organization controls, it can resolve to the published Turtle,
 * and it names no company domain inside an engine that holds no fleet's facts (Article 24). The terms and the code lists share it, as
 * commons' packaging vocabulary does; a code's local name carries its list's prefix (`kind-server`, `tier-read`), so that two lists may
 * hold the same word.
 *
 * @module
 */
// Spec: 101-ladder FR-004
import { Rung as MizanRung } from "@intellectual-frontiers/ontology/mizan";
import * as rdf from "@intellectual-frontiers/rdf";

const {
  classSchema,
  en,
  many,
  namespace,
  one,
  ontologyOf,
  optional,
  owl,
  OwlOntology,
  range,
  rdfs,
  skos,
  term,
  vocabulary,
  xsd,
} = rdf;

/** The namespace of Stolos' terms and code lists. */
export const STOLOS = namespace(
  "stolos",
  "https://intellectual-frontiers.github.io/stolos/ontology#",
);

/** The terms of Stolos' vocabulary: its classes and properties. */
export const stolos = vocabulary(STOLOS, {
  // The things a fleet is made of.
  Fleet: "owl:Class",
  Host: "owl:Class",
  Controller: "owl:Class",
  AdoptedMachine: "owl:Class",
  Device: "owl:Class",
  Signer: "owl:Class",
  ConsoleDevice: "owl:Class",
  Capability: "owl:Class",
  Check: "owl:Class",
  Finding: "owl:Class",
  Record: "owl:Class",
  Decision: "owl:Class",
  PairingCode: "owl:Class",
  TrustedNetwork: "owl:Class",
  EngineRelease: "owl:Class",
  ConsoleName: "owl:Class",
  PassphraseSession: "owl:Class",
  ProbeCache: "owl:Class",
  PhaseTiming: "owl:Class",
  PairingSession: "owl:Class",
  AddressBlock: "owl:Class",
  MachineTable: "owl:Class",
  Tag: "owl:Class",
  TagDimension: "owl:Class",
  TagRule: "owl:Class",
  TagGroup: "owl:Class",
  TagSelection: "owl:Class",
  TagClaim: "owl:Class",
  // Spec 109-integrations-api: an account's API as a typed integration, and what it reads.
  ApiIntegration: "owl:Class",
  NetworkClient: "owl:Class",
  NetworkDevice: "owl:Class",
  Vlan: "owl:Class",
  SwitchPort: "owl:Class",
  Lease: "owl:Class",
  PortForward: "owl:Class",
  FirewallRule: "owl:Class",
  WifiNetwork: "owl:Class",
  Route: "owl:Class",
  RouterHealth: "owl:Class",
  DnsZone: "owl:Class",
  DnsRecord: "owl:Class",
  EmailDomain: "owl:Class",
  EmailRoute: "owl:Class",
  EmailSender: "owl:Class",
  // The architecture.
  // The code lists' classes.
  OutcomeLevel: "owl:Class",
  OutputClass: "owl:Class",
  Verbosity: "owl:Class",
  LineKind: "owl:Class",
  SigningOutcome: "owl:Class",
  MachineKind: "owl:Class",
  SignerRole: "owl:Class",
  CommandTier: "owl:Class",
  DataClass: "owl:Class",
  IntegrationKind: "owl:Class",
  FileKind: "owl:Class",
  Listener: "owl:Class",
  Door: "owl:Class",
  DevicePath: "owl:Class",
  WayOfJoining: "owl:Class",
  PairingStage: "owl:Class",
  AnswerState: "owl:Class",
  TagColour: "owl:Class",
  TagCardinality: "owl:Class",
  TagOrigin: "owl:Class",
  TagTrust: "owl:Class",
  TagSource: "owl:Class",
  // Spec 115-compatibility: the seams between a PC and its machines, and what the PC says of a machine against them.
  Seam: "owl:Class",
  CompatStatus: "owl:Class",
  ApiKind: "owl:Class",
  ApiCapability: "owl:Class",
  // Spec 110-network-assets: the class of a network device and the facets a feature may ask for.
  DeviceClass: "owl:Class",
  DeviceFacet: "owl:Class",
  // Properties.
  spec: "owl:DatatypeProperty",
  emoji: "owl:DatatypeProperty",
  ascii: "owl:DatatypeProperty",
  protocol: "owl:DatatypeProperty",
  port: "owl:DatatypeProperty",
  onListener: "owl:ObjectProperty",
  pathPrefix: "owl:DatatypeProperty",
});

/** The schema of a class of Stolos: its label, its definition, its superclasses and the specs it comes from. */
export const StolosClass = classSchema(owl.Class, {
  label: one(rdfs.label, range.langString),
  definition: one(skos.definition, range.langString),
  subClassOf: many(rdfs.subClassOf, range.ref<"owl:Class">()),
  spec: many(stolos.spec, range.string),
});

const PROPERTY = {
  label: one(rdfs.label, range.langString),
  domain: optional(rdfs.domain, range.ref<"owl:Class" | "rdfs:Class">()),
  range: one(rdfs.range, range.ref<"owl:Class" | "rdfs:Datatype">()),
  definition: one(skos.definition, range.langString),
  spec: many(stolos.spec, range.string),
} as const;

/** The schema of a datatype property of Stolos, with the specs it comes from. */
export const StolosDatatypeProperty = classSchema(owl.DatatypeProperty, PROPERTY);

/** The schema of an object property of Stolos, with the specs it comes from. */
export const StolosObjectProperty = classSchema(owl.ObjectProperty, PROPERTY);

/** What every code of a code list states: its label, its definition, its word (the key code branches on) and the specs it comes from. */
const CODE = {
  label: one(rdfs.label, range.langString),
  definition: one(skos.definition, range.langString),
  notation: one(skos.notation, range.string),
  spec: many(stolos.spec, range.string),
} as const;

/** The schema of an outcome level: a code, with its marks from commons' palette (emoji and ASCII). */
export const OutcomeLevelSchema = classSchema(stolos.OutcomeLevel, {
  ...CODE,
  emoji: one(stolos.emoji, range.string),
  ascii: one(stolos.ascii, range.string),
});

/** The schema of an output class (spec 105-calm-output): what a command is for, which decides how much it shows by default. */
export const OutputClassSchema = classSchema(stolos.OutputClass, CODE);
/** The schema of a verbosity (spec 105-calm-output): how much of a run reaches the screen. */
export const VerbositySchema = classSchema(stolos.Verbosity, CODE);
/** The schema of a kind of output line (spec 105-calm-output): what a line of a run is, which decides whether calm shows it. */
export const LineKindSchema = classSchema(stolos.LineKind, CODE);

/** The schema of a signing outcome (spec 106-one-passphrase-speed): how an attempt to sign ended for the passphrase held in memory. */
export const SigningOutcomeSchema = classSchema(stolos.SigningOutcome, CODE);

/** The schema of a machine kind. */
export const MachineKindSchema = classSchema(stolos.MachineKind, CODE);
/** The schema of a signer's role. */
export const SignerRoleSchema = classSchema(stolos.SignerRole, CODE);
/** The schema of a command's tier. */
export const CommandTierSchema = classSchema(stolos.CommandTier, CODE);
/** The schema of a class of data. */
export const DataClassSchema = classSchema(stolos.DataClass, CODE);
/** The schema of a kind of integration. */
export const IntegrationKindSchema = classSchema(stolos.IntegrationKind, CODE);
/** The schema of a kind of file Stolos writes in a fleet repository. */
export const FileKindSchema = classSchema(stolos.FileKind, CODE);

/** The schema of a listener: one of the three ports the controller opens, with its transport protocol and port number. */
export const ListenerSchema = classSchema(stolos.Listener, {
  ...CODE,
  protocol: one(stolos.protocol, range.string),
  port: one(stolos.port, range.integer),
});

/** The schema of a pairing door: the way a machine reaches the pairing, and the listener it is on. */
export const DoorSchema = classSchema(stolos.Door, {
  ...CODE,
  onListener: one(stolos.onListener, range.ref<"stolos:Listener">()),
});

/** The schema of a device path: a URL path prefix reserved for one kind of device-specific endpoint. */
export const DevicePathSchema = classSchema(stolos.DevicePath, {
  ...CODE,
  pathPrefix: one(stolos.pathPrefix, range.string),
});

/** The schema of a way of joining (spec 107-pairing-and-query): how a machine came to be in the fleet. */
export const WayOfJoiningSchema = classSchema(stolos.WayOfJoining, CODE);
/** The schema of a pairing stage (spec 107-pairing-and-query): where one machine is in a pairing session. */
export const PairingStageSchema = classSchema(stolos.PairingStage, CODE);
/** The schema of an answer state (spec 107-pairing-and-query): where one machine is in a question to every machine. */
export const AnswerStateSchema = classSchema(stolos.AnswerState, CODE);

/** The schema of a tag colour (spec 108-tags): a named colour of the console's palette, the only way a tag is coloured. */
export const TagColourSchema = classSchema(stolos.TagColour, CODE);
/** The schema of a tag cardinality (spec 108-tags): how many values of a dimension a machine may hold. */
export const TagCardinalitySchema = classSchema(stolos.TagCardinality, CODE);
/** The schema of a tag origin (spec 108-tags): where a tag on a machine came from. */
export const TagOriginSchema = classSchema(stolos.TagOrigin, CODE);
/** The schema of a tag trust (spec 112-machine-reported-tags): what a fleet does with the tags machines report in one dimension. */
export const TagTrustSchema = classSchema(stolos.TagTrust, CODE);
/** The schema of a tag source (spec 112-machine-reported-tags): where on a machine a reported tag was read. */
export const TagSourceSchema = classSchema(stolos.TagSource, CODE);

/** The schema of a seam (spec 115-compatibility): one interface between a PC and its machines, versioned on its own. */
export const SeamSchema = classSchema(stolos.Seam, CODE);
/** The schema of a compatibility status (spec 115-compatibility): what a PC says of a machine against its own contract. */
export const CompatStatusSchema = classSchema(stolos.CompatStatus, CODE);

/** The schema of a kind of API an integration is (spec 109-integrations-api): what an account's API is a kind of, and so which capabilities it can offer. */
export const ApiKindSchema = classSchema(stolos.ApiKind, CODE);
/** The schema of a capability of an integration (spec 109-integrations-api): one thing an integration of a kind may read, written `<kind>-<capability>`. */
export const ApiCapabilitySchema = classSchema(stolos.ApiCapability, CODE);

/** The schema of a device class (spec 110-network-assets): what a network device is (a gateway, a switch, an access point, a camera, ...). */
export const DeviceClassSchema = classSchema(stolos.DeviceClass, CODE);
/** The schema of a device facet (spec 110-network-assets): one thing a device does, so that a feature asks for a facet and gets devices of any vendor. */
export const DeviceFacetSchema = classSchema(stolos.DeviceFacet, CODE);

/** The schema of a rung of the ladder (Article 0): commons' `mz:Rung` (commons 0016-ladder), which Stolos states its eight rungs with. */
export const RungSchema = MizanRung;

/**
 * A code list of a schema: each key is the word code branches on (the individual's `skos:notation`), its local name `<prefix>-<key>`,
 * so that the keys' union is the type the generator writes (commons 0012-ontology FR-004).
 */
export function codeList<
  C extends string,
  S extends rdf.Fields,
  const E extends Readonly<Record<string, Omit<rdf.ValuesOf<S>, "notation">>>,
>(
  schema: rdf.ClassSchema<C, S>,
  prefix: string,
  entries: E,
): rdf.CodeList<C, rdf.ValuesOf<S>, keyof E & string> {
  const out: Record<string, rdf.Individual<C, rdf.ValuesOf<S>>> = {};
  for (const [key, values] of Object.entries(entries)) {
    // The notation is the key: one fact, written once.
    const full = { ...values, notation: key } as unknown as rdf.ValuesOf<S>;
    out[key] = schema.make(term<C>(STOLOS, `${prefix}-${key}`), full);
  }
  return out as rdf.CodeList<C, rdf.ValuesOf<S>, keyof E & string>; // every key of E was made just now
}

/** The ontology itself. */
export const stolosOntology = OwlOntology.make(ontologyOf(STOLOS), {
  label: en("Stolos"),
  description: en(
    "The terms of Stolos, the fleet engine: the machines of a fleet, its signers and decisions, its checks and findings, the code lists the engine branches on, and the ladder its repository is built on.",
  ),
  versionInfo: "1.0.1",
});

const LADDER = "101-ladder FR-004";

/** The classes of Stolos, each with its definition and the specs it comes from. */
export const classes = [
  StolosClass.make(stolos.Fleet, {
    label: en("Fleet"),
    definition: en(
      "A set of machines under one identity, site and list of signers, kept in `fleets/<id>/` of an operator's repository.",
    ),
    spec: ["002-model FR-001", "082-multi-fleet"],
  }),
  StolosClass.make(stolos.Host, {
    label: en("Host"),
    definition: en(
      "A managed server or workstation: installed from its model and converged by `archon`.",
    ),
    spec: ["002-model"],
  }),
  StolosClass.make(stolos.AdoptedMachine, {
    label: en("Adopted machine"),
    definition: en(
      "A machine Stolos did not install: recorded, observed by a probe and held to policies, never converged.",
    ),
    spec: ["067-adopt"],
  }),
  StolosClass.make(stolos.Controller, {
    label: en("Controller"),
    definition: en(
      "The PC that runs `stolos`: an adopted machine with the role controller, observed locally, with no SSH server.",
    ),
    subClassOf: [stolos.AdoptedMachine],
    spec: ["097-controller FR-001"],
  }),
  StolosClass.make(stolos.Device, {
    label: en("Device"),
    definition: en("A printer, router, switch or other appliance, read over SNMP."),
    spec: ["069-integrate FR-005"],
  }),
  StolosClass.make(stolos.Signer, {
    label: en("Signer"),
    definition: en(
      "A person's key on a fleet's list of signers: a host applies only a tip of main one of them signed (Article 9).",
    ),
    spec: ["047-intent-and-identity FR-001"],
  }),
  StolosClass.make(stolos.ConsoleDevice, {
    label: en("Console device"),
    definition: en(
      "A browser registered with a passkey to sign in to the Stolos Console at its own HTTPS name, approved by a signer.",
    ),
    spec: ["100-remote-access FR-004"],
  }),
  StolosClass.make(stolos.Capability, {
    label: en("Capability"),
    definition: en(
      "A part of a host's model that contributes packages, files, units, ports and tools, each with its verification.",
    ),
    spec: ["002-model FR-003"],
  }),
  StolosClass.make(stolos.Check, {
    label: en("Check"),
    definition: en(
      "A test of evidence against a control: a policy of a machine, or a control of the control SDK.",
    ),
    spec: ["078-control-sdk"],
  }),
  StolosClass.make(stolos.Finding, {
    label: en("Finding"),
    definition: en(
      "What a check found, with its SCF controls, its severity and its fix, written as OCSF.",
    ),
    spec: ["068-compliance", "089-ocsf-schema-language"],
  }),
  StolosClass.make(stolos.Record, {
    label: en("Record"),
    definition: en(
      "A file Stolos writes in a fleet repository about what happened (a registration, an observation): sent by `stolos update`.",
    ),
    spec: ["099-engine-update FR-006"],
  }),
  StolosClass.make(stolos.Decision, {
    label: en("Decision"),
    definition: en(
      "A file in a fleet repository that holds what a person decided, sent only by the command that made the decision.",
    ),
    spec: ["047-intent-and-identity FR-006", "100-remote-access"],
  }),
  StolosClass.make(stolos.PairingCode, {
    label: en("Pairing code"),
    definition: en(
      "Eight characters with no look-alikes that a person types on a machine to pair it with the controller; every message after the script is signed with it.",
    ),
    spec: ["098-pair FR-002, FR-004"],
  }),
  StolosClass.make(stolos.TrustedNetwork, {
    label: en("Trusted network"),
    definition: en(
      "The site's LAN, or a zero trust mesh network the fleet chooses, on which the fleet's own short, content-authenticated exchanges run (Article 28).",
    ),
    spec: ["098-pair FR-008, FR-010"],
  }),
  StolosClass.make(stolos.EngineRelease, {
    label: en("Engine release"),
    definition: en(
      "A version of Stolos, an ifr:Release of the one work `stolos`: the annotated Git tag `stolos-v<version>` on the engine's main, that a fleet pins and stolos update adopts.",
    ),
    spec: ["099-engine-update FR-001, FR-002", "114-release-record FR-004, FR-005"],
  }),
  StolosClass.make(stolos.ConsoleName, {
    label: en("Console name"),
    definition: en(
      "An HTTPS name of the Stolos Console under the fleet's web domain, with its DNS record and certificate.",
    ),
    spec: ["100-remote-access FR-001, FR-002"],
  }),
  StolosClass.make(stolos.OutcomeLevel, {
    label: en("Outcome level"),
    definition: en("How a step ended, as every command line and console shows it, with its mark."),
    spec: ["099-engine-update FR-007"],
  }),
  StolosClass.make(stolos.OutputClass, {
    label: en("Output class"),
    definition: en(
      "What a command is for: a report is read as a whole (verbose by default), an action does something (calm by default).",
    ),
    spec: ["105-calm-output FR-001"],
  }),
  StolosClass.make(stolos.Verbosity, {
    label: en("Verbosity"),
    definition: en(
      "How much of a run reaches the screen: nothing but a verdict line, only what needs a person, every line, or JSON.",
    ),
    spec: ["105-calm-output FR-002"],
  }),
  StolosClass.make(stolos.LineKind, {
    label: en("Line kind"),
    definition: en(
      "What a line of a run is: a step that went well, a problem, something for the person to do, something waiting, a hint, or an outcome the person needs.",
    ),
    spec: ["105-calm-output FR-003"],
  }),
  StolosClass.make(stolos.SigningOutcome, {
    label: en("Signing outcome"),
    definition: en(
      "How an attempt to sign ended, which decides what happens to the passphrase held in memory: kept, thrown away and asked again, or thrown away.",
    ),
    spec: ["106-one-passphrase-speed FR-003"],
  }),
  StolosClass.make(stolos.PassphraseSession, {
    label: en("Passphrase session"),
    definition: en(
      "The daily key's passphrase held in the memory of one command, and of the runs nested in it, from the first time it is asked to the end of the command: handed to a signing tool by a per-run askpass helper, never stored, never in an environment variable, a file, a log or an argument, and wiped when the command ends.",
    ),
    spec: ["106-one-passphrase-speed FR-001, FR-002"],
  }),
  StolosClass.make(stolos.ProbeCache, {
    label: en("Probe cache"),
    definition: en(
      "What an earlier run found out about this PC's firewall, kept for a short time in the program's state folder so that the next run does not ask the system again; never stale across a rule change by more than its time to live.",
    ),
    spec: ["106-one-passphrase-speed FR-008"],
  }),
  StolosClass.make(stolos.PhaseTiming, {
    label: en("Phase timing"),
    definition: en(
      "A line of a run's log that says how long a phase took, in milliseconds, and a closing line for the whole run: for finding what is slow, never drawn on the screen.",
    ),
    spec: ["106-one-passphrase-speed FR-010"],
  }),
  StolosClass.make(stolos.MachineKind, {
    label: en("Machine kind"),
    definition: en(
      "What a machine of a fleet is to Stolos: managed, adopted, a device, a cloud's, discovered, or the controller.",
    ),
    spec: ["066-stolos-console FR-003"],
  }),
  StolosClass.make(stolos.SignerRole, {
    label: en("Signer role"),
    definition: en(
      "daily (approves changes) or recovery (kept offline, replaces a lost daily key).",
    ),
    spec: ["047-intent-and-identity FR-001"],
  }),
  StolosClass.make(stolos.CommandTier, {
    label: en("Command tier"),
    definition: en(
      "What a command may do: read, write the repository, change the host, or destroy.",
    ),
    spec: ["030-agent-layer FR-003"],
  }),
  StolosClass.make(stolos.DataClass, {
    label: en("Data class"),
    definition: en(
      "Whether data from end users is durable (it exists nowhere else) or ephemeral (losing it is harmless) (Article 23).",
    ),
    spec: ["044-durable FR-001"],
  }),
  StolosClass.make(stolos.IntegrationKind, {
    label: en("Integration kind"),
    definition: en(
      "What a machine integrates as: discovered, adopted, with osquery, as a server or as a workstation.",
    ),
    spec: ["069-integrate"],
  }),
  StolosClass.make(stolos.Listener, {
    label: en("Listener"),
    definition: en(
      "One of the three sockets the controller PC opens for Stolos (UDP 69 and TCP 8080 for the boot server, TCP 443 for the console over TLS): its protocol and port. Every other exchange is a route on one of them or is loopback-only (Article 29).",
    ),
    spec: ["103-three-ports FR-001, FR-002"],
  }),
  StolosClass.make(stolos.Door, {
    label: en("Door"),
    definition: en(
      "A way a machine reaches the pairing: plain HTTP on the boot server's port (the same trust as PXE) or TLS on the console's port, both serving one handler.",
    ),
    spec: ["103-three-ports FR-004"],
  }),
  StolosClass.make(stolos.DevicePath, {
    label: en("Device path"),
    definition: en(
      "A URL path prefix under `/device/`, the namespace reserved for device-specific endpoints on the controller's listeners; pairing is the first.",
    ),
    spec: ["103-three-ports FR-003"],
  }),
  StolosClass.make(stolos.PairingSession, {
    label: en("Pairing session"),
    definition: en(
      "What one `stolos pair` keeps while it runs: a code every machine may use, the machines that said hello and where each one is, and the client addresses refused. It stays open until the person who started it stops it; nothing is adopted without that person's yes, machine by machine.",
    ),
    spec: ["107-pairing-and-query FR-001, FR-002, FR-003"],
  }),
  StolosClass.make(stolos.AddressBlock, {
    label: en("Address block"),
    definition: en(
      "A client address that is refused for the rest of a pairing session after five wrong signatures from it; other addresses are not affected.",
    ),
    spec: ["107-pairing-and-query FR-004"],
  }),
  StolosClass.make(stolos.MachineTable, {
    label: en("Machine table"),
    definition: en(
      "The one merged table of a question asked to every machine: a row per answer, and a row for each machine that failed or timed out with its reason, drawn by the console's vendored grid.",
    ),
    spec: ["107-pairing-and-query FR-012, FR-013"],
  }),
  StolosClass.make(stolos.Tag, {
    label: en("Tag"),
    definition: en(
      "A label a fleet gives to machines, written `<dimension>:<value>` and defined in the fleet's own `tags.ts` (an id, a label, a colour and a description); or a free-form tag, a lowercase word with no colon, which is never defined and is always shown as custom.",
    ),
    spec: ["108-tags FR-001, FR-004, FR-005"],
  }),
  StolosClass.make(stolos.TagDimension, {
    label: en("Tag dimension"),
    definition: en(
      "A family of tags that answer one question about a machine (its environment, its role, its site, its owner, its criticality, its data class): one-of when a machine holds at most one of its values, many-of when it may hold several.",
    ),
    spec: ["108-tags FR-001, FR-003"],
  }),
  StolosClass.make(stolos.TagRule, {
    label: en("Tag rule"),
    definition: en(
      "A rule in the fleet's `tags.ts`, written in TypeScript over what Stolos knows of a machine (its operating system, address, kind, name, owner), that gives the machine a defined tag whenever it holds; the tag shows the rule as its origin.",
    ),
    spec: ["108-tags FR-009"],
  }),
  StolosClass.make(stolos.TagGroup, {
    label: en("Tag group"),
    definition: en(
      "A group in the fleet's `tags.ts` (a site network, an address range, or named machines) whose tags every member inherits; the tag shows the group as its origin.",
    ),
    spec: ["108-tags FR-010"],
  }),
  StolosClass.make(stolos.TagSelection, {
    label: en("Tag selection"),
    definition: en(
      "A choice of machines by their tags: tags that must all hold, tags of which one must hold, or a small expression (`env:prod and not role:db`) read by a typed parser, never evaluated as code.",
    ),
    spec: ["108-tags FR-012, FR-013"],
  }),
  StolosClass.make(stolos.TagClaim, {
    label: en("Tag claim"),
    definition: en(
      "A tag a machine says about itself (`env:prod` in its `/etc/machine-info`, a row of its own `archon tag` table, its firmware's maker and model): a statement made by the machine, never the fleet's own tag, read over the authenticated channel (reported) or heard on the network (announced). It is untrusted input: it is read with the tag grammar, capped and counted, and where it disagrees with the fleet in a dimension the fleet wins and the disagreement is a finding.",
    ),
    spec: ["112-machine-reported-tags FR-001, FR-002, FR-006"],
  }),
  StolosClass.make(stolos.TagColour, {
    label: en("Tag colour"),
    definition: en(
      "A named colour of the console's palette that a defined tag is drawn in, light and dark.",
    ),
    spec: ["108-tags FR-001"],
  }),
  StolosClass.make(stolos.TagCardinality, {
    label: en("Tag cardinality"),
    definition: en(
      "How many values of a tag dimension one machine may hold: one-of (at most one) or many-of (any number).",
    ),
    spec: ["108-tags FR-001, FR-004"],
  }),
  StolosClass.make(stolos.TagOrigin, {
    label: en("Tag origin"),
    definition: en(
      "Where a tag on a machine came from: a person (added by `stolos tag add` or at pairing), a rule of `tags.ts`, a group it inherits from, or, below those, a claim the machine made about itself (reported over the authenticated channel, or announced on the network).",
    ),
    spec: ["108-tags FR-009, FR-010, FR-011", "112-machine-reported-tags FR-002"],
  }),
  StolosClass.make(stolos.TagTrust, {
    label: en("Tag trust"),
    definition: en(
      "What a fleet does with the tags machines report in one dimension of its `tags.ts`: accept them (used like a rule's tags, below the fleet's own), keep them as hints (shown, never used to choose machines or scope policies), or ignore them (dropped and counted).",
    ),
    spec: ["112-machine-reported-tags FR-003"],
  }),
  StolosClass.make(stolos.TagSource, {
    label: en("Tag source"),
    definition: en(
      "Where on a machine a reported tag was read: its `/etc/machine-info`, its own `archon tag` table (local or fleet rows), or its firmware's SMBIOS facts.",
    ),
    spec: ["112-machine-reported-tags FR-005, FR-007, FR-008"],
  }),
  StolosClass.make(stolos.Seam, {
    label: en("Seam"),
    definition: en(
      "One interface between a PC (`stolos`) and its machines (`archon`), versioned on its own by a Semantic Version with a minimum: the fleet model's schema, the signed record formats, the probe's facts, the machine query views, or the MCP tool surface. The engine is one work with one version; what each side must understand of the other is a seam's.",
    ),
    spec: ["115-compatibility FR-001, FR-002"],
  }),
  StolosClass.make(stolos.CompatStatus, {
    label: en("Compatibility status"),
    definition: en(
      "What a PC says of one machine against its own contract, seam by seam: compatible (the engine may differ), too old for this PC, newer than this PC, or unknown (not reported yet).",
    ),
    spec: ["115-compatibility FR-005, FR-006"],
  }),
  StolosClass.make(stolos.ApiIntegration, {
    label: en("API integration"),
    definition: en(
      "An account's API read through the integration layer: it declares its kind (a router, a DNS provider, an email provider) and the capabilities of that kind it offers, and a function that needs a capability accepts only an integration that offers it.",
    ),
    spec: ["109-integrations-api FR-001, FR-002"],
  }),
  StolosClass.make(stolos.NetworkClient, {
    label: en("Network client"),
    definition: en(
      "A device connected to a network as the router sees it: its name, type (wired, wireless, VPN), MAC and IP address, and the device it is connected through.",
    ),
    spec: ["109-integrations-api FR-001, FR-013"],
  }),
  StolosClass.make(stolos.NetworkDevice, {
    label: en("Network device"),
    definition: en(
      "A device a network is made of and a controller has adopted (a gateway, a switch, an access point): its name, model, MAC and IP address, state and firmware.",
    ),
    spec: ["109-integrations-api FR-001, FR-013, FR-015"],
  }),
  StolosClass.make(stolos.Vlan, {
    label: en("VLAN"),
    definition: en(
      "A network of a router with its VLAN id (IEEE 802.1Q), whether it is enabled and whether it is the default one.",
    ),
    spec: ["109-integrations-api FR-001, FR-013"],
  }),
  StolosClass.make(stolos.SwitchPort, {
    label: en("Switch port"),
    definition: en(
      "One port of a switch or gateway: its index, state, speed, connector and power over Ethernet.",
    ),
    spec: ["109-integrations-api FR-001, FR-013"],
  }),
  StolosClass.make(stolos.Lease, {
    label: en("DHCP lease"),
    definition: en(
      "An address a router's DHCP server has given to a client, with the client's MAC address and when the lease ends.",
    ),
    spec: ["109-integrations-api FR-001, FR-014"],
  }),
  StolosClass.make(stolos.PortForward, {
    label: en("Port forward"),
    definition: en(
      "A rule that sends traffic arriving at a port of the router's public address to an address and port inside the network.",
    ),
    spec: ["109-integrations-api FR-001, FR-014"],
  }),
  StolosClass.make(stolos.FirewallRule, {
    label: en("Firewall rule"),
    definition: en(
      "A rule of a router's firewall: its action, the zones it applies between, whether it is enabled, and whether the system or a person made it.",
    ),
    spec: ["109-integrations-api FR-001, FR-013"],
  }),
  StolosClass.make(stolos.WifiNetwork, {
    label: en("Wi-Fi network"),
    definition: en(
      "A Wi-Fi network an access point broadcasts: its name, whether it is enabled, the frequencies it uses and how it is secured.",
    ),
    spec: ["109-integrations-api FR-001, FR-013"],
  }),
  StolosClass.make(stolos.Route, {
    label: en("Route"),
    definition: en(
      "An entry of a router's routing table: a destination network, its next hop and the interface it leaves by.",
    ),
    spec: ["109-integrations-api FR-001, FR-014"],
  }),
  StolosClass.make(stolos.RouterHealth, {
    label: en("Router health"),
    definition: en(
      "What a controller says of its own health: the version of its application and how many of its devices are online and offline.",
    ),
    spec: ["109-integrations-api FR-001, FR-013"],
  }),
  StolosClass.make(stolos.DnsZone, {
    label: en("DNS zone"),
    definition: en(
      "A zone a DNS provider serves for a domain, with its status and whether it is signed (DNSSEC).",
    ),
    spec: ["109-integrations-api FR-001, FR-007"],
  }),
  StolosClass.make(stolos.DnsRecord, {
    label: en("DNS record"),
    definition: en(
      "A record of a zone: its name, type, content, time to live and whether the provider proxies it.",
    ),
    spec: ["109-integrations-api FR-001, FR-007"],
  }),
  StolosClass.make(stolos.EmailDomain, {
    label: en("Email domain"),
    definition: en(
      "A domain as its email depends on it: its MX records, and whether it publishes SPF, DKIM and DMARC records and has email routing on.",
    ),
    spec: ["109-integrations-api FR-001, FR-008"],
  }),
  StolosClass.make(stolos.EmailRoute, {
    label: en("Email route"),
    definition: en(
      "A rule of an email routing service: the address it matches, whether it is enabled and what it does with a message (without the addresses it forwards to).",
    ),
    spec: ["109-integrations-api FR-001, FR-008"],
  }),
  StolosClass.make(stolos.EmailSender, {
    label: en("Email sender"),
    definition: en(
      "A way a domain sends email through a provider: the sending domain and how it is authenticated.",
    ),
    spec: ["109-integrations-api FR-001, FR-008"],
  }),
  StolosClass.make(stolos.ApiKind, {
    label: en("API kind"),
    definition: en(
      "What an account's API is a kind of: a router, a DNS provider or an email provider. Each kind has its own set of capabilities (`stolos:ApiCapability`).",
    ),
    spec: ["109-integrations-api FR-001"],
  }),
  StolosClass.make(stolos.ApiCapability, {
    label: en("API capability"),
    definition: en(
      "One thing an integration of a kind may read, written `<kind>-<capability>` (`router-clients`, `dns-zones`, `email-routing`): a type-level fact, so that asking for a capability an integration does not offer does not compile.",
    ),
    spec: ["109-integrations-api FR-001, FR-002"],
  }),
  StolosClass.make(stolos.DeviceClass, {
    label: en("Device class"),
    definition: en(
      "What a network device is, whatever its vendor: a gateway, a switch, an access point, a camera, a recorder, a door controller, a phone, or other (a model nobody classified).",
    ),
    spec: ["110-network-assets FR-001"],
  }),
  StolosClass.make(stolos.DeviceFacet, {
    label: en("Device facet"),
    definition: en(
      "One thing a device does (routing, switching, wireless, surveillance, access control): a feature asks for a facet and gets the devices of any vendor that have it; one device may have several.",
    ),
    spec: ["110-network-assets FR-001"],
  }),
  StolosClass.make(stolos.WayOfJoining, {
    label: en("Way of joining"),
    definition: en(
      "How a machine came to be in the fleet: auto-adopted (the controller), paired, integrated, adopted through an integration, managed, or cloud.",
    ),
    spec: ["107-pairing-and-query FR-007", "110-network-assets FR-002"],
  }),
  StolosClass.make(stolos.PairingStage, {
    label: en("Pairing stage"),
    definition: en(
      "Where one machine is in a pairing session: said hello, installing, waiting for the person, adopted, or refused.",
    ),
    spec: ["107-pairing-and-query FR-002, FR-003"],
  }),
  StolosClass.make(stolos.AnswerState, {
    label: en("Answer state"),
    definition: en(
      "Where one machine is in a question to every machine: asking, answered, failed, or timed out.",
    ),
    spec: ["107-pairing-and-query FR-010, FR-011"],
  }),
  StolosClass.make(stolos.FileKind, {
    label: en("File kind"),
    definition: en(
      "Whether a file Stolos writes is a record (sent by update) or a decision (sent by the command that decided).",
    ),
    spec: ["099-engine-update FR-006"],
  }),
] as const;

/** The properties of Stolos, each with its domain, range and the specs it comes from. */
export const properties = [
  StolosDatatypeProperty.make(stolos.spec, {
    label: en("spec"),
    range: xsd.string,
    definition: en(
      "The specification (`NNN-slug`) or requirement (`NNN-slug FR-NNN`) a term comes from; `bun run check:trace` holds it.",
    ),
    spec: [LADDER, "101-ladder FR-007"],
  }),
  StolosDatatypeProperty.make(stolos.protocol, {
    label: en("protocol"),
    domain: stolos.Listener,
    range: xsd.string,
    definition: en("The listener's transport: `tcp` or `udp`."),
    spec: ["103-three-ports FR-002"],
  }),
  StolosDatatypeProperty.make(stolos.port, {
    label: en("port"),
    domain: stolos.Listener,
    range: xsd.integer,
    definition: en("The listener's standard port number (the engine's default for it)."),
    spec: ["103-three-ports FR-002"],
  }),
  StolosObjectProperty.make(stolos.onListener, {
    label: en("on listener"),
    domain: stolos.Door,
    range: stolos.Listener,
    definition: en("The listener a pairing door is served on."),
    spec: ["103-three-ports FR-004"],
  }),
  StolosDatatypeProperty.make(stolos.pathPrefix, {
    label: en("path prefix"),
    domain: stolos.DevicePath,
    range: xsd.string,
    definition: en("The URL path prefix, with a leading slash and no trailing one."),
    spec: ["103-three-ports FR-003"],
  }),
  StolosDatatypeProperty.make(stolos.emoji, {
    label: en("emoji"),
    domain: stolos.OutcomeLevel,
    range: xsd.string,
    definition: en(
      "The mark of an outcome level where the terminal shows emoji (commons 0006-signals FR-022).",
    ),
    spec: ["099-engine-update FR-007"],
  }),
  StolosDatatypeProperty.make(stolos.ascii, {
    label: en("ASCII mark"),
    domain: stolos.OutcomeLevel,
    range: xsd.string,
    definition: en(
      "The mark of an outcome level where the terminal shows ASCII alone (commons 0006-signals FR-027).",
    ),
    spec: ["099-engine-update FR-007"],
  }),
] as const;
