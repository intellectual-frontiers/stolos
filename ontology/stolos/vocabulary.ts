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
import { rdf } from "@intellectual-frontiers/commons/ts/kernel";

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
  // The architecture.
  Rung: "owl:Class",
  // The code lists' classes.
  OutcomeLevel: "owl:Class",
  OutputClass: "owl:Class",
  Verbosity: "owl:Class",
  LineKind: "owl:Class",
  MachineKind: "owl:Class",
  SignerRole: "owl:Class",
  CommandTier: "owl:Class",
  DataClass: "owl:Class",
  IntegrationKind: "owl:Class",
  FileKind: "owl:Class",
  Listener: "owl:Class",
  Door: "owl:Class",
  DevicePath: "owl:Class",
  // Properties.
  spec: "owl:DatatypeProperty",
  rungNumber: "owl:DatatypeProperty",
  home: "owl:DatatypeProperty",
  mayRelyOn: "owl:ObjectProperty",
  provedBy: "owl:DatatypeProperty",
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

/** The schema of a rung of the ladder (Article 0): its number, name, purpose, homes, the rungs it may rely on and what proves it. */
export const RungSchema = classSchema(stolos.Rung, {
  label: one(rdfs.label, range.langString),
  rungNumber: one(stolos.rungNumber, range.integer),
  definition: one(skos.definition, range.langString),
  home: many(stolos.home, range.string),
  mayRelyOn: many(stolos.mayRelyOn, range.ref<"stolos:Rung">()),
  provedBy: many(stolos.provedBy, range.string),
  spec: many(stolos.spec, range.string),
});

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
  versionInfo: "1",
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
      "A version of Stolos, a tag v<version> on the engine's main, that a fleet pins and stolos update adopts.",
    ),
    spec: ["099-engine-update FR-001, FR-002"],
  }),
  StolosClass.make(stolos.ConsoleName, {
    label: en("Console name"),
    definition: en(
      "An HTTPS name of the Stolos Console under the fleet's web domain, with its DNS record and certificate.",
    ),
    spec: ["100-remote-access FR-001, FR-002"],
  }),
  StolosClass.make(stolos.Rung, {
    label: en("Rung"),
    definition: en(
      "A rung of the ladder of Article 0: a purpose, its homes in the repository, the rungs it may rely on and what proves it.",
    ),
    spec: ["101-ladder FR-001"],
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
  StolosDatatypeProperty.make(stolos.rungNumber, {
    label: en("rung number"),
    domain: stolos.Rung,
    range: xsd.integer,
    definition: en("The rung's number, 0 (the ontology) to 7 (the documentation)."),
    spec: ["101-ladder FR-001"],
  }),
  StolosDatatypeProperty.make(stolos.home, {
    label: en("home"),
    domain: stolos.Rung,
    range: xsd.string,
    definition: en(
      "A glob of the paths on the rung; a trailing `/` is everything under a folder (commons 0015-trace FR-009).",
    ),
    spec: ["101-ladder FR-002"],
  }),
  StolosObjectProperty.make(stolos.mayRelyOn, {
    label: en("may rely on"),
    domain: stolos.Rung,
    range: stolos.Rung,
    definition: en("A lower rung this rung may import from (spec 101-ladder FR-003)."),
    spec: ["101-ladder FR-003"],
  }),
  StolosDatatypeProperty.make(stolos.provedBy, {
    label: en("proved by"),
    domain: stolos.Rung,
    range: xsd.string,
    definition: en("A command whose passing proves the rung."),
    spec: ["101-ladder FR-001"],
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
