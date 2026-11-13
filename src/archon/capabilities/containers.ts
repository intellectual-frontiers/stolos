// 040-opt-in: opt-in containers on every server. Each is a Podman Quadlet file
// whose generated unit stays masked until an operator turns it on; then it is
// unmasked and started, and its routes appear on Traefik (LAN only, spec 032).
// No image is downloaded until then.

import type { Capability, FileDef, UnitDef, WebRoute } from "../model/types.ts";
import { header } from "../render/systemd.ts";
import { CONTAINERS, quadletPath, unitOfContainer } from "../containers/catalog.ts";
import { quadlet } from "../containers/quadlet.ts";

const SPEC = "040-opt-in" as const;

export const containers = (): Capability => ({ host }) => {
  if (host.kind === "workstation") return { spec: SPEC };
  const files: FileDef[] = [];
  const units: UnitDef[] = [];
  const routes: WebRoute[] = [];
  for (const c of CONTAINERS) {
    const on = host.optIn?.[c.name]?.enabled === true;
    files.push(
      {
        path: quadletPath(c),
        content: quadlet(c),
        mode: "0644",
        owner: "root",
        spec: c.spec,
        onChange: [{ kind: "daemon-reload" }],
      },
      {
        path: `/etc/tmpfiles.d/archon-${c.name}.conf`,
        content: header(c.spec) + [
          ...c.volumes.map((v) => `d ${v.host} 0750 ${c.uid} ${c.uid} -`),
          `d ${c.secrets.replace(/\/[^/]+$/, "")} 0700 root root -`,
        ].join("\n") + "\n",
        mode: "0644",
        owner: "root",
        spec: c.spec,
        onChange: [{
          kind: "run",
          argv: ["systemd-tmpfiles", "--create", `/etc/tmpfiles.d/archon-${c.name}.conf`],
        }],
      },
    );
    units.push({
      unitName: unitOfContainer(c),
      managed: false,
      generated: true,
      state: "masked",
      switch: c.name,
      verify:
        // Rendered from the host's own record (spec 048).
        on
          ? `sh -c 'systemctl is-active --quiet ${
            unitOfContainer(c)
          } && curl -fsS -o /dev/null --max-time 5 ${c.health}'`
          : `sh -c '! systemctl is-active --quiet ${unitOfContainer(c)}'`,
      spec: c.spec,
    });
    if (on) {
      routes.push(...c.ports.map((p) => ({
        name: p.route,
        port: p.host,
        description: p.description,
        spec: c.spec,
      })));
    }
  }
  return {
    spec: SPEC,
    // Podman itself comes with the web front door (spec 032).
    files,
    units,
    routes,
    notes: [
      `Opt-in containers (off until an operator turns one on): ${
        CONTAINERS.map((c) => `${c.title}${host.optIn?.[c.name]?.enabled ? " (on)" : ""}`).join(
          ", ",
        )
      }.`,
    ],
  };
};
