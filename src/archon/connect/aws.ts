/**
 * Spec 067 (clouds): AWS, read-only, with an access key whose user (or role)
 * has the managed SecurityAudit policy: the account, IAM users, S3 buckets,
 * EC2 instances in every enabled region, and the root account's MFA and keys.
 * Requests are signed with Signature Version 4, in TypeScript (no AWS CLI).
 *
 * @module
 */

import {
  AccessDenied,
  type Asset,
  check,
  type Connector,
  fresh,
  type Http,
  orGap,
} from "./connector.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}
/** RFC 3986 encoding, as SigV4 wants it. */
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** A request to sign. */
export interface AwsRequest {
  /** GET or POST. */
  method: string;
  /** The host, for example iam.amazonaws.com. */
  host: string;
  /** The path (/ for most query APIs). */
  path: string;
  /** Query parameters. */
  query: Record<string, string>;
  /** Headers to send and sign (host and x-amz-date are added). */
  headers: Record<string, string>;
  /** The body. */
  body: string;
  /** The region. */
  region: string;
  /** The service name in the signature (iam, sts, s3, ec2). */
  service: string;
}

/** Sign a request (SigV4): the headers to send, Authorization included. */
export async function sigv4(
  r: AwsRequest,
  key: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  now: Date,
): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...r.headers, host: r.host, "x-amz-date": amzDate };
  if (key.sessionToken) headers["x-amz-security-token"] = key.sessionToken;
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((h) => `${h}:${lower[h].trim().replace(/\s+/g, " ")}\n`).join(
    "",
  );
  const signed = names.join(";");
  const query = Object.keys(r.query).sort().map((k) => `${rfc3986(k)}=${rfc3986(r.query[k])}`).join(
    "&",
  );
  const canonical = [r.method, r.path, query, canonicalHeaders, signed, await sha256(r.body)].join(
    "\n",
  );
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let k: ArrayBuffer = await hmac(enc.encode(`AWS4${key.secretAccessKey}`) as BufferSource, day);
  for (const part of [r.region, r.service, "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

/** Every <tag>...</tag>'s inner text. */
export function xmlAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}
const xmlOne = (xml: string, tag: string) => xmlAll(xml, tag)[0] ?? "";

async function call(
  http: Http,
  key: Record<string, string>,
  r: Omit<AwsRequest, "headers" | "body" | "method"> & { headers?: Record<string, string> },
  now: Date,
): Promise<string> {
  const req: AwsRequest = { method: "GET", headers: {}, body: "", ...r } as AwsRequest;
  if (r.service === "s3") req.headers["x-amz-content-sha256"] = await sha256("");
  const headers = await sigv4(req, {
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
    sessionToken: key.sessionToken || undefined,
  }, now);
  delete headers.host;
  const q = Object.keys(r.query).sort().map((k) => `${rfc3986(k)}=${rfc3986(r.query[k])}`).join(
    "&",
  );
  const res = await http(`https://${r.host}${r.path}${q ? `?${q}` : ""}`, {
    method: "GET",
    headers,
  });
  if (res.status === 403 || res.status === 401) {
    throw new AccessDenied(
      `${r.service} ${r.query.Action ?? r.path}: ${xmlOne(res.text, "Code") || res.status}`,
    );
  }
  if (res.status >= 400) {
    throw Object.assign(
      new Error(
        `${r.service} ${r.query.Action ?? r.path}: ${
          xmlOne(res.text, "Code") || `HTTP ${res.status}`
        }`,
      ),
      { status: res.status },
    );
  }
  return res.text;
}

/** AWS. */
export const aws: Connector = {
  id: "aws",
  serviceModels: ["IaaS", "PaaS"],
  markets: ["strategic-cloud-platform-services"],
  title: "Amazon Web Services",
  logo: "",
  connectHelp: [
    "console.aws.amazon.com > IAM > Users > Create user: stolos-read (no console access)",
    "Permissions: Attach policies directly > SecurityAudit (AWS managed, read-only)",
    "The user > Security credentials > Create access key > Third-party service; copy both halves",
  ],
  recipe: {
    shell: {
      where: "AWS CloudShell (the >_ icon at the top of the AWS console), as an administrator",
      href: "https://console.aws.amazon.com/cloudshell/home",
      command:
        "aws iam create-user --user-name stolos-read && aws iam attach-user-policy --user-name stolos-read --policy-arn arn:aws:iam::aws:policy/SecurityAudit && aws iam create-access-key --user-name stolos-read",
    },
  },
  fields: [
    { name: "accessKeyId", secret: false, hint: "Access key ID (AKIA...)" },
    { name: "secretAccessKey", secret: true, hint: "Secret access key" },
  ],
  async observe(cred, http, now) {
    const gaps: string[] = [];
    const assets: Asset[] = [];
    const posture: Record<string, string | number | boolean> = {};
    const q = async (
      service: string,
      host: string,
      region: string,
      action: string,
      version: string,
      extra: Record<string, string> = {},
    ) =>
      await call(http, cred, {
        service,
        host,
        region,
        path: "/",
        query: { Action: action, Version: version, ...extra },
      }, now);
    const id = await q("sts", "sts.amazonaws.com", "us-east-1", "GetCallerIdentity", "2011-06-15");
    const account = xmlOne(id, "Account");
    assets.push({
      kind: "account",
      id: account,
      name: account,
      facts: { caller: xmlOne(id, "Arn") },
    });
    const summary = await orGap(
      gaps,
      "IAM account summary",
      "",
      () => q("iam", "iam.amazonaws.com", "us-east-1", "GetAccountSummary", "2010-05-08"),
    );
    if (summary) {
      const entry = (k: string) =>
        summary.match(new RegExp(`<key>${k}</key>\\s*<value>(\\d+)</value>`))?.[1];
      if (entry("AccountMFAEnabled") !== undefined) {
        posture.rootMfa = entry("AccountMFAEnabled") === "1";
      }
      if (entry("AccountAccessKeysPresent") !== undefined) {
        posture.rootAccessKeys = entry("AccountAccessKeysPresent") !== "0";
      }
    }
    const users = await orGap(
      gaps,
      "IAM users",
      "",
      () =>
        q("iam", "iam.amazonaws.com", "us-east-1", "ListUsers", "2010-05-08", { MaxItems: "1000" }),
    );
    for (const u of xmlAll(users, "member")) {
      assets.push({
        kind: "iam-user",
        id: xmlOne(u, "UserId"),
        name: xmlOne(u, "UserName"),
        facts: {
          created: xmlOne(u, "CreateDate").slice(0, 10),
          lastPassword: xmlOne(u, "PasswordLastUsed").slice(0, 10),
        },
      });
    }
    const buckets = await orGap(
      gaps,
      "S3 buckets",
      "",
      () =>
        call(http, cred, {
          service: "s3",
          host: "s3.amazonaws.com",
          region: "us-east-1",
          path: "/",
          query: {},
        }, now),
    );
    for (const b of xmlAll(buckets, "Bucket")) {
      assets.push({
        kind: "s3-bucket",
        id: xmlOne(b, "Name"),
        name: xmlOne(b, "Name"),
        facts: { created: xmlOne(b, "CreationDate").slice(0, 10) },
      });
    }
    try {
      await call(http, cred, {
        service: "s3",
        host: `${account}.s3-control.us-east-1.amazonaws.com`,
        region: "us-east-1",
        path: "/v20180820/configuration/publicAccessBlock",
        query: {},
        headers: { "x-amz-account-id": account },
      }, now).then((x) => {
        posture.s3BlockPublic = [
          "BlockPublicAcls",
          "IgnorePublicAcls",
          "BlockPublicPolicy",
          "RestrictPublicBuckets",
        ].every((t) => xmlOne(x, t) === "true");
      });
    } catch (e) {
      if (e instanceof AccessDenied) gaps.push(`S3 account public access block: ${e.message}`);
      else if ((e as { status?: number }).status === 404) posture.s3BlockPublic = false;
      else throw e;
    }
    const regions = await orGap(
      gaps,
      "EC2 regions",
      "",
      () => q("ec2", "ec2.us-east-1.amazonaws.com", "us-east-1", "DescribeRegions", "2016-11-15"),
    );
    let instances = 0, imdsv1 = 0;
    await Promise.all(
      xmlAll(regions, "regionName").map(async (region) => {
        const d = await orGap(
          gaps,
          `EC2 ${region}`,
          "",
          () => q("ec2", `ec2.${region}.amazonaws.com`, region, "DescribeInstances", "2016-11-15"),
        );
        for (const set of xmlAll(d, "instancesSet")) {
          for (
            const i of set.split("</item>").filter((x) => x.includes("<instanceId>"))
          ) {
            instances++;
            const tokens = xmlOne(i, "httpTokens");
            if (tokens && tokens !== "required") {
              imdsv1++;
            }
            const name = i.match(/<key>Name<\/key>\s*<value>([^<]*)<\/value>/)?.[1];
            assets.push({
              kind: "ec2-instance",
              id: xmlOne(i, "instanceId"),
              name: name || xmlOne(i, "instanceId"),
              where: region,
              facts: {
                type: xmlOne(i, "instanceType"),
                state: xmlOne(xmlOne(i, "instanceState"), "name"),
                publicIp: xmlOne(i, "ipAddress"),
                imds: tokens || "?",
              },
            });
          }
        }
      }),
    );
    if (regions) {
      posture.ec2Instances = instances;
      posture.ec2WithImdsV1 = imdsv1;
    }
    return {
      at: now.toISOString().replace(/\.\d+Z$/, "Z"),
      provider: "aws",
      account,
      assets,
      posture,
      gaps,
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "aws"),
      check(o, {
        id: "aws-root-mfa",
        title: "The root user has MFA",
        scf: ["IAC-06"],
        fact: "rootMfa",
        want: (v) => v === true,
        fix: "console.aws.amazon.com as root > Security credentials > Assign MFA device",
      }),
      check(o, {
        id: "aws-root-keys",
        title: "The root user has no access keys",
        scf: ["IAC-16"],
        fact: "rootAccessKeys",
        want: (v) => v === false,
        fix: "console.aws.amazon.com as root > Security credentials > Access keys > Delete",
      }),
      check(o, {
        id: "aws-s3-public",
        title: "S3 blocks public access for the whole account",
        scf: ["DCH-01", "NET-01"],
        fact: "s3BlockPublic",
        want: (v) => v === true,
        fix:
          "console.aws.amazon.com > S3 > Block Public Access settings for this account > Edit > Block all public access",
      }),
      check(o, {
        id: "aws-imdsv2",
        title: "Every EC2 instance requires IMDSv2",
        scf: ["CFG-02"],
        fact: "ec2WithImdsV1",
        show: (v) => `${v} of ${o.posture.ec2Instances} instance(s) allow IMDSv1`,
        want: (v) => v === 0,
        fix:
          "EC2 > the instance > Actions > Instance settings > Modify instance metadata options > IMDSv2: Required",
        warnOnly: true,
      }),
    ];
  },
};
