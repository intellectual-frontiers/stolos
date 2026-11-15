/**
 * Spec 074: the workflow the engine writes into a fleet repository
 * (`.github/workflows/compliance-impact.yml`), so that every pull request
 * gets one comment naming the SCF controls its change affects, with their
 * framework requirements, and fails its check when the fleet's gate
 * (`compliance.gate` in `fleet.ts`) blocks it.
 *
 * `stolos fleet init` writes it into a new repository (with the other
 * scaffold files) and `stolos fleet upgrade` writes it again whenever the
 * text differs from the one the upgrading engine writes (as it does for the
 * bootstrap scripts), in the same signed commit as the new pin.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant PR as Pull request
 *   participant W as compliance-impact.yml
 *   participant S as stolos (the fleet's pinned engine)
 *   participant GH as GitHub API (GITHUB_TOKEN)
 *   PR->>W: opened, or pushed to
 *   W->>S: compliance catalog (SCF, pinned, SHA-256 checked)
 *   W->>S: compliance impact --base --head --markdown (each fleet)
 *   S-->>W: the comment's text; exit 1 when the gate blocks
 *   W->>GH: one comment, created once then updated
 *   W-->>PR: the check fails when the gate blocks
 * ```
 *
 * What it relies on, and nothing else: GitHub's own `GITHUB_TOKEN`, limited
 * to `contents: read` and `pull-requests: write`, given only to the step that
 * posts the comment; `actions/checkout` (without keeping its credentials)
 * and `oven-sh/setup-bun`, each pinned to a commit. The comment holds
 * control ids, host names, ports, networks, and the words of each change:
 * never a secret.
 *
 * @module
 */
import { BUN_VERSION } from "../core/bun-pin.ts";

/** Where the workflow lives in a fleet repository. */
export const IMPACT_WORKFLOW_PATH = ".github/workflows/compliance-impact.yml";

/** The actions it uses, each pinned to a commit (the tag it was, in a comment). */
export const IMPACT_ACTIONS: Record<string, { sha: string; tag: string }> = {
  "actions/checkout": { sha: "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", tag: "v5.1.0" },
  "oven-sh/setup-bun": { sha: "0c5077e51419868618aeaa5fe8019c62421857d6", tag: "v2.2.0" },
};

/** The marker that finds the workflow's own comment again, so it is updated, never repeated. */
export const IMPACT_COMMENT_MARKER = "<!-- stolos:compliance-impact -->";

/** The marker `stolos compliance impact --markdown` writes when a control is affected. */
export const IMPACT_AFFECTED_MARKER = "<!-- stolos:affected -->";

const uses = (name: string): string => {
  const a = IMPACT_ACTIONS[name];
  return a ? `${name}@${a.sha} # ${a.tag}` : name;
};

/** The workflow's text. */
export const IMPACT_WORKFLOW_TEXT = `# Written by stolos (spec 074); stolos fleet upgrade writes it again, so edits are lost.
# On each pull request: which SCF controls the change affects, with their framework
# requirements, in one comment (created, then updated); the check fails when the
# fleet's gate (compliance.gate in fleets/<fleet>/fleet.ts) blocks the change.
# Only GitHub's own token, given to the step that comments; nothing secret is posted.
name: compliance-impact

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: compliance-impact-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  impact:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: ${uses("actions/checkout")}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: ${uses("oven-sh/setup-bun")}
        with:
          bun-version: ${BUN_VERSION}
      - name: The engine (bun.lock pins it)
        run: bun install --frozen-lockfile
      - name: The SCF catalog (framework requirements; pinned, SHA-256 checked)
        continue-on-error: true
        run: bun run --silent stolos compliance catalog
      - name: The controls this change affects
        id: impact
        env:
          BASE: \${{ github.event.pull_request.base.sha }}
          HEAD: \${{ github.event.pull_request.head.sha }}
        run: |
          status=0
          : >impact.md
          for f in fleets/*/fleet.ts; do
            [ -e "$f" ] || continue
            id=$(basename "$(dirname "$f")")
            set +e
            ARCHON_FLEET="$id" bun run --silent stolos compliance impact --base "$BASE" --head "$HEAD" --markdown >>impact.md
            code=$?
            set -e
            if [ "$code" = 1 ]; then
              status=1
            elif [ "$code" != 0 ]; then
              echo "::error::stolos compliance impact did not finish for fleet $id (exit $code)"
              [ "$status" = 1 ] || status=2
            fi
          done
          cat impact.md >>"$GITHUB_STEP_SUMMARY"
          echo "status=$status" >>"$GITHUB_OUTPUT"
      - name: One comment on the pull request
        if: always() && steps.impact.outcome == 'success'
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
          REPO: \${{ github.repository }}
        run: |
          marker='${IMPACT_COMMENT_MARKER}'
          id=$(gh api --paginate "repos/$REPO/issues/$PR/comments" \\
            --jq ".[] | select(.user.login == \\"github-actions[bot]\\") | select(.body | startswith(\\"$marker\\")) | .id" | head -n 1)
          if ! grep -q '${IMPACT_AFFECTED_MARKER}' impact.md && [ -z "$id" ]; then
            echo "no control affected: no comment"
            exit 0
          fi
          printf '%s\\n\\n' "$marker" >comment.md
          cat impact.md >>comment.md
          if [ -n "$id" ]; then
            gh api -X PATCH "repos/$REPO/issues/comments/$id" -F body=@comment.md >/dev/null ||
              echo "::warning::the comment could not be updated (a pull request from a fork has a read-only token)"
          else
            gh api -X POST "repos/$REPO/issues/$PR/comments" -F body=@comment.md >/dev/null ||
              echo "::warning::the comment could not be posted (a pull request from a fork has a read-only token)"
          fi
      - name: The gate
        if: steps.impact.outputs.status != '0'
        env:
          STATUS: \${{ steps.impact.outputs.status }}
        run: |
          if [ "$STATUS" = 1 ]; then
            echo "::error::the fleet's compliance gate blocks this change: it weakens a control without an accepted risk or an approval (see the comment)"
          else
            echo "::error::the compliance impact could not be computed (see the step above)"
          fi
          exit 1
`;
