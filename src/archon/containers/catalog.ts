// 040-opt-in: the catalog of opt-in containers. Each runs under Podman, from a
// Quadlet file (Podman's own systemd integration), on every server and masked
// until an operator turns it on. Images are pinned by digest (Article 12); a
// new version is a change to this file, through the spec loop.

import type { SpecId } from "../model/types.ts";

export interface ContainerDef {
  /** The opt-in's name: its switch, archon-<name>.service, archon-<name> container. */
  name: string;
  title: string;
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

export const CONTAINERS: ContainerDef[] = [S3];

export const unitOfContainer = (c: Pick<ContainerDef, "name">) => `archon-${c.name}.service`;
export const quadletPath = (c: Pick<ContainerDef, "name">) =>
  `/etc/containers/systemd/archon-${c.name}.container`;
