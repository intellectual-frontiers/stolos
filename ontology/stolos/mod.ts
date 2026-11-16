/**
 * Stolos' ontology (constitution Article 0, rung 0; spec 101-ladder FR-004): every module of it, as the typed values the generator
 * (`tools/ontology.ts`) and the checks (`tools/trace.ts`, `tools/layers.ts`) read. It imports nothing but commons' kernel and its own
 * modules, and Turtle is written from it, never read.
 *
 * @module
 */
// Spec: 101-ladder FR-004
import { rdf } from "@intellectual-frontiers/commons/ts/kernel";
import { rungs } from "./architecture.ts";
import { individuals as codeIndividuals } from "./codes.ts";
import {
  classes,
  CommandTierSchema,
  DataClassSchema,
  FileKindSchema,
  IntegrationKindSchema,
  MachineKindSchema,
  OutcomeLevelSchema,
  properties,
  RungSchema,
  SignerRoleSchema,
  STOLOS,
  StolosClass,
  StolosDatatypeProperty,
  StolosObjectProperty,
  stolosOntology,
} from "./vocabulary.ts";

export { CODE_LISTS } from "./codes.ts";
export { rungs } from "./architecture.ts";
export { STOLOS } from "./vocabulary.ts";

/** The ontology's files, each with the namespaces its Turtle writes and the individuals it states, by module. */
export const files: readonly (rdf.OntologyFile & { readonly module: string })[] = [
  {
    name: "vocabulary",
    module: "ontology/stolos/vocabulary.ts",
    prefixes: [STOLOS, rdf.OWL, rdf.RDFS, rdf.SKOS, rdf.XSD, rdf.DCTERMS],
    individuals: [stolosOntology, ...classes, ...properties],
  },
  {
    name: "codes",
    module: "ontology/stolos/codes.ts",
    prefixes: [STOLOS, rdf.RDFS, rdf.SKOS],
    individuals: codeIndividuals,
  },
  {
    name: "architecture",
    module: "ontology/stolos/architecture.ts",
    prefixes: [STOLOS, rdf.RDFS, rdf.SKOS],
    individuals: rungs,
  },
];

/** The schemas whose individuals cite a spec in their `spec` field (commons 0015-trace FR-008). */
export const citingSchemas = [
  StolosClass,
  StolosDatatypeProperty,
  StolosObjectProperty,
  OutcomeLevelSchema,
  MachineKindSchema,
  SignerRoleSchema,
  CommandTierSchema,
  DataClassSchema,
  IntegrationKindSchema,
  FileKindSchema,
  RungSchema,
] as const;

/** A term's CURIE (`stolos:Fleet`), or its IRI where it is not in Stolos' namespace. */
export function curieOf(iri: string): string {
  return iri.startsWith(STOLOS.iri) ? `stolos:${iri.slice(STOLOS.iri.length)}` : iri;
}

/** Every term the ontology defines in its namespace, as CURIEs: the classes, the properties, the codes and the rungs. */
export function definedTerms(): ReadonlySet<string> {
  return new Set(
    files
      .flatMap((f) => f.individuals.map((i) => curieOf(i.iri)))
      .filter((c) => c.startsWith("stolos:")),
  );
}

/** The ladder as commons' layers check reads it (commons 0015-trace FR-009): each rung's number, name, homes and the rungs it may rely on. */
export function ladder(): readonly {
  readonly number: number;
  readonly name: string;
  readonly homes: readonly string[];
  readonly mayRelyOn: readonly number[];
}[] {
  return rungs.map((r) => ({
    number: r.values.rungNumber,
    name: r.values.label.value,
    homes: r.values.home ?? [],
    mayRelyOn: (r.values.mayRelyOn ?? []).map((m) => numberOf(m.iri)),
  }));
}

function numberOf(iri: string): number {
  return rungs.find((r) => r.iri === iri)?.values.rungNumber ?? -1;
}
