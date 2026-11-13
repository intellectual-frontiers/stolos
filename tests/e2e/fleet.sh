#!/bin/bash
# End-to-end install of a fleet repository's synthetic fleet, with the engine
# its deno.json pins (checked against its deno.lock): the same lab as the
# engine's own e2e (lib.sh). Usage:
#
#   fleet.sh <fleet-repository> <fleet-id> <server> [<workstation>]
#
# The fleet must be made for the lab: its repository URL is
# http://10.77.0.1:8000/fleet.git, its server's host.ts has mac
# 52:54:00:12:34:56, and its fleet.ts holds its admin's key as
#   const E2E_ADMIN_KEY = "ssh-ed25519 ...";
# which this run replaces with its own (the private half never exists
# anywhere else). This run also adds its own signer, the admin password's
# hash, and the server's host keys (archon host add), all thrown away after.
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
SRC=$(cd "$1" && pwd)
FLEET=$2 SERVER=$3 WS=${4:-}
F="$W/fleet"
export ARCHON_REPO="$F" ARCHON_FLEET=$FLEET
lab_init
lab_network

log "fleet repository $(basename "$SRC"), fleet $FLEET, signed for this run"
git clone -q "$SRC" "$F"
cd "$F"
git config user.name "e2e"
git config user.email "e2e@example.invalid"
# The pinned engine, exactly as hosts get it: every file checked against deno.lock.
deno cache --frozen --allow-import archon.ts boot.ts engine.ts >/dev/null ||
  { log "the engine does not match deno.lock"; exit 1; }
FT="fleets/$FLEET/fleet.ts"
grep -q '^const E2E_ADMIN_KEY = ".*";$' "$FT" || { log "$FT has no E2E_ADMIN_KEY line"; exit 1; }
sed -i "s|^const E2E_ADMIN_KEY = \".*\";\$|const E2E_ADMIN_KEY = \"$(cut -d' ' -f1,2 "$W/admin.pub")\";|" "$FT"
ADMIN=$(grep -oE 'user: "[a-z_][a-z0-9_-]*"' "$FT" | head -n 1 | cut -d'"' -f2)
A=(deno run -A --frozen archon.ts --fleet "$FLEET")
"${A[@]}" signers add e2e-run --role daily --key "$W/signer.pub"
mkdir -p "$HOME/.config/archon/secrets/$FLEET"
openssl passwd -6 "$(openssl rand -hex 16)" >"$HOME/.config/archon/secrets/$FLEET/admin-password.hash"
chmod 600 "$HOME/.config/archon/secrets/$FLEET/admin-password.hash"
"${A[@]}" host add "$SERVER" --mac $MAC --no-deploy-key --no-push
"${A[@]}" build
cd "$HERE"
publish_fleet
run_lab
