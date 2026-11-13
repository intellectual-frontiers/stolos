// Shared test fixtures: a valid fleet and host.

import { foundation } from "../src/archon/capabilities/mod.ts";
import type { FleetDef, HostDef } from "../src/archon/model/types.ts";

export const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKexampleexampleexampleexampleexampleexam me@laptop";

export function fleet(over: Partial<FleetDef> = {}): FleetDef {
  return {
    id: "lab",
    title: "Test fleet",
    repository: { slug: "example/fleet", url: "https://github.com/example/fleet" },
    ubuntu: { release: "26.04", codename: "resolute" },
    timezone: "America/New_York",
    locale: "en_US.UTF-8",
    keyboard: "us",
    admin: {
      user: "alice",
      uid: 1000,
      github: {
        login: "alice",
        id: 1000001,
        name: "Alice Example",
        email: "1000001+alice@users.noreply.github.com",
        sshKeys: [KEY],
      },
    },
    ...over,
  };
}

export function host(over: Partial<HostDef> = {}): HostDef {
  return {
    name: "alpha",
    mac: "1c:83:41:30:25:f2",
    arch: "amd64",
    disk: { match: "largest", layout: "lvm" },
    capabilities: foundation(),
    spec: "004-install",
    ...over,
  };
}
