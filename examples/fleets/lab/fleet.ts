/**
 * The example lab fleet (spec 001-engine-instance): neutral data that CI and
 * the end-to-end lab install from. A real fleet lives in its own repository,
 * under fleets/<id>/, written by `stolos fleet init`.
 *
 * @module
 */

import type { FleetDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { site } from "./site.ts";

export const fleet: FleetDef = {
  id: "lab",
  title: "Example lab fleet",
  repository: {
    slug: "example/fleet",
    url: "https://github.com/example/fleet",
  },
  ubuntu: {
    release: "26.04",
    codename: "resolute",
  },
  timezone: "America/New_York",
  locale: "en_US.UTF-8",
  keyboard: "us",
  // Specs 025 and 027: mail leaves through Cloudflare Email Service, from
  // <user>+<host>.lab@example.net (only example.net onboarded for Email Sending),
  // to the shared Lab mailbox.
  mail: {
    to: "fleet@example.net",
    domain: "example.net",
    tag: "lab",
  },
  // Spec 032: every server answers HTTPS as <host>.lab.example.net (apps at
  // <app>.<host>.lab.example.net), with a Let's Encrypt certificate through
  // Cloudflare's DNS challenge, and keeps its own records in the example.net zone.
  web: {
    domain: "lab.example.net",
  },
  // Spec 028: the site's networks, firewall, DNS, and Wi-Fi (src/archon/site.ts).
  // A host's IPv6 follows its network there.
  site: site,
  // Spec 009: the fallback for hosts not on a site network (workstations).
  network: {
    ipv6: false,
  },
  admin: {
    user: "alice",
    uid: 1000,
    github: {
      login: "alice",
      id: 1000001,
      name: "Alice Example",
      email: "1000001+alice@users.noreply.github.com",
      sshKeys: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGUtbGFiLWtleS1ub3QtYS1yZWFsLWtleS0wMQ",
      ],
    },
  },
};
