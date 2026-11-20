/**
 * Spec 083: samples, drawn so the auditor can draw them again. The auditor
 * gives a seed (any text: a number they chose, or a value from a public
 * randomness source they chose, such as a published beacon pulse; Stolos
 * only accepts it) and a sample size (theirs to choose, by their firm's
 * methodology). The method is simple random sampling without replacement by
 * random sort keys, deterministic from the seed:
 *
 * 1. each unit's key is `sha256(seed + "\n" + unit id)`, in lowercase hex;
 * 2. the units are ordered by key (then by id, should two keys be equal);
 * 3. the sample is the first `size` units (every unit, when the population is smaller).
 *
 * Every subset of that size is equally likely when SHA-256's output is
 * uniform, and no step depends on Stolos: a shell redraws it.
 *
 * ```sh
 * while read -r id; do
 *   printf '%s %s\n' "$(printf '%s\n%s' "$SEED" "$id" | sha256sum | cut -d' ' -f1)" "$id"
 * done < unit-ids.txt | LC_ALL=C sort | head -n "$SIZE" | cut -d' ' -f2-
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   seed["the auditor's seed"] --> key["key = sha256(seed, newline, unit id)"]
 *   pop["the population's unit ids"] --> key
 *   key --> sort["order by key"] --> take["the first n: the sample"]
 *   take --> trail["recorded in the trail: seed, method, size, population hash, units"]
 * ```
 *
 * @module
 */
// Spec: 083-auditor-portal

import { sha256 as sha256Hex } from "@intellectual-frontiers/crypto";
import type { Population, PopulationId } from "./populations.ts";

/** The sampling method's name, recorded with every sample. */
export const SAMPLE_METHOD = "stolos-srswor-sha256/1";

/** The method in words, recorded with every sample. */
export const SAMPLE_METHOD_DOC =
  "Simple random sampling without replacement by random sort keys: key = sha256(seed + LF + unit id) in lowercase hex; order the units by key (then id); take the first n.";

/** A seed: one line of printable text, 1 to 256 characters. */
export const SEED = /^[\x20-\x7e]{1,256}$/;

/** A unit's sort key. */
export function sampleKey(seed: string, unitId: string): Promise<string> {
  return sha256Hex(`${seed}\n${unitId}`);
}

/** A sample, as the trail records it. */
export interface SampleRecord {
  /** The control in scope it tests. */
  control: string;
  /** The population it is drawn from. */
  population: PopulationId;
  /** The population's hash when it was drawn. */
  populationHash: string;
  /** How many units the population had. */
  populationSize: number;
  /** The auditor's seed. */
  seed: string;
  /** {@link SAMPLE_METHOD}. */
  method: string;
  /** The size asked for. */
  size: number;
  /** The units drawn, by id, in draw order. */
  units: string[];
}

/** Draw `size` unit ids from `ids` with `seed` (see the module). */
export async function drawIds(
  ids: readonly string[],
  seed: string,
  size: number,
): Promise<string[]> {
  if (!SEED.test(seed)) {
    throw new Error("the seed is one line of printable text, 1 to 256 characters");
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("the sample size is a whole number from 1");
  }
  if (new Set(ids).size !== ids.length) throw new Error("the population's unit ids are not unique");
  const keyed = await Promise.all(ids.map(async (id) => ({ id, key: await sampleKey(seed, id) })));
  keyed.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return keyed.slice(0, size).map((k) => k.id);
}

/** Draw a sample from a population, as the trail records it. */
export async function drawSample(
  control: string,
  pop: Population,
  seed: string,
  size: number,
): Promise<SampleRecord> {
  return {
    control,
    population: pop.id,
    populationHash: pop.hash,
    populationSize: pop.units.length,
    seed,
    method: SAMPLE_METHOD,
    size,
    units: await drawIds(
      pop.units.map((u) => u.id),
      seed,
      size,
    ),
  };
}

/** Why a recorded sample does not match a population redrawn now (empty when it does). */
export async function checkSample(s: SampleRecord, pop: Population): Promise<string[]> {
  if (s.method !== SAMPLE_METHOD) return [`method ${s.method} is not ${SAMPLE_METHOD}`];
  const out: string[] = [];
  if (s.populationHash !== pop.hash) {
    out.push(
      `the population's hash is ${pop.hash}, the sample was drawn from ${s.populationHash} (another bundle, or the evidence changed)`,
    );
  }
  const again = await drawIds(
    pop.units.map((u) => u.id),
    s.seed,
    s.size,
  );
  if (again.join("\n") !== s.units.join("\n")) {
    out.push("redrawn from its seed, the sample has other units than the trail records");
  }
  return out;
}
