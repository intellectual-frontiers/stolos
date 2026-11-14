/**
 * SHA-512 crypt ($6$), the password hash Ubuntu's installer accepts in
 * autoinstall `identity.password` (spec 003). Pure TypeScript on WebCrypto so
 * it runs the same on the Windows boot machine. Algorithm: Ulrich Drepper,
 * "Unix crypt using SHA-256 and SHA-512" (the glibc reference).
 *
 * @module
 */

const B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-512", buf));
}

function repeatTo(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i % src.length];
  return out;
}

export function randomSalt(len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => B64[b % 64]).join("");
}

export async function sha512Crypt(
  password: string,
  salt = randomSalt(),
  rounds = 5000,
): Promise<string> {
  const enc = new TextEncoder();
  const P = enc.encode(password);
  const S = enc.encode(salt.slice(0, 16));
  const B = await sha512(P, S, P);
  const aParts: Uint8Array[] = [P, S, repeatTo(B, P.length)];
  for (let n = P.length; n > 0; n >>= 1) aParts.push(n & 1 ? B : P);
  const A = await sha512(...aParts);
  const DP = await sha512(...Array(P.length).fill(P));
  const Pbytes = repeatTo(DP, P.length);
  const DS = await sha512(...Array(16 + A[0]).fill(S));
  const Sbytes = repeatTo(DS, S.length);
  let C = A;
  for (let i = 0; i < rounds; i++) {
    const parts: Uint8Array[] = [];
    parts.push(i & 1 ? Pbytes : C);
    if (i % 3) parts.push(Sbytes);
    if (i % 7) parts.push(Pbytes);
    parts.push(i & 1 ? C : Pbytes);
    C = await sha512(...parts);
  }
  const order = [
    [0, 21, 42],
    [22, 43, 1],
    [44, 2, 23],
    [3, 24, 45],
    [25, 46, 4],
    [47, 5, 26],
    [6, 27, 48],
    [28, 49, 7],
    [50, 8, 29],
    [9, 30, 51],
    [31, 52, 10],
    [53, 11, 32],
    [12, 33, 54],
    [34, 55, 13],
    [56, 14, 35],
    [15, 36, 57],
    [37, 58, 16],
    [59, 17, 38],
    [18, 39, 60],
    [40, 61, 19],
    [62, 20, 41],
  ];
  let out = "";
  const b64 = (v: number, n: number) => {
    for (let i = 0; i < n; i++) {
      out += B64[v & 63];
      v >>= 6;
    }
  };
  for (const [a, b, c] of order) b64((C[a] << 16) | (C[b] << 8) | C[c], 4);
  b64(C[63], 2);
  const r = rounds === 5000 ? "" : `rounds=${rounds}$`;
  return `$6$${r}${salt.slice(0, 16)}$${out}`;
}
