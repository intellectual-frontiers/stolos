/**
 * `bun run check:mizan` (spec 104-mizan FR-004 to FR-006): commons' Mizan rules on Stolos' own specifications and its audit of terms, held against `tools/mizan.baseline.txt`, which
 * only shrinks: a requirement with no RFC 2119 keyword, an EARS trigger in no pattern, a scenario that is not Given, When, Then with a requirement, a plan with no Standards
 * considered, and a term of the vocabulary with no record of its basis (which fails whatever the baseline holds), as well as a decision overdue (90 days from the audit).
 *
 *     bun tools/mizan.ts                   check
 *     bun tools/mizan.ts --write-baseline  write the baseline (to start it, or to shrink it: never to add a line to pass)
 *     bun tools/mizan.ts --today YYYY-MM-DD  count the 90 days of a decision from that day (for a test)
 *
 * @module
 */
// Spec: 104-mizan FR-004, FR-005, FR-006
import process from "node:process";
import { holdHarness } from "@intellectual-frontiers/mizan";
import { termRecordsOf } from "@intellectual-frontiers/commons/ts/mizan";
import { terms as audit } from "../ontology/stolos/audit.ts";
import { stolos } from "../ontology/stolos/vocabulary.ts";

process.exitCode = holdHarness({
  root: ".",
  baselineFile: "tools/mizan.baseline.txt",
  today: process.argv.includes("--today")
    ? (process.argv[process.argv.indexOf("--today") + 1] ?? "")
    : new Date().toISOString().slice(0, 10),
  name: "check:mizan",
  terms: termRecordsOf(audit),
  termsFile: "ontology/stolos/audit.ts",
  completeness: [
    {
      file: "ontology/stolos/audit.ts",
      ontology: Object.values(stolos).map((t) => t.iri),
      recorded: audit.map((t) => t.values.termIri),
    },
  ],
  writeBaseline: process.argv.includes("--write-baseline"),
});
