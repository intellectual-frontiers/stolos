#!/bin/bash
# End-to-end install in CI with THIS checkout of the engine (spec 004 SC-001,
# specs 046 to 049): a throwaway fleet "e2e" is made here, its tip signed with
# a fresh key that signers.ts lists, and served on the lab bridge with this
# checkout, as a Git repository, as its engine (package.json), so the machines run
# the engine under test (spec 096). The lab
# itself is lib.sh: server install to Ready, the install's trace, fleet query,
# a reboot, and a workstation that reaches the server over MCP.
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
ENGINE=$(cd "$HERE/../.." && pwd)
F="$W/fleet" FLEET=e2e SERVER=e2e WS=e2e-ws ADMIN=tester
# Spec 051: a network install first meets a disk that is not blank (E2E_GUARD_TEST=).
export E2E_GUARD_TEST=${E2E_GUARD_TEST-1}
export ARCHON_REPO="$F" ARCHON_FLEET=$FLEET
lab_init
ln -s "$ENGINE" "$W/www/stolos"
lab_network

log "fleet repository e2e, signed"
mkdir -p "$F/fleets/e2e"
# The engine under test, as a fleet depends on it (by Git, spec 096 FR-005): this checkout's files
# at its HEAD as a one-commit repository, served beside the fleet over Git's plain HTTP (a CI
# checkout is shallow, which that transport cannot serve); bun.lock pins its commit.
rm -rf "$W/engine-src" "$W/www/stolos.git"
mkdir -p "$W/engine-src"
git -C "$ENGINE" archive HEAD | tar -x -C "$W/engine-src"
git -C "$W/engine-src" init -q -b main
git -C "$W/engine-src" add -A
git -C "$W/engine-src" -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m "the engine under test"
git clone -q --bare "$W/engine-src" "$W/www/stolos.git"
git -C "$W/www/stolos.git" update-server-info
ENGINE_COMMIT=$(git -C "$W/engine-src" rev-parse HEAD)
cat >"$F/package.json" <<JSON
{
  "name": "fleet",
  "private": true,
  "type": "module",
  "scripts": { "stolos": "bun stolos.ts", "archon": "bun archon.ts" },
  "dependencies": {
    "@intellectual-frontiers/stolos": "git+http://$BR:8000/stolos.git#$ENGINE_COMMIT"
  }
}
JSON
printf 'import { run } from "@intellectual-frontiers/stolos/archon/main";\n\nawait run();\n' >"$F/archon.ts"
printf 'import { run } from "@intellectual-frontiers/stolos/stolos/main";\n\nawait run();\n' >"$F/stolos.ts"
cat >"$F/fleets/e2e/fleet.ts" <<TS
/**
 * The end-to-end test's fleet (tests/e2e/ci.sh): made for one run, thrown away.
 *
 * @module
 */
import type { FleetDef } from "@intellectual-frontiers/stolos/archon/model/types";

export const fleet: FleetDef = {
  id: "e2e",
  title: "End-to-end test fleet",
  repository: { slug: "e2e/fleet", url: "http://$BR:8000/fleet.git" },
  ubuntu: { release: "26.04", codename: "resolute" },
  timezone: "America/New_York",
  locale: "en_US.UTF-8",
  keyboard: "us",
  // As a real fleet: Cloudflare for DNS and mail, Let's Encrypt (its staging
  // service here), with documentation domains and no tokens.
  providers: { dns: "cloudflare", mail: "cloudflare", acme: "letsencrypt-staging" },
  mail: { to: "fleet@example.net", domain: "example.net", tag: "e2e" },
  web: { domain: "e2e.example.net" },
  network: { ipv6: false },
  admin: {
    user: "$ADMIN",
    uid: 1000,
    github: {
      login: "tester",
      id: 1,
      name: "End-to-end tester",
      email: "1+tester@users.noreply.github.com",
      sshKeys: ["$(cut -d' ' -f1,2 "$W/admin.pub")"],
    },
  },
};
TS
cd "$F"
printf "out/\nnode_modules/\n" >.gitignore
git init -q -b main
git config user.name "e2e"
git config user.email "e2e@example.invalid"
bun install >/dev/null
# Spec 059: the fleet's commands are stolos (as on your PC); machines run archon.
A=(bun stolos.ts)
"${A[@]}" signers add e2e-daily --role daily --key "$W/signer.pub"
# The admin password: a hash only (never used to log in here).
mkdir -p "$HOME/.config/stolos/secrets/e2e"
openssl passwd -6 "$(openssl rand -hex 16)" >"$HOME/.config/stolos/secrets/e2e/admin-password.hash"
chmod 600 "$HOME/.config/stolos/secrets/e2e/admin-password.hash"
# Spec 051: recognized by claim (the next unknown machine to network-boot).
"${A[@]}" host add e2e --claim --no-deploy-key --no-push
"${A[@]}" build
cd "$ENGINE"
publish_fleet
run_lab
