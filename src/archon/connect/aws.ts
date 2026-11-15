/**
 * Spec 067 (clouds), declared with spec 091's SDK: AWS, read-only, with an
 * access key whose user (or role) has the managed SecurityAudit policy: the
 * account, IAM users, S3 buckets, EC2 instances in every enabled region, and
 * the root account's MFA and keys. Requests are signed with Signature
 * Version 4, in TypeScript (no AWS CLI). Every call is a GET (the query APIs,
 * S3, and S3 Control all read with GET), so the connector declares no POST
 * endpoint.
 *
 * @module
 */

import { AccessDenied, check, type Connector, fresh, type Http } from "./connector.ts";
import { type Ctx, defineConnector, type FieldDef, mustRead } from "./sdk.ts";
import { ACCOUNT, CLOUD_STORAGE, CLOUD_USER_ACCOUNT, SERVER } from "./labels.ts";

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

type Fields = { accessKeyId: FieldDef; secretAccessKey: FieldDef };

/** What one observation has read so far: the EC2 regions the instances are listed in. */
const seen = new WeakMap<object, { regions: string[] }>();
const state = (ctx: Ctx<Fields>) => {
  let s = seen.get(ctx);
  if (!s) seen.set(ctx, s = { regions: [] });
  return s;
};

/** A query API call (Action and Version), signed. */
const q = (
  ctx: Ctx<Fields>,
  service: string,
  host: string,
  region: string,
  action: string,
  version: string,
  extra: Record<string, string> = {},
) =>
  call(ctx.http, ctx.cred, {
    service,
    host,
    region,
    path: "/",
    query: { Action: action, Version: version, ...extra },
  }, ctx.now);

interface AwsAccount {
  id: string;
  caller: string;
  rootMfa?: boolean;
  rootAccessKeys?: boolean;
  s3BlockPublic?: boolean;
  regions?: number;
}

interface Ec2 {
  region: string;
  item: string;
}

/** AWS. */
export const aws: Connector = defineConnector({
  id: "aws",
  title: "Amazon Web Services",
  logo: "",
  serviceModels: ["IaaS", "PaaS"],
  markets: ["strategic-cloud-platform-services"],
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
  fields: {
    accessKeyId: { secret: false, hint: "Access key ID (AKIA...)" },
    secretAccessKey: { secret: true, hint: "Secret access key" },
  },
  // Each request is signed on its own (SigV4), so there are no shared headers.
  auth: () => Promise.resolve({}),
  account: (_cred, records) => records.find((r) => r.label === ACCOUNT.name)?.native_id ?? "",
  resources: {
    account: {
      label: ACCOUNT,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        // Who the key is: without it nothing else means anything, so fail loudly.
        const id = await mustRead(() =>
          q(ctx, "sts", "sts.amazonaws.com", "us-east-1", "GetCallerIdentity", "2011-06-15")
        );
        const account = xmlOne(id, "Account");
        const a: AwsAccount = { id: account, caller: xmlOne(id, "Arn") };
        const summary = await ctx.orGap(
          "IAM account summary",
          "",
          () => q(ctx, "iam", "iam.amazonaws.com", "us-east-1", "GetAccountSummary", "2010-05-08"),
        );
        if (summary) {
          const entry = (k: string) =>
            summary.match(new RegExp(`<key>${k}</key>\\s*<value>(\\d+)</value>`))?.[1];
          if (entry("AccountMFAEnabled") !== undefined) {
            a.rootMfa = entry("AccountMFAEnabled") === "1";
          }
          if (entry("AccountAccessKeysPresent") !== undefined) {
            a.rootAccessKeys = entry("AccountAccessKeysPresent") !== "0";
          }
        }
        a.s3BlockPublic = await ctx.orGap(
          "S3 account public access block",
          undefined as boolean | undefined,
          async () => {
            try {
              const x = await call(ctx.http, ctx.cred, {
                service: "s3",
                host: `${account}.s3-control.us-east-1.amazonaws.com`,
                region: "us-east-1",
                path: "/v20180820/configuration/publicAccessBlock",
                query: {},
                headers: { "x-amz-account-id": account },
              }, ctx.now);
              return [
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
              ].every((t) => xmlOne(x, t) === "true");
            } catch (e) {
              // No configuration at all: nothing is blocked.
              if (!(e instanceof AccessDenied) && (e as { status?: number }).status === 404) {
                return false;
              }
              throw e;
            }
          },
        );
        const regions = await ctx.orGap(
          "EC2 regions",
          "",
          () =>
            q(
              ctx,
              "ec2",
              "ec2.us-east-1.amazonaws.com",
              "us-east-1",
              "DescribeRegions",
              "2016-11-15",
            ),
        );
        if (regions) {
          state(ctx).regions = xmlAll(regions, "regionName");
          a.regions = state(ctx).regions.length;
        }
        yield a;
      },
      map: (a: AwsAccount) => ({
        native_id: a.id,
        display_name: a.id,
        props: {
          caller: a.caller,
          ...(a.rootMfa !== undefined ? { root_mfa: a.rootMfa } : {}),
          ...(a.rootAccessKeys !== undefined ? { root_access_keys: a.rootAccessKeys } : {}),
          ...(a.s3BlockPublic !== undefined ? { public_access_blocked: a.s3BlockPublic } : {}),
          ...(a.regions !== undefined ? { regions: a.regions } : {}),
        },
      }),
      asset: (a: AwsAccount) => ({ kind: "account", facts: { caller: a.caller } }),
    },
    users: {
      label: CLOUD_USER_ACCOUNT,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        const users = await ctx.orGap(
          "IAM users",
          "",
          () =>
            q(ctx, "iam", "iam.amazonaws.com", "us-east-1", "ListUsers", "2010-05-08", {
              MaxItems: "1000",
            }),
        );
        yield* xmlAll(users, "member");
      },
      map: (u: string) => ({
        native_id: xmlOne(u, "UserId"),
        display_name: xmlOne(u, "UserName"),
        props: {
          ...(xmlOne(u, "CreateDate") ? { created: xmlOne(u, "CreateDate") } : {}),
          ...(xmlOne(u, "PasswordLastUsed")
            ? { password_last_used: xmlOne(u, "PasswordLastUsed") }
            : {}),
        },
      }),
      asset: (u: string) => ({
        kind: "iam-user",
        facts: {
          created: xmlOne(u, "CreateDate").slice(0, 10),
          lastPassword: xmlOne(u, "PasswordLastUsed").slice(0, 10),
        },
      }),
    },
    buckets: {
      label: CLOUD_STORAGE,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        const buckets = await ctx.orGap(
          "S3 buckets",
          "",
          () =>
            call(ctx.http, ctx.cred, {
              service: "s3",
              host: "s3.amazonaws.com",
              region: "us-east-1",
              path: "/",
              query: {},
            }, ctx.now),
        );
        yield* xmlAll(buckets, "Bucket");
      },
      map: (b: string) => ({
        native_id: xmlOne(b, "Name"),
        display_name: xmlOne(b, "Name"),
        props: xmlOne(b, "CreationDate") ? { created: xmlOne(b, "CreationDate") } : {},
      }),
      asset: (b: string) => ({
        kind: "s3-bucket",
        facts: { created: xmlOne(b, "CreationDate").slice(0, 10) },
      }),
    },
    instances: {
      label: SERVER,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        // Every enabled region at once; the instances in the regions' order (a stable file).
        const found = await Promise.all(
          state(ctx).regions.map(async (region) => {
            const d = await ctx.orGap(
              `EC2 ${region}`,
              "",
              () =>
                q(
                  ctx,
                  "ec2",
                  `ec2.${region}.amazonaws.com`,
                  region,
                  "DescribeInstances",
                  "2016-11-15",
                ),
            );
            const out: Ec2[] = [];
            for (const set of xmlAll(d, "instancesSet")) {
              for (const item of set.split("</item>").filter((x) => x.includes("<instanceId>"))) {
                out.push({ region, item });
              }
            }
            return out;
          }),
        );
        yield* found.flat();
      },
      map: ({ region, item: i }: Ec2) => {
        const tokens = xmlOne(i, "httpTokens");
        const name = i.match(/<key>Name<\/key>\s*<value>([^<]*)<\/value>/)?.[1];
        return {
          native_id: xmlOne(i, "instanceId"),
          display_name: name || xmlOne(i, "instanceId"),
          where: region,
          props: {
            status: xmlOne(xmlOne(i, "instanceState"), "name"),
            type: xmlOne(i, "instanceType"),
            region,
            ...(tokens ? { imds_v2: tokens === "required" } : {}),
          },
        };
      },
      asset: ({ item: i }: Ec2) => ({
        kind: "ec2-instance",
        facts: {
          type: xmlOne(i, "instanceType"),
          state: xmlOne(xmlOne(i, "instanceState"), "name"),
          publicIp: xmlOne(i, "ipAddress"),
          imds: xmlOne(i, "httpTokens") || "?",
        },
      }),
    },
  },
  posture(records) {
    const a = records.find((r) => r.label === ACCOUNT.name)?.props ?? {};
    const ec2 = records.filter((r) => r.label === SERVER.name).map((r) => r.props);
    const out: Record<string, string | number | boolean> = {};
    if (typeof a.root_mfa === "boolean") out.rootMfa = a.root_mfa;
    if (typeof a.root_access_keys === "boolean") out.rootAccessKeys = a.root_access_keys;
    if (typeof a.public_access_blocked === "boolean") out.s3BlockPublic = a.public_access_blocked;
    // Only when the regions could be listed: else the instances are unknown, not none.
    if (a.regions !== undefined) {
      out.ec2Instances = ec2.length;
      out.ec2WithImdsV1 = ec2.filter((p) => p.imds_v2 === false).length;
    }
    return out;
  },
  policies(o, now) {
    return [
      fresh(o, now, "aws"),
      check(o, {
        id: "aws-root-mfa",
        title: "The root user has MFA",
        scf: ["IAC-37"],
        fact: "rootMfa",
        want: (v) => v === true,
        fix: "console.aws.amazon.com as root > Security credentials > Assign MFA device",
      }),
      check(o, {
        id: "aws-root-keys",
        title: "The root user has no access keys",
        scf: ["IAC-10"],
        fact: "rootAccessKeys",
        want: (v) => v === false,
        fix: "console.aws.amazon.com as root > Security credentials > Access keys > Delete",
      }),
      check(o, {
        id: "aws-s3-public",
        title: "S3 blocks public access for the whole account",
        scf: ["DCH-02", "NET-02"],
        fact: "s3BlockPublic",
        want: (v) => v === true,
        fix:
          "console.aws.amazon.com > S3 > Block Public Access settings for this account > Edit > Block all public access",
      }),
      check(o, {
        id: "aws-imdsv2",
        title: "Every EC2 instance requires IMDSv2",
        scf: ["CFG-04"],
        fact: "ec2WithImdsV1",
        show: (v) => `${v} of ${o.posture.ec2Instances} instance(s) allow IMDSv1`,
        want: (v) => v === 0,
        fix:
          "EC2 > the instance > Actions > Instance settings > Modify instance metadata options > IMDSv2: Required",
        warnOnly: true,
      }),
    ];
  },
});
