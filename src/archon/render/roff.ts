/**
 * Native roff generation (no dependencies): man(7) macros, written directly.
 *
 * @module
 */

/** Escapes text for roff: backslashes, hyphens, and a leading . or ' on any line. */
export function esc(text: string): string {
  return text
    .replace(/\\/g, "\\e")
    .replace(/-/g, "\\-")
    .replace(/^([.'])/gm, "\\&$1");
}

/** Inline markdown: `code` -> bold, *em* and _em_ -> italic, **strong** -> bold. */
export function inline(text: string): string {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, "\\fB$1\\fR");
  s = s.replace(/\*\*([^*]+)\*\*/g, "\\fB$1\\fR");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1\\fI$2\\fR");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 <$2>");
  return s;
}

/** The man page title line (.TH): name (upper-cased), section, date, source, and manual. */
export function th(
  name: string,
  section: number | string,
  date: string,
  source = "Archon",
  manual = "Archon Manual",
): string {
  return `.TH "${name.toUpperCase()}" "${section}" "${date}" "${source}" "${manual}"\n`;
}

/** Convert a small, well-behaved subset of Markdown into man(7) roff. */
export function markdownToRoff(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let inCode = false;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push(".PP", inline(para.join(" ")));
      para = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flush();
      out.push(inCode ? ".fi\n.RE" : ".RS 4\n.nf");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line) || "\\&");
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      out.push(h[1].length <= 2 ? `.SH "${esc(h[2]).toUpperCase()}"` : `.SS "${esc(h[2])}"`);
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      out.push(".IP \\(bu 2", inline(li[1]));
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      out.push(".RS 4", inline(line.replace(/^>\s?/, "")), ".RE");
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
      out.push(
        ".IP \\(bu 2",
        inline(line.split("|").map((c) => c.trim()).filter(Boolean).join(": ")),
      );
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join("\n") + "\n";
}
