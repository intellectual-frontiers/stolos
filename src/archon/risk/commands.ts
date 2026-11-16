/**
 * Spec 080: `stolos risks list | check | review` and `stolos vendors list |
 * triage`, on the controller PC, over the fleet repository and the estate
 * graph built from Git. The reading ones change nothing; `risks review` and
 * `vendors triage --write` open a pull request (a branch, one signed commit,
 * `gh pr create`), which a signer approves by merging it with a signed merge
 * commit.
 *
 * @module
 */

import { stdio, toError } from "@intellectual-frontiers/commons/ts/runtime";
import { ui } from "../core/ui.ts";
import { P } from "../core/paths.ts";
import type { FleetRisk } from "./fleet.ts";
import type { Approval, ReviewResult } from "./review.ts";

const print = (text: string): void => {
  stdio.stdout.writeSync(`${text}\n`);
};

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** The estate graph from Git, or an empty one (the register needs no connector), and adopted machines. */
async function fleetState(): Promise<FleetRisk> {
  const warn = (what: string) => (e: unknown) => {
    ui.phase("Estate").warn(`${what}: ${toError(e).message.split("\n")[0]}`);
    return undefined;
  };
  const { loadEstate } = await import("../estate/commands.ts");
  const { buildGraph } = await import("../estate/graph.ts");
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const { fleetRisk } = await import("./fleet.ts");
  const estate =
    (await loadEstate().catch(warn("the estate graph"))) ??
    buildGraph({ fleet: P.fleetId, sources: [], machines: [], links: {} });
  const adopted = (await loadAdopted().catch(warn("adopted machines"))) ?? [];
  return await fleetRisk(estate, { adopted });
}

/** `stolos risks list`: the register, highest level first. */
export async function risksList(json = false): Promise<number> {
  const { loadRisks, LEVELS } = await import("./register.ts");
  const p = ui.phase("Risks");
  let risks;
  try {
    risks = await loadRisks();
  } catch (e) {
    p.fail(`risks.ts: ${toError(e).message}`, "fix it (bun run check names the line)");
    return 1;
  }
  if (json) {
    print(JSON.stringify(risks ?? [], null, 2));
    return 0;
  }
  if (!risks) {
    p.done("no risk register yet");
    ui.next.push("write fleets/<fleet>/risks.ts (bun run stolos docs risks)");
    return 0;
  }
  const { table } = await import("../state/query.ts");
  const rank = (l: string) => -LEVELS.indexOf(l as (typeof LEVELS)[number]);
  const rows = [...risks].sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) ||
      rank(a.level) - rank(b.level) ||
      a.nextReview.localeCompare(b.nextReview),
  );
  if (rows.length) {
    print(
      table(
        rows.map((r) => ({
          risk: r.id,
          level: r.level,
          likelihood: r.likelihood,
          impact: r.impact,
          treatment: r.treatment,
          owner: r.owner,
          "next review": r.nextReview,
          status: r.status,
        })),
      ),
    );
  }
  p.done(`${risks.filter((r) => r.status === "open").length} open risk(s) of ${risks.length}`);
  return 0;
}

/** The approval of risks.ts and vendors.ts's last change: who signed the merge. */
async function approvals(): Promise<Record<string, Approval>> {
  const { loadSigners, allowedSignersText } = await import("../identity/signers.ts");
  const { approvalOf } = await import("./review.ts");
  const allowed = allowedSignersText(await loadSigners());
  const out: Record<string, Approval> = {};
  for (const f of ["risks.ts", "vendors.ts"]) {
    out[f] = await approvalOf(P.repo, `fleets/${P.fleetId}/${f}`, allowed);
  }
  return out;
}

/** `stolos risks check`: the risk-register pack's results, and who approved the files. */
export async function risksCheck(json = false): Promise<number> {
  const f = await fleetState();
  const ap = await approvals().catch((): Record<string, Approval> => ({}));
  const failing = f.run.results.some((x) => x.status === "fail");
  if (json) {
    print(JSON.stringify({ results: f.run.results, approvals: ap }, null, 2));
    return failing ? 1 : 0;
  }
  const p = ui.phase("Risks");
  const { table } = await import("../state/query.ts");
  if (f.run.results.length) {
    print(
      table(
        f.run.results.map((x) => ({
          control: x.id,
          status: x.status,
          scf: x.scf.join(" "),
          detail: x.detail,
        })),
      ),
    );
  }
  for (const x of f.run.results) {
    if (x.status === "fail") p.fail(`${x.id}: ${x.detail}`, x.fix);
    else if (x.status === "warn") p.warn(`${x.id}: ${x.detail}`, x.fix);
  }
  const a = ui.phase("Approval");
  for (const [file, x] of Object.entries(ap)) {
    if (!x.commit) continue;
    if (x.signer) a.ok(`${file}: last changed in ${x.commit.slice(0, 10)}, signed by ${x.signer}`);
    else if (x.approvedBy) {
      a.ok(
        `${file}: last changed in ${x.commit.slice(0, 10)}, approved by ${x.approvedBy.signer} in ${x.approvedBy.commit.slice(
          0,
          10,
        )}`,
      );
    } else {
      a.warn(
        `${file}: its last change (${x.commit.slice(0, 10)}) is not approved: ${x.reason}`,
        "merge reviews with a signed merge commit (git merge --no-ff -S), or approve with bun run stolos apply",
      );
    }
  }
  a.done("changes to the register are approved by a fleet signer's signed merge");
  p.done(
    `${f.run.results.filter((x) => x.status === "pass").length} pass, ${
      f.run.results.filter((x) => x.status === "fail").length
    } fail; they show in bun run stolos compliance`,
  );
  return fail();
}

/** `stolos risks review <id>`: move a risk's next review on, in a signed pull request. */
export async function risksReview(
  id: string,
  o: { next?: string; note?: string; check?: boolean } = {},
): Promise<number> {
  const { loadRisks, addDays, today, isDay } = await import("./register.ts");
  const { setNextReview, openReview } = await import("./review.ts");
  const p = ui.phase("Review");
  const risks = await loadRisks().catch((e) => {
    p.fail(`risks.ts: ${toError(e).message}`, "fix it first");
    return undefined;
  });
  const r = risks?.find((x) => x.id === id);
  if (!r) {
    if (risks) {
      p.fail(`no risk ${id}`, `one of: ${risks.map((x) => x.id).join(", ") || "none"}`);
    } else if (!ui.problems.length) p.fail("no risk register", "write fleets/<fleet>/risks.ts");
    return 1;
  }
  if (o.next && !isDay(o.next)) {
    p.fail(`${o.next} is not a day`, "--next YYYY-MM-DD");
    return 1;
  }
  const day = today();
  const next = o.next ?? addDays(day, r.reviewEveryDays ?? 90);
  const path = `fleets/${P.fleetId}/risks.ts`;
  const message = `${P.fleetId}: review risk ${id} (next review ${next})`;
  if (o.check) {
    p.done(`would set ${id}'s next review from ${r.nextReview} to ${next}, in a pull request`);
    return 0;
  }
  const res = await openReview(P.repo, {
    branch: `risks/review-${id}-${day}`,
    message,
    body: [
      `Review of risk \`${id}\`: ${r.title}`,
      "",
      `- Level: ${r.level} (likelihood ${r.likelihood}, impact ${r.impact}; NIST SP 800-30 Rev 1)`,
      `- Treatment: ${r.treatment}; owner: ${r.owner}`,
      `- Next review: ${r.nextReview} -> ${next}`,
      ...(o.note ? ["", o.note] : []),
      "",
      "Approve by merging with a signed merge commit (git merge --no-ff -S), then bun run stolos apply.",
    ].join("\n"),
    edit: async (read) => {
      const text = await read(path);
      if (text === undefined) throw new Error(`${path} is not on the main branch yet`);
      return { [path]: setNextReview(text, id, next) };
    },
  }).catch((e): ReviewResult => ({
    ok: false,
    steps: [toError(e).message],
    fix: "run this again",
  }));
  for (const s of res.steps.slice(0, -1)) p.ok(s);
  if (!res.ok) {
    p.fail(res.steps.at(-1) ?? "failed", res.fix);
    return 1;
  }
  p.done(`pull request: ${res.url ?? res.steps.at(-1)}`);
  ui.next.push("a signer reviews it and merges it with a signed merge commit");
  return 0;
}

/** `stolos vendors list`: every vendor, discovered or triaged, and what revealed it. */
export async function vendorsList(json = false): Promise<number> {
  const f = await fleetState();
  if (json) {
    print(JSON.stringify(f.vendors, null, 2));
    return f.problems.length ? 1 : 0;
  }
  const p = ui.phase("Vendors");
  for (const x of f.problems) p.fail(x);
  const { table } = await import("../state/query.ts");
  if (f.vendors.length) {
    print(
      table(
        f.vendors.map((v) => ({
          vendor: v.id,
          name: v.name,
          criticality: v.triage?.criticality ?? "not triaged",
          data: v.triage?.data.join(", ") ?? "",
          "seen through": [...new Set(v.seen.map((s) => s.kind))].join(", ") || "vendors.ts",
        })),
      ),
    );
  }
  const { needsTriage } = await import("./vendors.ts");
  const open = f.vendors.filter(needsTriage).length;
  p.done(`${f.vendors.length} vendor(s), ${open} waiting for triage`);
  if (open) ui.next.push("bun run stolos vendors triage");
  return fail();
}

/** `stolos vendors triage [--write]`: vendors not triaged yet; with --write, a pull request adding them. */
export async function vendorsTriage(o: { write?: boolean; json?: boolean } = {}): Promise<number> {
  const f = await fleetState();
  const { needsTriage } = await import("./vendors.ts");
  const open = f.vendors.filter(needsTriage);
  if (o.json) {
    print(JSON.stringify(open, null, 2));
    return 0;
  }
  const p = ui.phase("Triage");
  for (const x of f.problems) p.fail(x);
  const { table } = await import("../state/query.ts");
  if (open.length) {
    print(
      table(
        open.map((v) => ({
          vendor: v.id,
          name: v.name,
          known: v.known ? "yes" : "no",
          "seen through": v.seen
            .map((s) => s.detail)
            .slice(0, 2)
            .join("; "),
        })),
      ),
    );
  }
  const fresh = open.filter((v) => !v.triage);
  if (!o.write || !fresh.length) {
    p.done(
      open.length
        ? `${open.length} vendor(s) to triage (${fresh.length} not in vendors.ts)`
        : "every vendor is triaged",
    );
    if (fresh.length) {
      ui.next.push("bun run stolos vendors triage --write (a pull request adding them)");
    }
    return fail();
  }
  const { appendVendors, openReview } = await import("./review.ts");
  const { today } = await import("./register.ts");
  const path = `fleets/${P.fleetId}/vendors.ts`;
  const res = await openReview(P.repo, {
    branch: `vendors/triage-${today()}`,
    message: `${P.fleetId}: triage ${fresh.length} new vendor(s)`,
    body: [
      `${fresh.length} vendor(s) discovered and not yet in vendors.ts:`,
      "",
      ...fresh.map((v) => `- ${v.name} (\`${v.id}\`): ${v.seen.map((s) => s.detail).join("; ")}`),
      "",
      'For each, set its criticality (FIPS 199: low, moderate, high) and the data it holds (OCSF categories) in place of "unassessed", in this pull request.',
      "Approve by merging with a signed merge commit (git merge --no-ff -S), then bun run stolos apply.",
    ].join("\n"),
    edit: async (read) => ({ [path]: appendVendors(await read(path), fresh) }),
  }).catch((e): ReviewResult => ({
    ok: false,
    steps: [toError(e).message],
    fix: "run this again",
  }));
  for (const s of res.steps.slice(0, -1)) p.ok(s);
  if (!res.ok) {
    p.fail(res.steps.at(-1) ?? "failed", res.fix);
    return 1;
  }
  p.done(`pull request: ${res.url ?? res.steps.at(-1)}`);
  return 0;
}
