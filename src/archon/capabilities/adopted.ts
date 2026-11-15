/**
 * 095-proposals: what a host adopted from a proposal. `stolos proposal
 * accept` adds one `adopted({...})` to the host's `capabilities` per accepted
 * proposal, naming the proposal and the draft spec it wrote, so every item
 * that began as a change made on the server is in the model with its reason.
 * Edit it like any other part of the model.
 *
 * Overrides of Ubuntu defaults: only what the proposal adopted (a unit
 * enabled, disabled, or masked against its package's preset), each listed in
 * the draft spec.
 *
 * @example
 * ```ts
 * import { adopted } from "./adopted.ts";
 *
 * const nginx = adopted({
 *   proposal: "alpha-20261114-1905-ab12",
 *   spec: "096-alpha-nginx-for-the-app",
 *   packages: ["nginx"],
 *   enable: ["nginx.service"],
 *   ports: [{ port: 443, protocol: "tcp" }],
 * });
 * ```
 *
 * @module
 */

import type { Capability, SpecId, UnitDef } from "../model/types.ts";

/** What one accepted proposal adds to a host. */
export interface AdoptedDef {
  /** The proposal it came from. */
  proposal: string;
  /** The draft spec `accept` wrote for it. */
  spec: SpecId;
  /** apt packages to install. */
  packages?: string[];
  /** Snaps to install. */
  snaps?: string[];
  /** Units Ubuntu ships, to enable and start. */
  enable?: string[];
  /** Units to disable. */
  disable?: string[];
  /** Units to mask. */
  mask?: string[];
  /** Ports to open in the firewall. */
  ports?: Array<{ port: number; protocol: "tcp" | "udp" }>;
  /** Files to write (small, non-secret text). */
  files?: Array<{ path: string; content: string; mode: string; owner: string; group?: string }>;
}

/** What a host adopted from one proposal (spec 095), as a capability. */
export const adopted = (d: AdoptedDef): Capability => () => {
  const spec = d.spec;
  const unit = (unitName: string, state: UnitDef["state"]): UnitDef => ({
    unitName,
    managed: false,
    state,
    ...(state === "enabled" ? { start: true } : {}),
    verify: state === "enabled"
      ? `systemctl is-enabled --quiet ${unitName}`
      : state === "masked"
      ? `sh -c 'test "$(systemctl is-enabled ${unitName})" = masked'`
      : `sh -c '! systemctl is-enabled --quiet ${unitName}'`,
    spec,
  });
  return {
    spec,
    packages: [
      ...(d.packages ?? []).map((name) => ({ name, spec })),
      ...(d.snaps ?? []).map((name) => ({ name, source: "snap" as const, spec })),
    ],
    units: [
      ...(d.enable ?? []).map((u) => unit(u, "enabled")),
      ...(d.disable ?? []).map((u) => unit(u, "disabled")),
      ...(d.mask ?? []).map((u) => unit(u, "masked")),
    ],
    ports: (d.ports ?? []).map((p) => ({ ...p, spec })),
    files: (d.files ?? []).map((f) => ({ ...f, spec })),
    notes: [`Adopted from proposal ${d.proposal} (spec ${spec}).`],
  };
};
