/**
 * 040-opt-in: a container as a Podman Quadlet file. The image runs as its own
 * unprivileged user, with every capability dropped and no way to gain more,
 * on 127.0.0.1 only.
 *
 * @module
 */

import type { ContainerDef } from "./catalog.ts";

export function quadlet(c: ContainerDef): string {
  return [
    `# Rendered by archon from specs 040-opt-in and ${c.spec}. Do not edit.`,
    `# An opt-in container: masked until an operator turns it on (archon opt-in).`,
    "[Unit]",
    `Description=Archon opt-in container: ${c.title}`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Container]",
    `ContainerName=archon-${c.name}`,
    `Image=${c.image}`,
    "Pull=missing",
    `User=${c.uid}:${c.uid}`,
    "NoNewPrivileges=true",
    "DropCapability=ALL",
    `EnvironmentFile=${c.secrets}`,
    ...Object.entries(c.environment).map(([k, v]) => `Environment=${k}=${v}`),
    ...c.volumes.map((v) => `Volume=${v.host}:${v.container}`),
    ...c.ports.map((p) => `PublishPort=127.0.0.1:${p.host}:${p.container}`),
    "",
    "[Service]",
    "Restart=on-failure",
    // The first start pulls the image.
    "TimeoutStartSec=900",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}
