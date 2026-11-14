/**
 * Ubuntu autoinstall config for one host (spec 004) and the first-boot step
 * inside it (spec 005). Rendered from the model; the two secrets (admin
 * password hash, deploy key) are passed in only by archon-boot at request
 * time and never reach out/ or git (Article 13). JSON is valid YAML, so the
 * config is written as JSON after the #cloud-config marker.
 *
 * @module
 */

import { allowedSignersText } from "../identity/signers.ts";
import type { DiskDef, FleetDef, HostDef } from "../model/types.ts";

const DEFAULT_DISK: DiskDef = { match: "largest", layout: "lvm" };

/** What an install hands the machine that must not be in Git. */
export interface InstallSecrets {
  /** The admin password's hash. */
  passwordHash: string;
  /** Its read-only deploy key. */
  deployKey?: string;
  /** The host's SSH host keys, kept on the boot machine: its identity across re-installs. */
  hostKeys?: Array<{ type: string; private: string; public: string }>;
  /** The mail relay's credential JSON (spec 027). */
  mailCredential?: string;
  /** The Cloudflare DNS token (spec 032). */
  webCredential?: string;
  /** Traefik's ACME store carried from the previous install (spec 032). */
  acme?: string;
}

/** Everything the install config is made from. */
export interface InstallContext {
  /** The fleet. */
  fleet: FleetDef;
  /** The host. */
  host: HostDef;
  /** Base URL of this host's install directory on archon-boot (ends with /). */
  base: string;
  /** Lab or site proxy for the installer and first boot (optional). */
  proxy?: string;
  /** Extra CA certificate (PEM) the site's proxy needs (optional). */
  caPem?: string;
  /** GitHub Enterprise or a releases mirror for tool lookups (optional, spec 010). */
  githubApi?: string;
  /** The MAC of the NIC the machine network-booted from, as GRUB reported it. */
  bootMac?: string;
  /** Spec 049: the boot server's install trace, which the first boot continues. */
  traceparent?: string;
}

/**
 * Spec 049: the first boot reports its spans to the boot server (the one
 * collector sure to be there), in the install's trace: /etc/archon/first-boot.env.
 */
export function firstBootTelemetry(
  c: Pick<InstallContext, "base" | "traceparent" | "fleet" | "host">,
): string {
  const origin = new URL(c.base).origin;
  return [
    "# Written by archon-boot (spec 049): the first boot's telemetry, to the boot server.",
    "OTEL_DENO=true",
    "OTEL_SERVICE_NAME=archon",
    "OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
    `OTEL_EXPORTER_OTLP_ENDPOINT=${origin}/otlp`,
    `OTEL_RESOURCE_ATTRIBUTES=service.namespace=${c.fleet.id},host.name=${c.host.name}`,
    ...(c.traceparent ? [`TRACEPARENT=${c.traceparent}`] : []),
  ].join("\n") + "\n";
}

/** GitHub's published SSH host keys (https://api.github.com/meta), for the first clone. */
export const GITHUB_KNOWN_HOSTS: string = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
].join("\n") + "\n";

/** The first-boot script (spec 005). Shell only because Deno is not there yet; it hands over at once. */
export function firstBootScript(fleet: FleetDef, host: HostDef): string {
  const branch = fleet.repository.branch ?? "main";
  return `#!/bin/sh
# Archon first boot (spec 005), rendered by archon. Installs Deno (upstream
# binary, checksum verified, Article 12), clones ${fleet.repository.slug} with this
# host's deploy key, then hands over to \`archon first-boot\`.
set -eu
exec >>/var/log/archon-first-boot.log 2>&1
echo "== archon first boot $(date -Is)"
# Progress to the boot server's window (spec 004); never fatal.
[ -f /etc/archon/boot-events ] && curl -fsS --noproxy "*" -m 5 -X POST -H 'content-type: application/json' \
  -d '{"origin":"archon","phase":"First boot","summary":"installing Deno, cloning the repository"}' \
  "$(cat /etc/archon/boot-events)" >/dev/null 2>&1 || true
export DEBIAN_FRONTEND=noninteractive
[ -f /etc/archon/proxy.env ] && . /etc/archon/proxy.env
if ! command -v deno >/dev/null 2>&1; then
  # Deno ships as a zip; unzip comes from Ubuntu (installed here, not by the
  # installer, so a slow mirror can never fail the install itself).
  command -v unzip >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q unzip; }
  V=$(curl -fsSL https://dl.deno.land/release-latest.txt)
  B="https://github.com/denoland/deno/releases/download/$V/deno-x86_64-unknown-linux-gnu.zip"
  T=$(mktemp -d)
  curl -fsSL -o "$T/deno.zip" "$B"
  curl -fsSL -o "$T/deno.zip.sha256sum" "$B.sha256sum"
  [ "$(sha256sum "$T/deno.zip" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$T/deno.zip.sha256sum" | tr A-F a-f)" ]
  D="/opt/tools/deno/\${V#v}/bin"
  mkdir -p "$D"
  unzip -q -o "$T/deno.zip" -d "$D"
  ln -sfn "$D/deno" /usr/local/bin/deno
  rm -rf "$T"
fi
# The deploy key, for these two git commands only (archon sets up its own later).
DEPLOY_SSH="ssh -i /etc/archon/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/archon/github_known_hosts"
if [ ! -d /srv/archon/.git ]; then
  if ${onGitHub(fleet) ? "false" : "true"}; then
    # Spec 046: a fleet repository that is not on GitHub (the end-to-end lab
    # serves one over HTTP): cloned from its URL.
    git clone -q -b ${branch} ${fleet.repository.url} /srv/archon
  elif [ -f /etc/archon/deploy_key ]; then
    GIT_SSH_COMMAND="$DEPLOY_SSH" git clone -q -b ${branch} git@github.com:${fleet.repository.slug}.git /srv/archon
  else
    # No deploy key (a public repository, or a site proxy that authenticates).
    git clone -q -b ${branch} https://github.com/${fleet.repository.slug}.git /srv/archon
  fi
else
  # Spec 063: run again (after a refusal): the branch as it is now, not the commit refused before.
  if [ -f /etc/archon/deploy_key ]; then export GIT_SSH_COMMAND="$DEPLOY_SSH"; fi
  git -C /srv/archon fetch -q origin ${branch} && git -C /srv/archon reset -q --hard FETCH_HEAD
  unset GIT_SSH_COMMAND
fi
# Spec 047 (Article 9): run nothing from the repository unless its tip is
# signed by one of the fleet's signers, as listed when this host was installed.
if ! git -C /srv/archon -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile=/etc/archon/allowed_signers \\
  verify-commit HEAD >/dev/null 2>&1; then
  [ -f /etc/archon/boot-events ] && curl -fsS --noproxy "*" -m 5 -X POST -H 'content-type: application/json' \\
    -d '{"origin":"archon","phase":"First boot","level":"fail","summary":"the repository tip is not signed by a fleet signer: nothing was run. Fix: on your PC, deno task stolos apply (a commit signed by your key on top); then on this host: sudo /usr/local/sbin/archon-first-boot"}' \\
    "$(cat /etc/archon/boot-events)" >/dev/null 2>&1 || true
  echo "archon: /srv/archon HEAD is not signed by a fleet signer; refusing to run it" >&2
  echo "archon: fix: on your PC, deno task stolos apply (a commit signed by your key on top);" >&2
  echo "archon:      then here: sudo /usr/local/sbin/archon-first-boot (it fetches the branch again)" >&2
  exit 1
fi
# Spec 049: the first boot continues the install's trace, reported to the boot server.
if [ -f /etc/archon/first-boot.env ]; then set -a; . /etc/archon/first-boot.env; set +a; fi
exec /usr/local/bin/deno run -A --quiet --frozen --config /srv/archon/deno.json /srv/archon/archon.ts first-boot --host ${host.name}
`;
}

/** Hosts the first boot reaches directly, bypassing the site proxy. */
function noProxy(c: InstallContext): string {
  const hosts = ["localhost", "127.0.0.1", new URL(c.base).hostname];
  if (c.githubApi) hosts.push(new URL(c.githubApi).hostname);
  return [...new Set(hosts)].join(",");
}

/** The autoinstall user-data: Ubuntu's installer config, the blank-disk guard first, then the first boot. */
export function userData(c: InstallContext, s: InstallSecrets): string {
  const { fleet, host } = c;
  const a = fleet.admin;
  const files: Array<Record<string, string>> = [
    { path: "/etc/archon/host", content: `${host.name}\n`, permissions: "0644" },
    // Spec 046-engine-instance: which fleet of the repository this host belongs to.
    { path: "/etc/archon/fleet", content: `${fleet.id}\n`, permissions: "0644" },
    { path: "/etc/archon/first-boot.env", content: firstBootTelemetry(c), permissions: "0644" },
    // Spec 047: the signers this host trusts from its first boot on.
    {
      path: "/etc/archon/allowed_signers",
      content: allowedSignersText(fleet.signers ?? []),
      permissions: "0644",
    },
    { path: "/etc/archon/github_known_hosts", content: GITHUB_KNOWN_HOSTS, permissions: "0644" },
    {
      path: "/usr/local/sbin/archon-first-boot",
      content: firstBootScript(fleet, host),
      permissions: "0755",
    },
  ];
  if (s.deployKey) {
    files.push({
      path: "/etc/archon/deploy_key",
      content: s.deployKey.trim() + "\n",
      permissions: "0600",
    });
  }
  if (s.acme) {
    // First boot puts it in Traefik's state directory before Traefik first starts, and deletes this copy.
    files.push({ path: "/etc/archon/acme.json", content: s.acme, permissions: "0600" });
  }
  if (s.webCredential) {
    // First boot stores it root-only for archon web dns and Traefik (spec 032) and deletes this copy.
    files.push({
      path: "/etc/archon/web_credential.json",
      content: s.webCredential.trim() + "\n",
      permissions: "0600",
    });
  }
  if (s.mailCredential) {
    // First boot installs it as Postfix's sasl_passwd (root only, spec 027) and deletes this copy.
    files.push({
      path: "/etc/archon/mail_credential.json",
      content: s.mailCredential.trim() + "\n",
      permissions: "0600",
    });
  }
  // Install and first-boot progress go to the boot server's window (spec 004).
  files.push({ path: "/etc/archon/boot-events", content: `${c.base}event\n`, permissions: "0644" });
  // Site settings the first boot needs: a proxy, a GitHub API mirror.
  const site: string[] = [];
  if (c.proxy) {
    site.push(
      `export http_proxy=${c.proxy} https_proxy=${c.proxy} HTTP_PROXY=${c.proxy} HTTPS_PROXY=${c.proxy}`,
      // archon-boot and a GitHub API mirror are on the LAN: never through the proxy.
      `export no_proxy=${noProxy(c)} NO_PROXY=${noProxy(c)}`,
    );
  }
  if (c.githubApi) site.push(`export ARCHON_GITHUB_API=${c.githubApi}`);
  // Deno trusts the site CA only through the system store (cloud-init adds it there).
  if (c.caPem) site.push("export DENO_TLS_CA_STORE=system");
  if (site.length) {
    files.push({
      path: "/etc/archon/proxy.env",
      content: site.join("\n") + "\n",
      permissions: "0644",
    });
  }
  const cloudInit: Record<string, unknown> = {
    write_files: files,
    runcmd: [["/usr/local/sbin/archon-first-boot"]],
    ...(c.caPem ? { ca_certs: { trusted: [c.caPem] } } : {}),
    // The host's own SSH host keys (cloud-init cc_ssh): the same identity after every install.
    // All three of Ubuntu's types are given, so cloud-init generates none of its own
    // (the installer's schema rejects an empty ssh_genkeytypes).
    ...(s.hostKeys?.length
      ? {
        ssh_deletekeys: true,
        ssh_keys: Object.fromEntries(
          s.hostKeys.flatMap((
            k,
          ) => [[`${k.type}_private`, k.private], [`${k.type}_public`, k.public]]),
        ),
      }
      : {}),
  };
  // Spec 051: first, before anything touches a disk, the blank-disk guard: the
  // machine reports its facts and the boot server answers (no answer, no install).
  const early: string[] = [
    `curl -fsS --noproxy "*" -m 30 -o /tmp/archon-guard.sh ${c.base}guard.sh && sh /tmp/archon-guard.sh ${c.base} || { echo "archon: the blank-disk guard could not run: nothing was erased" | tee /dev/console; sleep 30; poweroff -f; }`,
  ];
  if (c.caPem) {
    // A site proxy that intercepts TLS: trust its CA inside the installer too.
    // Downloaded from archon-boot (a PEM bundle is too long for a command line).
    const site = c.base.replace(/install\/.*$/, "site-ca.crt");
    early.push(
      `curl -fsS --noproxy "*" -o /usr/local/share/ca-certificates/archon-site.crt ${site} && update-ca-certificates`,
    );
  }
  const mac = host.mac ?? c.bootMac;
  const config = {
    autoinstall: {
      version: 1,
      ...(early.length ? { "early-commands": early } : {}),
      locale: fleet.locale,
      keyboard: { layout: fleet.keyboard },
      timezone: fleet.timezone,
      ...(c.proxy ? { proxy: c.proxy } : {}),
      // Behind a proxy, use Ubuntu's HTTPS mirrors (many proxies tunnel HTTPS only).
      ...(c.proxy
        ? {
          apt: {
            primary: [{ arches: ["default"], uri: "https://archive.ubuntu.com/ubuntu" }],
            security: [{ arches: ["default"], uri: "https://security.ubuntu.com/ubuntu" }],
          },
        }
        : {}),
      network: {
        version: 2,
        ethernets: {
          // The NIC the machine booted from (the model's MAC, else the one
          // GRUB reported); with neither, every wired port (Ubuntu's names en*).
          uplink: {
            match: mac ? { macaddress: mac } : { name: "en*" },
            dhcp4: true,
            dhcp6: true,
          },
        },
      },
      identity: {
        hostname: host.name,
        username: a.user,
        realname: a.github.name,
        password: s.passwordHash,
      },
      ssh: { "install-server": true, "allow-pw": false, "authorized-keys": a.github.sshKeys },
      storage: {
        layout: {
          name: (host.disk ?? DEFAULT_DISK).layout,
          match: (host.disk ?? DEFAULT_DISK).match === "largest"
            ? { size: "largest" }
            : { path: (host.disk ?? DEFAULT_DISK).match },
        },
      },
      updates: "security",
      shutdown: "reboot",
      // Each installer step is reported to the boot server's window (spec 004).
      reporting: { archon: { type: "webhook", endpoint: `${c.base}event` } },
      "late-commands": [
        // Remember the firmware entry this machine network-booted from, so a later
        // re-install can ask for one network boot (archon reboot --netboot) without F7.
        "mkdir -p /target/etc/archon && (efibootmgr 2>/dev/null | sed -n 's/^BootCurrent: //p' > /target/etc/archon/netboot-entry) || true",
        // Tell archon-boot the install finished, so this host is not reinstalled on its next network boot.
        `curl -fsS --noproxy "*" -X POST ${c.base}done || true`,
      ],
      "user-data": cloudInit,
    },
  };
  return "#cloud-config\n" + JSON.stringify(config, null, 2) + "\n";
}

/** The cloud-init meta-data. */
export function metaData(host: HostDef): string {
  return `instance-id: archon-${host.name}\nlocal-hostname: ${host.name}\n`;
}

/** Whether the fleet repository is on GitHub (else it is cloned from its URL). */
export function onGitHub(fleet: FleetDef): boolean {
  return /^https:\/\/github\.com\//.test(fleet.repository.url);
}
