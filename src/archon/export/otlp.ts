/**
 * Spec 092: OCSF events as OpenTelemetry logs, in the OTLP/HTTP JSON
 * encoding: the body of an `ExportLogsServiceRequest` that any OTLP receiver
 * (a Collector, an observability backend) accepts at `/v1/logs`. Only the
 * request body is built here; sending it is delivery's job.
 *
 * Each OCSF event is one LogRecord (the OpenTelemetry logs data model):
 *
 * - `body`: the event itself, as a structured value (a map);
 * - `eventName`: `ocsf.<class>` (for example `ocsf.compliance_finding`),
 *   so it is an Event in OpenTelemetry's sense;
 * - attributes `ocsf.class_uid` and `ocsf.category_uid`;
 * - `timeUnixNano`: the event's `time`; severity: INFO, WARN for a finding
 *   that is not a pass.
 *
 * The resource says who produced it: `service.name` stolos, its version,
 * and the fleet (`service.namespace`).
 *
 * With `entities`, inventory also becomes OpenTelemetry entity events
 * (`entity.state`, a Development-status part of the specification), one per
 * machine (`host`) and per other node: off by default, since receivers may
 * not understand them yet. People and accounts are never entity events. The
 * entity's type is the attribute `entity.type`; its identity and description
 * (maps) are the record's body, `entity.id` and `entity.description`, since
 * IFC TypeScript's attributes hold no maps.
 *
 * The request is encoded by IFC TypeScript's kernel (`otlp.encodeLogs`).
 *
 * ```mermaid
 * flowchart LR
 *   ocsf["OCSF events"] --> rec["LogRecord: body = event, eventName = ocsf.&lt;class&gt;"]
 *   rec --> req["ExportLogsServiceRequest (OTLP/HTTP JSON)"]
 *   inv["fixed assets, nodes"] -. "entities: true" .-> ent["entity.state events"] -.-> req
 *   req --> delivery["delivery: POST /v1/logs"]
 * ```
 *
 * @module
 */
// Spec: 092-exporters

import { type JsonObject } from "@intellectual-frontiers/formats";
import { type otel, otlp } from "@intellectual-frontiers/telemetry";
import { grc } from "@intellectual-frontiers/grc/host";
import { ocsfClassName } from "../ocsf/classes.ts";
import { VERSION } from "../version.ts";
import type { OcsfEvent } from "./ocsf.ts";

/** Options for the request. */
export interface OtlpOptions {
  /** The fleet's id (service.namespace). */
  fleet: string;
  /** Also send inventory as OpenTelemetry entity events (Development status; default off). */
  entities?: boolean;
  /** The time entity events carry (default: each event's own time). */
  now?: Date;
}

const nanos = (msTime: number): bigint => BigInt(Math.round(msTime)) * 1_000_000n;

/** One OCSF event as an OpenTelemetry log record: the event is its body. */
export function ocsfLogRecord(e: OcsfEvent): otel.LogRecord {
  const warn = e.class_uid === 2003 && e.compliance.status_id !== 1;
  const t = nanos(e.time);
  const body = grc.toAnyValue(e);
  return {
    time: t,
    observedTime: t,
    severityNumber: warn ? 13 : 9,
    severityText: warn ? "WARN" : "INFO",
    eventName: `ocsf.${ocsfClassName(e.class_uid)}`,
    ...(body === undefined ? {} : { body }),
    attributes: {
      "ocsf.class_uid": BigInt(e.class_uid),
      "ocsf.category_uid": BigInt(e.category_uid),
    },
    droppedAttributesCount: 0,
  };
}

/** An inventory event as an OpenTelemetry entity.state event, or undefined (people, findings). */
export function entityRecord(e: OcsfEvent, now?: Date): otel.LogRecord | undefined {
  const t = nanos(now?.getTime() ?? e.time);
  const record = (
    type: string,
    id: Record<string, string>,
    description: Record<string, string>,
  ): otel.LogRecord => ({
    time: t,
    observedTime: t,
    severityNumber: 9,
    severityText: "INFO",
    eventName: "entity.state",
    body: { "entity.id": id, "entity.description": description },
    attributes: { "entity.type": type },
    droppedAttributesCount: 0,
  });
  if (e.class_uid === 5001) {
    const d = e.device;
    return record(
      "host",
      { "host.id": d.uid ?? "" },
      {
        ...(d.hostname ? { "host.name": d.hostname } : {}),
        ...(d.type ? { "host.type": d.type } : {}),
        ...(d.os ? { "os.name": d.os.name } : {}),
        ...(d.model ? { "host.model": d.model } : {}),
      },
    );
  }
  if (e.class_uid === 5023) {
    const r = e.resources[0];
    if (!r?.uid) return undefined;
    const connector = r.tags?.find((x) => x.name === "connector")?.value;
    return record(
      `stolos.${r.type ?? "resource"}`,
      { "stolos.node.uid": r.uid },
      {
        ...(r.name ? { "stolos.node.name": r.name } : {}),
        ...(connector ? { "stolos.connector": connector } : {}),
      },
    );
  }
  return undefined;
}

/** The OTLP/HTTP JSON logs request (ExportLogsServiceRequest) for these events, and entity events when asked. */
export function otlpLogsRequest(events: readonly OcsfEvent[], o: OtlpOptions): JsonObject {
  const records = events.map(ocsfLogRecord);
  if (o.entities) {
    for (const e of events) {
      const r = entityRecord(e, o.now);
      if (r) records.push(r);
    }
  }
  return otlp.encodeLogs([
    {
      resource: {
        attributes: {
          "service.name": "stolos",
          "service.version": VERSION,
          "service.namespace": o.fleet,
        },
      },
      scope: { name: "stolos.export", version: VERSION },
      records,
    },
  ]);
}
