#!/bin/bash
# End-to-end install in CI with THIS checkout of the engine (spec 004 SC-001,
# specs 046 to 049): a throwaway fleet "e2e" is made here, its tip signed with
# a fresh key that signers.ts lists, and served on the lab bridge with this
# checkout as its @stolos/, so the machines run the engine under test. The lab
# itself is lib.sh: server install to Ready, the install's trace, fleet query,
# a reboot, and a workstation that reaches the server over MCP.
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
ENGINE=$(cd "$HERE/../.." && pwd)
F="$W/fleet" FLEET=e2e SERVER=e2e WS=e2e-ws ADMIN=tester
export ARCHON_REPO="$F" ARCHON_FLEET=$FLEET
lab_init
ln -s "$ENGINE" "$W/www/stolos"
lab_network

log "fleet repository e2e, signed"
mkdir -p "$F/fleets/e2e"
cat >"$F/deno.json" <<JSON
{ "imports": { "@stolos/": "http://$BR:8000/stolos/src/" } }
JSON
printf 'import { run } from "@stolos/archon/main.ts";\n\nawait run();\n' >"$F/archon.ts"
printf 'import { run } from "@stolos/archon-boot/main.ts";\n\nawait run();\n' >"$F/boot.ts"
# Every engine module, so deno.lock pins them all (archon runs with --frozen).
printf 'import "@stolos/archon/modules.auto.ts";\n' >"$F/engine.ts"
cat >"$F/fleets/e2e/fleet.ts" <<TS
// The end-to-end test's fleet (tests/e2e/ci.sh): made for one run, thrown away.
import type { FleetDef } from "@stolos/archon/model/types.ts";

export const fleet: FleetDef = {
  id: "e2e",
  title: "End-to-end test fleet",
  repository: { slug: "e2e/fleet", url: "http://$BR:8000/fleet.git" },
  ubuntu: { release: "26.04", codename: "resolute" },
  timezone: "America/New_York",
  locale: "en_US.UTF-8",
  keyboard: "us",
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
printf "out/\n" >.gitignore
git init -q -b main
git config user.name "e2e"
git config user.email "e2e@example.invalid"
deno cache --allow-import --lock=deno.lock archon.ts boot.ts engine.ts >/dev/null
A=(deno run -A --frozen archon.ts)
"${A[@]}" signers add e2e-daily --role daily --key "$W/signer.pub"
# The admin password: a hash only (never used to log in here).
mkdir -p "$HOME/.config/archon/secrets/e2e"
openssl passwd -6 "$(openssl rand -hex 16)" >"$HOME/.config/archon/secrets/e2e/admin-password.hash"
chmod 600 "$HOME/.config/archon/secrets/e2e/admin-password.hash"
"${A[@]}" host add e2e --mac $MAC --no-deploy-key --no-push
"${A[@]}" build
cd "$ENGINE"
publish_fleet
run_lab
