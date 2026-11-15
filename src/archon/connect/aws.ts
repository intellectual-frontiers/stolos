/**
 * Spec 067 (clouds), declared with spec 091's SDK: AWS, read-only, with an
 * access key whose user (or role) has the managed SecurityAudit policy: the
 * account, IAM users, S3 buckets, EC2 instances in every enabled region, and
 * the root account's MFA and keys. Requests are signed with Signature
 * Version 4, in TypeScript (no AWS CLI). The query APIs, S3, S3 Control, and
 * GuardDuty read with GET.
 *
 * Spec 088 reads deeper, each part only where the key may: CloudTrail (every
 * trail, whether it logs, and whether it records every region), GuardDuty
 * (a detector enabled in each region), and AWS Config (a recorder recording
 * in each region). CloudTrail and Config have only a JSON API, read with
 * POST; the guard lets through only their Describe and Get actions
 * (`readPost`), and SecurityAudit allows nothing else. A part that answers
 * 404 (a service not offered in a region) is left out; its policies are then
 * not reported, so an account read before spec 088 reads the same.
 *
 * @module
 */

import { sha256, toHex } from "@intellectual-frontiers/ifc-ts/kernel";
import type { http } from "@intellectual-frontiers/ifc-ts/runtime";
import { AccessDenied, check, type Connector, fresh } from "./connector.ts";
import { type Ctx, defineConnector, exchange, type FieldDef, mustRead } from "./sdk.ts";
import {
  ACCOUNT,
  CLOUD_STORAGE,
  CLOUD_USER_ACCOUNT,
  CONFIGURATION_MANAGEMENT_DATABASE,
  EVENT_LOG,
  INTRUSION_DETECTION_SYSTEM,
  SERVER,
} from "./labels.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer): string => toHex(new Uint8Array(b));
// HMAC-SHA256 on Web Crypto: SigV4's key derivation (a commons candidate: request signing, with s3/).
async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}
/** RFC 3986 encoding, as SigV4 wants it. */
const rfc3986 = (s: string): string =>
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
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...r.headers, host: r.host, "x-amz-date": amzDate };
  if (key.sessionToken) headers["x-amz-security-token"] = key.sessionToken;
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names
    .map((h) => `${h}:${(lower[h] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signed = names.join(";");
  const query = canonicalQuery(r.query);
  const canonical = [r.method, r.path, query, canonicalHeaders, signed, await sha256(r.body)].join(
    "\n",
  );
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let k: ArrayBuffer = await hmac(enc.encode(`AWS4${key.secretAccessKey}`), day);
  for (const part of [r.region, r.service, "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

/** Every <tag>...</tag>'s inner text. */
export function xmlAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
}
const xmlOne = (xml: string, tag: string): string => xmlAll(xml, tag)[0] ?? "";

/** The query string SigV4 signs and sends: each name and value RFC 3986 encoded, sorted by name. */
const canonicalQuery = (query: Record<string, string>): string =>
  Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

/** The access key a credential holds (a session token only where it has one). */
const keyOf = (
  c: Record<string, string>,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } => ({
  accessKeyId: c["accessKeyId"] ?? "",
  secretAccessKey: c["secretAccessKey"] ?? "",
  ...(c["sessionToken"] ? { sessionToken: c["sessionToken"] } : {}),
});

/** An AWS API's answer from 400 up, other than a denial: its status, and its error code as the message. */
class AwsStatus extends Error {
  /** The HTTP status. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call(
  t: http.Transport,
  key: Record<string, string>,
  r: Omit<AwsRequest, "headers" | "body" | "method"> & { headers?: Record<string, string> },
  now: Date,
): Promise<string> {
  const req: AwsRequest = { method: "GET", body: "", ...r, headers: { ...r.headers } };
  if (r.service === "s3") req.headers["x-amz-content-sha256"] = await sha256("");
  const headers = await sigv4(req, keyOf(key), now);
  delete headers["host"];
  const q = canonicalQuery(r.query);
  const res = await exchange(t, {
    method: "GET",
    url: `https://${r.host}${r.path}${q ? `?${q}` : ""}`,
    headers,
  });
  if (res.status === 403 || res.status === 401) {
    throw new AccessDenied(
      `${r.service} ${r.query["Action"] ?? r.path}: ${xmlOne(res.body, "Code") || res.status}`,
    );
  }
  if (res.status >= 400) {
    throw new AwsStatus(
      `${r.service} ${r.query["Action"] ?? r.path}: ${xmlOne(res.body, "Code") || `HTTP ${res.status}`}`,
      res.status,
    );
  }
  return res.body;
}

type Fields = { accessKeyId: FieldDef; secretAccessKey: FieldDef };

/** The JSON APIs (awsJson1_1) Stolos reads, and the target prefix of each one's actions. */
const JSON_TARGETS: Readonly<Record<"cloudtrail" | "config", string>> = {
  cloudtrail: "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101",
  config: "StarlingDoveService",
};

/** Spec 088: a POST the guard lets through: a Describe, Get, or List action of CloudTrail or Config. */
export const awsReadPost = (url: string, init: { headers?: Record<string, string> }): boolean => {
  const service = url.match(/^https:\/\/(cloudtrail|config)\.[a-z0-9-]+\.amazonaws\.com\/$/)?.[1];
  const target =
    Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === "x-amz-target")?.[1] ?? "";
  const prefix =
    service === "cloudtrail" || service === "config" ? `${JSON_TARGETS[service]}.` : undefined;
  return (
    prefix !== undefined &&
    target.startsWith(prefix) &&
    /^(Describe|Get|List)[A-Za-z]+$/.test(target.slice(prefix.length))
  );
};

/** A JSON API action (POST, signed), its parsed answer; a 404 or a service not there is undefined. */
async function jsonCall<T>(
  ctx: Ctx<Fields>,
  service: "cloudtrail" | "config",
  region: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<T | undefined> {
  const host = `${service}.${region}.amazonaws.com`;
  const text = JSON.stringify(body);
  const headers = await sigv4(
    {
      method: "POST",
      host,
      path: "/",
      query: {},
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `${JSON_TARGETS[service]}.${action}`,
      },
      body: text,
      region,
      service,
    },
    keyOf(ctx.cred),
    ctx.now,
  );
  delete headers["host"];
  const r = await exchange(ctx.http, {
    method: "POST",
    url: `https://${host}/`,
    headers,
    body: text,
  });
  if (r.status === 401 || r.status === 403) {
    throw new AccessDenied(`${service} ${action} in ${region}: ${r.status}`);
  }
  if (r.status >= 400) {
    if (/AccessDenied|UnauthorizedOperation/.test(r.body)) {
      throw new AccessDenied(`${service} ${action} in ${region}: access denied`);
    }
    return undefined;
  }
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return undefined;
  }
}

/** A GuardDuty REST call (GET, signed); undefined when the region does not answer. */
async function guardduty<T>(
  ctx: Ctx<Fields>,
  region: string,
  path: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(
      await call(
        ctx.http,
        ctx.cred,
        {
          service: "guardduty",
          host: `guardduty.${region}.amazonaws.com`,
          region,
          path,
          query: {},
        },
        ctx.now,
      ),
    ) as T;
  } catch (e) {
    if (e instanceof AccessDenied) throw e;
    return undefined;
  }
}

interface Trail {
  Name: string;
  TrailARN?: string;
  HomeRegion?: string;
  IsMultiRegionTrail?: boolean;
  S3BucketName?: string;
  /** Added here: it is logging (undefined: its status could not be read). */
  logging?: boolean;
}

interface Detection {
  region: string;
  enabled: boolean;
}

interface Recorder {
  region: string;
  recording: boolean;
  allSupported?: boolean;
}

/** What one observation has read so far: the EC2 regions the instances are listed in. */
const seen = new WeakMap<object, { regions: string[] }>();
const state = (ctx: Ctx<Fields>) => {
  let s = seen.get(ctx);
  if (!s) seen.set(ctx, (s = { regions: [] }));
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
  call(
    ctx.http,
    ctx.cred,
    {
      service,
      host,
      region,
      path: "/",
      query: { Action: action, Version: version, ...extra },
    },
    ctx.now,
  );

interface AwsAccount {
  id: string;
  caller: string;
  rootMfa?: boolean;
  rootAccessKeys?: boolean;
  s3BlockPublic?: boolean | undefined;
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
  readPost: awsReadPost,
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
          q(ctx, "sts", "sts.amazonaws.com", "us-east-1", "GetCallerIdentity", "2011-06-15"),
        );
        const account = xmlOne(id, "Account");
        const a: AwsAccount = { id: account, caller: xmlOne(id, "Arn") };
        const summary = await ctx.orGap("IAM account summary", "", () =>
          q(ctx, "iam", "iam.amazonaws.com", "us-east-1", "GetAccountSummary", "2010-05-08"),
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
              const x = await call(
                ctx.http,
                ctx.cred,
                {
                  service: "s3",
                  host: `${account}.s3-control.us-east-1.amazonaws.com`,
                  region: "us-east-1",
                  path: "/v20180820/configuration/publicAccessBlock",
                  query: {},
                  headers: { "x-amz-account-id": account },
                },
                ctx.now,
              );
              return [
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
              ].every((t) => xmlOne(x, t) === "true");
            } catch (e) {
              // No configuration at all: nothing is blocked.
              if (e instanceof AwsStatus && e.status === 404) {
                return false;
              }
              throw e;
            }
          },
        );
        const regions = await ctx.orGap("EC2 regions", "", () =>
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
        const users = await ctx.orGap("IAM users", "", () =>
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
        const buckets = await ctx.orGap("S3 buckets", "", () =>
          call(
            ctx.http,
            ctx.cred,
            {
              service: "s3",
              host: "s3.amazonaws.com",
              region: "us-east-1",
              path: "/",
              query: {},
            },
            ctx.now,
          ),
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
            const d = await ctx.orGap(`EC2 ${region}`, "", () =>
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
    trails: {
      label: EVENT_LOG,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx): AsyncGenerator<Trail> {
        const r = await ctx.orGap(
          "CloudTrail",
          undefined as { trailList?: Trail[] } | undefined,
          () =>
            jsonCall<{ trailList?: Trail[] }>(ctx, "cloudtrail", "us-east-1", "DescribeTrails", {
              includeShadowTrails: true,
            }),
        );
        if (!r) return;
        // Read, even with no trail at all: none is logging (records override these).
        ctx.fact("cloudtrailLogging", false);
        ctx.fact("cloudtrailMultiRegion", false);
        for (const t of r.trailList ?? []) {
          const home = t.HomeRegion ?? "us-east-1";
          const st = await ctx.orGap(
            `CloudTrail ${t.Name}`,
            undefined as { IsLogging?: boolean } | undefined,
            () =>
              jsonCall<{ IsLogging?: boolean }>(ctx, "cloudtrail", home, "GetTrailStatus", {
                Name: t.TrailARN ?? t.Name,
              }),
          );
          yield { ...t, ...(st?.IsLogging !== undefined ? { logging: st.IsLogging } : {}) };
        }
      },
      map: (t: Trail) => ({
        native_id: t.TrailARN ?? t.Name,
        display_name: t.Name,
        ...(t.HomeRegion ? { where: t.HomeRegion } : {}),
        props: {
          kind: "cloudtrail",
          ...(t.logging !== undefined ? { logging: t.logging } : {}),
          multi_region: !!t.IsMultiRegionTrail,
          ...(t.S3BucketName ? { destination: `s3://${t.S3BucketName}` } : {}),
          ...(t.HomeRegion ? { region: t.HomeRegion } : {}),
        },
      }),
      asset: () => undefined,
    },
    guardduty: {
      label: INTRUSION_DETECTION_SYSTEM,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx): AsyncGenerator<Detection> {
        const found = await Promise.all(
          state(ctx).regions.map((region) =>
            ctx.orGap(`GuardDuty ${region}`, undefined as Detection | undefined, async () => {
              const d = await guardduty<{ detectorIds?: string[] }>(ctx, region, "/detector");
              if (!d) return undefined;
              for (const id of d.detectorIds ?? []) {
                const x = await guardduty<{ status?: string }>(ctx, region, `/detector/${id}`);
                if (x?.status === "ENABLED") return { region, enabled: true };
              }
              return { region, enabled: false };
            }),
          ),
        );
        yield* found.filter((x): x is Detection => !!x);
      },
      map: (d: Detection) => ({
        native_id: `guardduty:${d.region}`,
        display_name: `GuardDuty ${d.region}`,
        where: d.region,
        props: { kind: "guardduty", enabled: d.enabled, region: d.region },
      }),
      asset: () => undefined,
    },
    config: {
      label: CONFIGURATION_MANAGEMENT_DATABASE,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx): AsyncGenerator<Recorder> {
        const found = await Promise.all(
          state(ctx).regions.map((region) =>
            ctx.orGap(`AWS Config ${region}`, undefined as Recorder | undefined, async () => {
              const st = await jsonCall<{
                ConfigurationRecordersStatus?: Array<{ recording?: boolean }>;
              }>(ctx, "config", region, "DescribeConfigurationRecorderStatus");
              if (!st) return undefined;
              const rec = await jsonCall<{
                ConfigurationRecorders?: Array<{ recordingGroup?: { allSupported?: boolean } }>;
              }>(ctx, "config", region, "DescribeConfigurationRecorders");
              const all = rec?.ConfigurationRecorders?.[0]?.recordingGroup?.allSupported;
              return {
                region,
                recording: (st.ConfigurationRecordersStatus ?? []).some((x) => x.recording),
                ...(all !== undefined ? { allSupported: all } : {}),
              };
            }),
          ),
        );
        yield* found.filter((x): x is Recorder => !!x);
      },
      map: (r: Recorder) => ({
        native_id: `config:${r.region}`,
        display_name: `AWS Config ${r.region}`,
        where: r.region,
        props: {
          recording: r.recording,
          ...(r.allSupported !== undefined ? { all_resources: r.allSupported } : {}),
          region: r.region,
        },
      }),
      asset: () => undefined,
    },
  },
  posture(records) {
    const a = records.find((r) => r.label === ACCOUNT.name)?.props ?? {};
    const ec2 = records.filter((r) => r.label === SERVER.name).map((r) => r.props);
    const out: Record<string, string | number | boolean> = {};
    if (typeof a["root_mfa"] === "boolean") out["rootMfa"] = a["root_mfa"];
    if (typeof a["root_access_keys"] === "boolean") out["rootAccessKeys"] = a["root_access_keys"];
    if (typeof a["public_access_blocked"] === "boolean")
      out["s3BlockPublic"] = a["public_access_blocked"];
    // Only when the regions could be listed: else the instances are unknown, not none.
    if (a["regions"] !== undefined) {
      out["ec2Instances"] = ec2.length;
      out["ec2WithImdsV1"] = ec2.filter((p) => p["imds_v2"] === false).length;
    }
    // Spec 088: each only when it was read (absent, the policy is not reported).
    const trails = records.filter((r) => r.label === EVENT_LOG.name);
    if (trails.length) {
      out["cloudtrailLogging"] = trails.some((t) => t.props["logging"] === true);
      out["cloudtrailMultiRegion"] = trails.some(
        (t) => t.props["logging"] === true && t.props["multi_region"] === true,
      );
    }
    const gd = records.filter((r) => r.label === INTRUSION_DETECTION_SYSTEM.name);
    if (gd.length) {
      out["guarddutyRegions"] = gd.length;
      out["guarddutyOff"] = gd
        .filter((r) => !r.props["enabled"])
        .map((r) => r.props["region"])
        .join(", ");
    }
    const cfg = records.filter((r) => r.label === CONFIGURATION_MANAGEMENT_DATABASE.name);
    if (cfg.length) {
      out["configRegions"] = cfg.length;
      out["configOff"] = cfg
        .filter((r) => !r.props["recording"])
        .map((r) => r.props["region"])
        .join(", ");
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
        fix: "console.aws.amazon.com > S3 > Block Public Access settings for this account > Edit > Block all public access",
      }),
      check(o, {
        id: "aws-imdsv2",
        title: "Every EC2 instance requires IMDSv2",
        scf: ["CFG-04"],
        fact: "ec2WithImdsV1",
        show: (v) => `${v} of ${o.posture["ec2Instances"]} instance(s) allow IMDSv1`,
        want: (v) => v === 0,
        fix: "EC2 > the instance > Actions > Instance settings > Modify instance metadata options > IMDSv2: Required",
        warnOnly: true,
      }),
      // Spec 088: reported only when read.
      ...[
        check(o, {
          id: "aws-cloudtrail",
          title: "A CloudTrail trail is logging",
          scf: ["MON-03"],
          fact: "cloudtrailLogging",
          want: (v) => v === true,
          fix: "CloudTrail > Trails > Create trail (all regions, to an S3 bucket only the security account can delete from)",
        }),
        check(o, {
          id: "aws-cloudtrail-all-regions",
          title: "One CloudTrail trail records every region",
          scf: ["MON-05", "MON-03"],
          fact: "cloudtrailMultiRegion",
          want: (v) => v === true,
          fix: "CloudTrail > the trail > Edit > Apply trail to all regions: Yes",
        }),
        check(o, {
          id: "aws-guardduty",
          title: "GuardDuty is enabled in every region",
          scf: ["MON-16"],
          fact: "guarddutyOff",
          want: (v) => v === "",
          show: (v) => (v ? `off in ${v}` : `on in ${o.posture["guarddutyRegions"]} region(s)`),
          fix: "GuardDuty > Get started > Enable, in each region named (or for the organization, from its delegated administrator)",
          warnOnly: true,
        }),
        check(o, {
          id: "aws-config",
          title: "AWS Config records configuration history in every region",
          scf: ["CFG-02"],
          fact: "configOff",
          want: (v) => v === "",
          show: (v) =>
            v ? `not recording in ${v}` : `recording in ${o.posture["configRegions"]} region(s)`,
          fix: "AWS Config > Settings > Recorder: turn on recording (all resource types), in each region named",
          warnOnly: true,
        }),
      ].filter((p) => p.status !== "unknown"),
    ];
  },
});
