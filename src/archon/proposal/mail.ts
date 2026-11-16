/**
 * Spec 095-proposals: reading a saved message (`.eml`, RFC 5322 with MIME)
 * for its attachments, so `stolos proposal import` takes the mail as it was
 * saved, with no mailbox access and no credential (the owner's decision 2).
 * Multipart parts nest; attachments are base64, quoted-printable, or plain;
 * a gzipped attachment (`proposal.json.gz`, what notify sends when it is
 * large) is unpacked.
 *
 * @module
 */
// Spec: 095-proposals

/** A file attached to a message. */
export interface MailFile {
  /** Its file name. */
  name: string;
  /** Its bytes, decoded (and gunzipped when its name ends in .gz, which is then dropped). */
  data: Uint8Array;
}

function headersOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last = "";
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      out[last] += " " + line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) continue;
    last = line.slice(0, i).trim().toLowerCase();
    out[last] = line.slice(i + 1).trim();
  }
  return out;
}

/** A header parameter (`boundary`, `filename`, `name`), quoted or not, RFC 2231 `*=` too. */
export function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const ext = new RegExp(`;\\s*${name}\\*=(?:[^']*'[^']*')?([^;]+)`, "i").exec(header);
  if (ext?.[1]) return decodeURIComponent(ext[1].trim().replace(/^"|"$/g, ""));
  const m = new RegExp(`;\\s*${name}=("([^"]*)"|[^;\\s]+)`, "i").exec(header);
  return m ? (m[2] ?? m[1]) : undefined;
}

function decodeQP(s: string): Uint8Array {
  const text = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...new TextEncoder().encode(c));
  }
  return new Uint8Array(out);
}

function decodeBody(body: string, encoding: string | undefined): Uint8Array {
  const e = (encoding ?? "7bit").toLowerCase();
  if (e === "base64") {
    const b = atob(body.replace(/\s+/g, ""));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  if (e === "quoted-printable") return decodeQP(body);
  return new TextEncoder().encode(body);
}

/** Gunzip bytes. */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every attachment of a saved message, in order. */
export async function attachmentsOf(eml: string): Promise<MailFile[]> {
  const out: MailFile[] = [];
  const walk = async (entity: string) => {
    const split = entity.search(/\n\n/);
    const head = headersOf(split < 0 ? entity : entity.slice(0, split));
    const body = split < 0 ? "" : entity.slice(split + 2);
    const type = head["content-type"] ?? "text/plain";
    const boundary = param(type, "boundary");
    if (/^multipart\//i.test(type) && boundary) {
      const parts = body.split(
        new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*$`, "m"),
      );
      for (const p of parts.slice(1)) {
        const part = p.replace(/^\n/, "");
        if (part.trim()) await walk(part);
      }
      return;
    }
    const name = param(head["content-disposition"], "filename") ?? param(type, "name");
    if (!name) return;
    let data = decodeBody(body, head["content-transfer-encoding"]);
    let file = name;
    if (/\.gz$/i.test(name)) {
      data = await gunzip(data);
      file = name.replace(/\.gz$/i, "");
    }
    out.push({ name: file, data });
  };
  await walk(eml.replace(/\r\n/g, "\n"));
  return out;
}
