/**
 * Spec 087 (part A): what endpoint management (MDM) and endpoint detection
 * and response (EDR) connectors share. Each reads its devices as
 * `hardware_device` records (serial number, hostname, operating system,
 * owner, disk encryption, last check-in, and an EDR's sensor health); the
 * estate graph merges them with Stolos's own probe by serial number, then
 * hostname, so each device is counted once. This module turns those records
 * into posture facts and the policies every such connector checks:
 *
 * - every device encrypts its disk (SCF CRY-07);
 * - every device checked in within {@link CHECK_IN_DAYS} days (AST-04, MON-02);
 * - every EDR sensor is present and healthy (END-04, MON-02);
 * - every device meets its MDM's compliance policy (CFG-04), where the MDM reports it.
 *
 * ```mermaid
 * flowchart LR
 *   mdm["MDM: Intune, Jamf Pro, Kandji"] & edr["EDR: Defender, Falcon, SentinelOne"] --> rec["hardware_device records"]
 *   rec --> posture["devicePosture: counts"] --> pol["devicePolicies (SCF)"]
 *   rec --> graph["estate graph: one fixed_asset per device"]
 *   probe["Stolos's probe (adopted)"] --> graph
 * ```
 *
 * @module
 */

import type { PolicyResult } from "../adopt/policy.ts";
import { check, type Observation } from "./connector.ts";
import { HARDWARE_DEVICE } from "./labels.ts";
import type { ObservedRecord } from "./sdk.ts";

/** A device that has not checked in for this many days is stale. */
export const CHECK_IN_DAYS = 14;

const DAY = 86_400_000;

/**
 * The posture facts of a connector's devices: how many, and how many are
 * unencrypted, stale, have an unhealthy sensor, or are not compliant. A fact
 * is left out when no device reports it (the policy is then unknown, not
 * passing).
 */
export function devicePosture(records: ObservedRecord[], now: Date): Record<string, number> {
  const devices = records.filter((r) => r.label === HARDWARE_DEVICE.name);
  const known = (k: string) => devices.filter((d) => d.props[k] !== undefined);
  const enc = known("encrypted");
  const seen = known("last_seen");
  const sensor = known("sensor_healthy");
  const compliant = known("compliant");
  const stale = (d: ObservedRecord) => {
    const t = Date.parse(String(d.props["last_seen"]));
    return !Number.isFinite(t) || now.getTime() - t > CHECK_IN_DAYS * DAY;
  };
  return {
    devices: devices.length,
    ...(enc.length
      ? { devicesUnencrypted: enc.filter((d) => d.props["encrypted"] === false).length }
      : {}),
    ...(seen.length ? { devicesStale: seen.filter(stale).length } : {}),
    ...(sensor.length
      ? { sensorsUnhealthy: sensor.filter((d) => d.props["sensor_healthy"] === false).length }
      : {}),
    ...(compliant.length
      ? { devicesNoncompliant: compliant.filter((d) => d.props["compliant"] === false).length }
      : {}),
  };
}

/** How to fix each failing device policy, in the vendor's console. */
export interface DeviceFixes {
  /** Turn on disk encryption. */
  encryption?: string;
  /** Bring stale devices back (or retire them). */
  checkIn: string;
  /** Repair or install the EDR sensor. */
  sensor?: string;
  /** Bring devices into compliance. */
  compliance?: string;
}

/** The device policies a connector checks, from {@link devicePosture}'s facts (one per fix given). */
export function devicePolicies(o: Observation, id: string, fixes: DeviceFixes): PolicyResult[] {
  const of = (v: string | number | boolean) => `${v} of ${o.posture["devices"]} devices`;
  return [
    ...(fixes.encryption
      ? [
          check(o, {
            id: `${id}-disk-encryption`,
            title: "Every device encrypts its disk",
            scf: ["CRY-07"],
            fact: "devicesUnencrypted",
            want: (v) => v === 0,
            show: (v) => `${of(v)} unencrypted`,
            fix: fixes.encryption,
          }),
        ]
      : []),
    check(o, {
      id: `${id}-check-in`,
      title: `Every device checked in within ${CHECK_IN_DAYS} days`,
      scf: ["AST-04", "MON-02"],
      fact: "devicesStale",
      want: (v) => v === 0,
      show: (v) => `${of(v)} not seen for over ${CHECK_IN_DAYS} days`,
      fix: fixes.checkIn,
    }),
    ...(fixes.sensor
      ? [
          check(o, {
            id: `${id}-sensor`,
            title: "Every device's sensor is present and healthy",
            scf: ["END-04", "MON-02"],
            fact: "sensorsUnhealthy",
            want: (v) => v === 0,
            show: (v) => `${of(v)} with a missing or unhealthy sensor`,
            fix: fixes.sensor,
          }),
        ]
      : []),
    ...(fixes.compliance
      ? [
          check(o, {
            id: `${id}-compliance`,
            title: "Every device meets its compliance policy",
            scf: ["CFG-04"],
            fact: "devicesNoncompliant",
            want: (v) => v === 0,
            show: (v) => `${of(v)} not compliant`,
            fix: fixes.compliance,
          }),
        ]
      : []),
  ];
}

/** An operating system's name and version, as one name ("macOS 15.1"). */
export const osName = (name?: string | null, version?: string | null): string | undefined =>
  [name, version].filter((x) => x).join(" ") || undefined;
