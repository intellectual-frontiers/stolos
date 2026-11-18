/**
 * Spec 117-adopted-in-status FR-006: a helper of `status117.test.ts`, run as a child in a sandbox fleet: prints what the Stolos Console
 * gathers of each machine (its name and what it fails), as JSON.
 *
 * @module
 */
// Spec: 117-adopted-in-status FR-006

import { stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { pcFacts } from "../src/archon/console/pc.ts";

const facts = await pcFacts();
stdio.stdout.writeSync(
  `${JSON.stringify(facts.machines.map((m) => ({ name: m.name, failing: m.failing, score: m.score })))}\n`,
);
