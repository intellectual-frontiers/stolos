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
# (deno fmt may wrap it) which this run replaces with its own (the private half never exists
# anywhere else). This run also adds its own signer, the admin password's
# hash, and the server's host keys (stolos host add), all thrown away after.
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
SRC=$(cd "$1" && pwd)
FLEET=$2 SERVER=$3 WS=${4:-}
F="$W/fleet"
export ARCHON_REPO="$F" ARCHON_FLEET=$FLEET
lab_init
# E2E_PREPARE_ONLY=1: everything up to the machines (no root, no KVM), to try
# a fleet repository's synthetic fleet on any Linux machine.
[ -n "${E2E_PREPARE_ONLY:-}" ] || lab_network

log "fleet repository $(basename "$SRC"), fleet $FLEET, signed for this run"
# The repository's files at its HEAD, as a new repository: the lab needs no
# history, and a CI checkout is shallow, which git's plain HTTP transport (how
# the lab serves it) cannot serve.
mkdir -p "$F"
git -C "$SRC" archive HEAD | tar -x -C "$F"
cd "$F"
git init -q -b main
git config user.name "e2e"
git config user.email "e2e@example.invalid"
# The pinned engine, exactly as hosts get it: every file checked against deno.lock.
deno cache --frozen --allow-import archon.ts stolos.ts engine.ts >/dev/null ||
  { log "the engine does not match deno.lock"; exit 1; }
FT="fleets/$FLEET/fleet.ts"
# Its value, however deno fmt wrapped the line.
grep -Pzoq 'const E2E_ADMIN_KEY =\s*"[^"]*";' "$FT" || { log "$FT has no const E2E_ADMIN_KEY = \"...\";"; exit 1; }
KEY="$(cut -d' ' -f1,2 "$W/admin.pub")" perl -0pi -e 's/(const E2E_ADMIN_KEY =\s*)"[^"]*";/$1"$ENV{KEY}";/' "$FT"
grep -q "$(cut -d' ' -f2 "$W/admin.pub")" "$FT" || { log "could not set E2E_ADMIN_KEY in $FT"; exit 1; }
ADMIN=$(grep -oE 'user: "[a-z_][a-z0-9_-]*"' "$FT" | head -n 1 | cut -d'"' -f2)
A=(deno run -A --frozen stolos.ts --fleet "$FLEET")
"${A[@]}" signers add e2e-run --role daily --key "$W/signer.pub"
mkdir -p "$HOME/.config/stolos/secrets/$FLEET"
openssl passwd -6 "$(openssl rand -hex 16)" >"$HOME/.config/stolos/secrets/$FLEET/admin-password.hash"
chmod 600 "$HOME/.config/stolos/secrets/$FLEET/admin-password.hash"
# Spec 051: recognized by its network card (the lab VM's).
"${A[@]}" host add "$SERVER" --mac-address $MAC --no-deploy-key --no-push
"${A[@]}" build
cd "$HERE"
publish_fleet
if [ -n "${E2E_PREPARE_ONLY:-}" ]; then log "prepared (E2E_PREPARE_ONLY): $W/www/fleet.git"; exit 0; fi
run_lab
