/**
 * 040-opt-in: the catalog of opt-in containers. Each runs under Podman, from a
 * Quadlet file (Podman's own systemd integration), on every server and masked
 * until an operator turns it on. Images are pinned by digest (Article 12); a
 * new version is a change to this file, through the spec loop.
 *
 * @module
 */

import type { SpecId } from "../model/types.ts";

/** One container Archon can run as an opt-in (Podman, through a systemd quadlet). */
export interface ContainerDef {
  /** The opt-in's name: its switch, archon-<name>.service, archon-<name> container. */
  name: string;
  /** What it is, in a few words, for people. */
  title: string;
  /** The spec that describes it. */
  spec: SpecId;
  /** registry/repository:tag@sha256:digest */
  image: string;
  /** The UID and GID the image runs as (data directories are owned by it). */
  uid: number;
  /** Published on 127.0.0.1 only: Traefik is the way in. */
  ports: Array<{ host: number; container: number; route: string; description: string }>;
  /** Host directories mounted into the container. */
  volumes: Array<{ host: string; container: string }>;
  /** Plain settings (never secrets). */
  environment: Record<string, string>;
  /** Root-only file of generated secrets, written before the container first starts. */
  secrets: string;
  /** Answers 200 when the container is ready (on 127.0.0.1). */
  health: string;
}

/** RustFS, the S3 server (spec 041): Apache-2.0, single node, its own console. */
export const S3: ContainerDef = {
  name: "s3",
  title: "S3 object storage (RustFS)",
  spec: "041-s3",
  image:
    "docker.io/rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74",
  uid: 10001,
  ports: [
    { host: 9300, container: 9000, route: "s3", description: "S3 API (path-style buckets)" },
    { host: 9301, container: 9001, route: "s3-console", description: "the S3 web console" },
  ],
  volumes: [{ host: "/srv/s3", container: "/data" }],
  environment: {
    RUSTFS_VOLUMES: "/data",
    RUSTFS_ADDRESS: ":9000",
    RUSTFS_CONSOLE_ENABLE: "true",
    RUSTFS_CONSOLE_ADDRESS: ":9001",
    RUSTFS_OBS_LOGGER_LEVEL: "warn",
  },
  secrets: "/var/lib/archon/s3/rustfs.env",
  health: "http://127.0.0.1:9300/health/ready",
};

/**
 * OpenObserve, the telemetry web UI (spec 050): logs, metrics, and traces in
 * one place, OTLP in, a single node on local disk. AGPL-3.0 (fine for running
 * it internally). Its own phone-home is off.
 */
export const OTEL_UI: ContainerDef = {
  name: "otel-ui",
  title: "Telemetry web UI (OpenObserve)",
  spec: "050-telemetry-ui",
  image:
    "docker.io/openobserve/openobserve:v1.1.2@sha256:4a154849432f75c4fb024de32fe34163c02406c905dab22bf8d213d2e3386392",
  uid: 10002,
  ports: [{
    host: 5080,
    container: 5080,
    route: "otel",
    description: "the telemetry web UI (OpenObserve)",
  }],
  volumes: [{ host: "/srv/otel-ui", container: "/data" }],
  environment: {
    ZO_DATA_DIR: "/data",
    ZO_HTTP_PORT: "5080",
    ZO_TELEMETRY: "false",
    ZO_COMPACT_DATA_RETENTION_DAYS: "14",
  },
  secrets: "/var/lib/archon/otel-ui/openobserve.env",
  health: "http://127.0.0.1:5080/healthz",
};

/** Every container Archon knows. */
export const CONTAINERS: ContainerDef[] = [S3, OTEL_UI];

/** The systemd unit that runs a container. */
export const unitOfContainer = (c: Pick<ContainerDef, "name">): string =>
  `archon-${c.name}.service`;
/** The quadlet file that describes a container to systemd. */
export const quadletPath = (c: Pick<ContainerDef, "name">): string =>
  `/etc/containers/systemd/archon-${c.name}.container`;
