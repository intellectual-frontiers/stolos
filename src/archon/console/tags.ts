/**
 * Spec 108-tags FR-014: the Stolos Console's tags. A chip for each tag a machine holds (a defined tag in its own colour, a free-form
 * one always apart: a dashed outline and the word "custom"), the fleet's tags with how many machines hold each (they filter the
 * machines table), the machines grouped by a dimension, and the picker above "Ask every machine". The console holds no logic: the
 * tags are resolved by the fleet's tags (`fleet/tags.ts`), and this only draws them.
 *
 * @module
 */
// Spec: 108-tags FR-013, FR-014, FR-015
// Spec: 112-machine-reported-tags FR-011, FR-014, FR-015

import {
  type ClaimView,
  isClaimOrigin,
  isUsed,
  type ResolvedTag,
  type TaggingView,
} from "../fleet/tags.ts";
import { type Html, html } from "./html.ts";

/** Where a tag came from, in words (the chip's tooltip). */
function origin(t: Pick<ResolvedTag, "origin" | "from" | "trust">): string {
  return t.origin === "person"
    ? "given by a person"
    : t.origin === "rule"
      ? `given by the rule ${t.from ?? ""}`.trim()
      : isClaimOrigin(t.origin)
        ? `${t.origin === "reported" ? "reported" : "announced"} by the machine${t.from ? ` (${t.from})` : ""}: ${t.trust === "accept" ? "the fleet accepts it" : "a hint, never used to choose machines"}`
        : `inherited from ${t.from ?? "a group"}`;
}

/** The classes of a claim's chip: outlined, not filled (the machine says so; the fleet has not), dotted where it is only a hint. */
const claimClass = (t: Pick<ResolvedTag, "origin" | "trust">): string =>
  `${t.origin} ${t.trust === "accept" ? "used" : "hint"}`;

/** One tag as a chip: its label in its colour; a free-form tag says "custom"; one that is not defined says so. */
export function tagChip(t: ResolvedTag): Html {
  if (t.standing === "custom") {
    return isClaimOrigin(t.origin)
      ? html`<span
          class="tag custom ${claimClass(t)}"
          title="custom tag the machine says (${origin(t)}); free-form, not defined in tags.ts"
          ><span class="kind">custom</span
          ><span class="kind ${t.origin}">${t.origin}</span>${t.id}</span
        >`
      : html`<span class="tag custom" title="custom tag (free-form, not defined in tags.ts)"
          ><span class="kind">custom</span>${t.id}</span
        >`;
  }
  if (t.standing === "unknown") {
    return html`<span class="tag undefined" title="${t.id} is not defined in tags.ts"
      ><span class="kind">not defined</span>${t.id}</span
    >`;
  }
  if (isClaimOrigin(t.origin)) {
    return html`<span
      class="tag c-${t.colour ?? "grey"} ${claimClass(t)}"
      title="${t.id}: ${t.description ?? ""} (${origin(t)})"
      >${t.label}<span class="kind ${t.origin}">${t.origin}</span></span
    >`;
  }
  return html`<span
    class="tag c-${t.colour ?? "grey"}"
    title="${t.id}: ${t.description ?? ""} (${origin(t)})"
    >${t.label}${t.origin === "person" ? "" : html`<span class="kind">${t.origin}</span>`}</span
  >`;
}

/** A machine's tags as chips (nothing where it has none). */
export function tagChips(tags: readonly ResolvedTag[] | undefined): Html {
  return tags?.length ? html`<span class="tags">${tags.map(tagChip)}</span>` : html``;
}

/** The tag ids of a machine, spaced, for a row's filter (`' env:prod role:nas pilot '`). */
export const tagIds = (tags: readonly ResolvedTag[] | undefined): string =>
  ` ${(tags ?? [])
    .filter(isUsed)
    .map((t) => t.id)
    .join(" ")} `;

/** The machines grouped by one dimension: a group per value (a many-of machine is in each of its values), and one for none. */
export function groupByDimension<M extends { tags?: readonly ResolvedTag[] | undefined }>(
  machines: readonly M[],
  view: TaggingView | undefined,
  dimension: string,
): Array<{ key: string; label: string; machines: M[] }> | undefined {
  const dim = view?.dimensions.find((d) => d.id === dimension);
  if (!dim) return undefined;
  const groups = dim.tags.map((t) => ({
    key: t.id,
    label: `${dim.label}: ${t.label}`,
    machines: machines.filter((m) => m.tags?.some((x) => x.id === t.id && isUsed(x))),
  }));
  const none = machines.filter((m) => !m.tags?.some((x) => x.dimension === dimension && isUsed(x)));
  return [
    ...groups.filter((g) => g.machines.length),
    ...(none.length ? [{ key: "", label: `${dim.label}: none`, machines: [...none] }] : []),
  ];
}

/** The links that group the machines table by a dimension (and ungroup it). */
export function groupLinks(view: TaggingView | undefined, current: string): Html {
  if (!view?.dimensions.length) return html``;
  return html`<span class="row" style="gap:6px"
    ><span class="sub">Group by</span>
    <a class="btn ghost" href="/machines" ${current ? "" : html`aria-current="true"`}>None</a>
    ${view.dimensions.map(
      (d) =>
        html`<a
          class="btn ghost"
          href="/machines?group=${encodeURIComponent(d.id)}"
          ${current === d.id ? html`aria-current="true"` : ""}
          >${d.label}</a
        >`,
    )}
  </span>`;
}

/**
 * The fleet's tags with how many machines hold each, as buttons that filter the machines table (the page's `$tag` signal), the
 * free-form ones in a row of their own, marked custom.
 */
export function tagFacets(view: TaggingView | undefined): Html {
  if (!view || (!view.dimensions.length && !view.custom.length)) return html``;
  const button = (id: string, cls: string, label: Html | string, n: number) =>
    html`<button
      type="button"
      class="tag ${cls}"
      data-on:click="$tag = $tag === '${id}' ? '' : '${id}'"
      data-attr:aria-pressed="$tag === '${id}'"
      title="Show only machines with ${id}"
    >
      ${label}<span class="n">${n}</span>
    </button>`;
  return html`<div class="facets" style="margin-bottom:12px">
    ${view.dimensions.map(
      (d) =>
        html`<div class="dim">
          <b title="${d.description}">${d.label}</b>
          ${d.tags.map((t) => button(t.id, `c-${t.colour}`, t.label, t.count))}
        </div>`,
    )}
    ${
      view.custom.length
        ? html`<div class="dim">
            <b>Custom tags</b>
            ${view.custom.map((c) =>
              button(c.id, "custom", html`<span class="kind">custom</span>${c.id}`, c.count),
            )}
          </div>`
        : ""
    }
  </div>`;
}

/**
 * The tag picker above the Ask page: chips that add a tag to the expression field (`$select`), a field for the expression
 * itself, and a line that says what it chooses. The expression is read by the same typed parser the command line uses.
 */
export function tagPicker(view: TaggingView | undefined, select: string): Html {
  const add = (id: string) => `$select = $select.trim() ? $select.trim() + ' and ${id}' : '${id}'`;
  return html`<div class="stack" data-signals="{select: ${JSON.stringify(select)}}">
    <label class="field"
      ><span
        >Only machines with these tags
        <span class="sub"
          >(for example: env:prod and not role:database; empty asks every machine)</span
        ></span
      ><input
        type="text"
        name="select"
        data-bind:select
        autocomplete="off"
        class="mono"
        placeholder="env:prod and not role:database"
    /></label>
    ${
      view && (view.dimensions.length || view.custom.length)
        ? html`<div class="facets">
            ${view.dimensions.map(
              (d) =>
                html`<div class="dim">
                  <b title="${d.description}">${d.label}</b>
                  ${d.tags.map(
                    (t) =>
                      html`<button
                        type="button"
                        class="tag c-${t.colour}"
                        data-on:click="${add(t.id)}"
                        title="Add ${t.id} to the choice"
                      >
                        ${t.label}<span class="n">${t.count}</span>
                      </button>`,
                  )}
                </div>`,
            )}
            ${
              view.custom.length
                ? html`<div class="dim">
                    <b>Custom tags</b>
                    ${view.custom.map(
                      (c) =>
                        html`<button
                          type="button"
                          class="tag custom"
                          data-on:click="${add(c.id)}"
                          title="Add the custom tag ${c.id} to the choice"
                        >
                          <span class="kind">custom</span>${c.id}<span class="n">${c.count}</span>
                        </button>`,
                    )}
                  </div>`
                : ""
            }
          </div>`
        : ""
    }
  </div>`;
}

/** What a claim's status says, for a person. */
function claimWords(c: ClaimView): string {
  switch (c.status) {
    case "held":
      return c.trust === "accept"
        ? "held: this dimension accepts what machines report"
        : "held as a hint";
    case "agrees":
      return "agrees with the fleet";
    case "disagrees":
      return `disagrees: the fleet says ${c.against ?? "another value"}, and the fleet wins`;
    case "overridden":
      return `not held: ${c.against ?? "another claim"} is held instead`;
    case "undefined":
      return "not defined in this fleet's tags.ts";
    case "ignored":
      return "ignored: this dimension says fromMachine ignore";
  }
}

/** A tag id that is safe to write into a page's own expression (the tag grammar only). */
const safeId = (id: string): boolean => /^[a-z0-9][a-z0-9:._-]{0,63}$/.test(id);

/**
 * Spec 112-machine-reported-tags FR-014: the **Machines say** panel of a machine's page: what it says about itself, where it was read, what
 * the fleet did with it, and **Accept** (a form that runs `tag accept`, a command of the one registry) and **Ignore** (hides the claim for
 * the session: a signal of the page, nothing is kept). A claim that `tags.ts` does not define, or that is ignored by its dimension,
 * offers no Accept. Everything a machine said is escaped where it is drawn.
 */
export function claimsPanel(
  machine: string,
  says: readonly ClaimView[],
  disagreements: readonly string[],
  o: { gaps?: number; canAccept: boolean },
): Html {
  const shown = says.filter((c) => c.status !== "ignored");
  const ignored = says.length - shown.length;
  return html`<div class="card" id="says" style="margin-bottom:14px" data-signals="{hide: ''}">
    <h2>Machines say</h2>
    <p class="sub">
      What ${machine} says about itself (its /etc/machine-info, its firmware, its own tags). The
      fleet's tags win: a claim never changes them until you accept it.
    </p>
    ${
      disagreements.length
        ? html`<div class="help" id="says-disagree" style="margin-bottom:10px">
            <h3>It disagrees with the fleet</h3>
            <ul>
              ${disagreements.map((d) => html`<li>${d}</li>`)}
            </ul>
          </div>`
        : ""
    }
    ${
      shown.length
        ? html`<table>
            <tbody>
              ${shown.map((c) => {
                const ok = safeId(c.id);
                const can =
                  o.canAccept && ok && ["held", "disagrees", "overridden"].includes(c.status);
                return html`<tr
                  class="claim"
                  data-claim="${c.id}"
                  ${ok ? html`data-show="!$hide.includes(' ${c.id} ')"` : ""}
                >
                  <td>
                    <span
                      class="tag ${[c.id.includes(":") ? "" : "custom", claimClass(c)].filter(Boolean).join(" ")}"
                      ><span class="kind ${c.origin}">${c.origin}</span>${c.id}</span
                    >
                  </td>
                  <td class="sub">${c.source}</td>
                  <td class="sub">${claimWords(c)}</td>
                  <td>
                    ${
                      can
                        ? html`<form
                            style="display:inline"
                            data-on:submit="@post('/actions/run', {contentType: 'form'})"
                          >
                            <input type="hidden" name="command" value="tag accept" />
                            <input type="hidden" name="machine" value="${machine}" />
                            <input type="hidden" name="tags" value="${c.id}" />
                            <button
                              class="btn"
                              type="submit"
                              title="Make it a tag a person gave: one signed commit"
                            >
                              Accept
                            </button>
                          </form>`
                        : ""
                    }
                    ${
                      ok
                        ? html`<button
                            class="btn ghost"
                            type="button"
                            data-on:click="$hide = $hide + ' ${c.id} '"
                            title="Hide it for this visit; nothing is kept"
                          >
                            Ignore
                          </button>`
                        : ""
                    }
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>`
        : html`<p class="sub">It has said nothing yet.</p>`
    }
    ${ignored ? html`<p class="sub">${ignored} claim(s) ignored by the fleet's dimensions.</p>` : ""}
    ${o.gaps ? html`<p class="sub">Gap: ${o.gaps} thing(s) it said were not tags and were dropped.</p>` : ""}
    <div class="row spread" style="margin-top:8px">
      <span class="sub" id="runstate">Nothing running</span>
    </div>
    <div class="term" id="output" aria-live="polite"></div>
  </div>`;
}
