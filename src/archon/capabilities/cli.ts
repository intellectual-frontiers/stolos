// 012-cli-mcp: the `archon` launcher on every host.

import { ALLOWED_SIGNERS, ALLOWED_SIGNERS_LOCAL, allowedSignersText } from "../identity/signers.ts";
import type { Capability, FileDef } from "../model/types.ts";
import { docsFiles } from "../render/man.ts";
import { renderEmit, SHELL_DIR, SHELLS, THEME } from "../shell/emit.ts";

import { engineFile } from "../core/assets.ts";

/**
 * Spec 036: what `archon shell emit` prints, rendered for each shell, and the
 * prompt's theme, so a shell's startup reads files instead of starting Deno.
 */
export function shellFiles(): FileDef[] {
  return [
    ...SHELLS.map((s) => ({
      path: `${SHELL_DIR}/init.${s}`,
      content: renderEmit(s),
      mode: "0644",
      owner: "root",
      spec: "036-cli-comforts" as const,
    })),
    {
      path: THEME,
      content: engineFile("src/archon/shell/archon.omp.json"),
      mode: "0644",
      owner: "root",
      spec: "036-cli-comforts" as const,
    },
  ];
}

const SPEC = "012-cli-mcp" as const;

export const LAUNCHER = `#!/bin/sh
# Rendered by archon from spec ${SPEC}. Do not edit.
# Spec 036: \`archon shell emit\` runs in every new shell, so it prints the
# rendered file directly, without starting Deno (the shell: named, else the
# parent process, else $SHELL).
if [ "$1" = shell ] && [ "$2" = emit ]; then
  s="$3"
  [ -n "$s" ] || s=$(cat /proc/$PPID/comm 2>/dev/null)
  case "$s" in bash|zsh|fish) ;; *) s=$(basename "\${SHELL:-}") ;; esac
  case "$s" in bash|zsh|fish) [ -r ${SHELL_DIR}/init.$s ] && exec cat ${SHELL_DIR}/init.$s ;; esac
fi
# Spec 021: archon reports its own traces and metrics (OTLP) to the local
# OpenTelemetry Collector; silent when it is not running.
export OTEL_DENO="\${OTEL_DENO:-true}" OTEL_SERVICE_NAME="\${OTEL_SERVICE_NAME:-archon}"
export OTEL_EXPORTER_OTLP_ENDPOINT="\${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"
export OTEL_EXPORTER_OTLP_PROTOCOL="\${OTEL_EXPORTER_OTLP_PROTOCOL:-http/json}"
# Spec 049: every signal says which fleet, host, engine, and commit it is about.
_f=$(cat /etc/archon/fleet 2>/dev/null); _h=$(cat /etc/archon/host 2>/dev/null)
_v=$(sed -n 's#.*/stolos/\\(v[0-9][0-9.]*\\)/src/.*#\\1#p' /srv/archon/deno.json 2>/dev/null | head -n 1)
_r=$(git -C /srv/archon rev-parse HEAD 2>/dev/null)
export OTEL_RESOURCE_ATTRIBUTES="\${OTEL_RESOURCE_ATTRIBUTES:+\$OTEL_RESOURCE_ATTRIBUTES,}service.namespace=$_f,host.name=$_h,service.version=$_v,vcs.ref.head.revision=$_r"
# Spec 046-engine-instance: the fleet repository's entry file runs the engine it
# pins (@stolos/ in deno.json), checked against deno.lock (Article 12).
exec /usr/local/bin/deno run --allow-all --quiet --frozen --config /srv/archon/deno.json /srv/archon/archon.ts "$@"
`;

export const cli = (): Capability => ({ host, fleet }) => ({
  spec: SPEC,
  files: [
    { path: "/usr/local/bin/archon", content: LAUNCHER, mode: "0755", owner: "root", spec: SPEC },
    // Spec 047 (Article 9): the signers whose approval this server accepts, from
    // the commit it applies, plus any key a person trusted here in an emergency.
    ...(host.kind === "workstation" ? [] : [{
      path: ALLOWED_SIGNERS,
      content: allowedSignersText(fleet.signers ?? [], localSigners()),
      mode: "0644",
      owner: "root",
      spec: "047-intent-and-identity" as const,
    }]),
    // Man pages and fish completions from the registry (Article 6).
    ...docsFiles(),
    ...shellFiles(),
  ],
});

/** Keys a person trusted on this host in an emergency (archon signers trust). */
function localSigners(): string {
  try {
    return Deno.readTextFileSync(ALLOWED_SIGNERS_LOCAL);
  } catch {
    return "";
  }
}
