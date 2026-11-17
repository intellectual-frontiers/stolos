/**
 * Spec 108-tags FR-014: the Stolos Console's tags. A chip for each tag a machine holds (a defined tag in its own colour, a free-form
 * one always apart: a dashed outline and the word "custom"), the fleet's tags with how many machines hold each (they filter the
 * machines table), the machines grouped by a dimension, and the picker above "Ask every machine". The console holds no logic: the
 * tags are resolved by the fleet's tags (`fleet/tags.ts`), and this only draws them.
 *
 * @module
 */
// Spec: 108-tags FR-013, FR-014, FR-015

import type { ResolvedTag, TaggingView } from "../fleet/tags.ts";
import { type Html, html } from "./html.ts";

/** Where a tag came from, in words (the chip's tooltip). */
function origin(t: Pick<ResolvedTag, "origin" | "from">): string {
  return t.origin === "person"
    ? "given by a person"
    : t.origin === "rule"
      ? `given by the rule ${t.from ?? ""}`.trim()
      : `inherited from ${t.from ?? "a group"}`;
}

/** One tag as a chip: its label in its colour; a free-form tag says "custom"; one that is not defined says so. */
export function tagChip(t: ResolvedTag): Html {
  if (t.standing === "custom") {
    return html`<span class="tag custom" title="custom tag (free-form, not defined in tags.ts)"
      ><span class="kind">custom</span>${t.id}</span
    >`;
  }
  if (t.standing === "unknown") {
    return html`<span class="tag undefined" title="${t.id} is not defined in tags.ts"
      ><span class="kind">not defined</span>${t.id}</span
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
  ` ${(tags ?? []).map((t) => t.id).join(" ")} `;

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
    machines: machines.filter((m) => m.tags?.some((x) => x.id === t.id)),
  }));
  const none = machines.filter((m) => !m.tags?.some((x) => x.dimension === dimension));
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
