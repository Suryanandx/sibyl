/**
 * Call recordings — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Minimal S3 (AWS Signature Version 4) for recordings kept in S3-compatible
 * storage: a presigned GET for downloads and a signed DELETE for retention.
 * LiveKit egress does the upload itself.
 */
import { createHash, createHmac } from "node:crypto";

export interface S3Settings {
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Custom endpoint (MinIO, R2, …), e.g. "http://minio:9000". Absent: AWS. */
  endpoint?: string;
  /** Path-style URLs (bucket in the path); default on with a custom endpoint. */
  forcePathStyle: boolean;
}

export function s3SettingsFromEnv(env: NodeJS.ProcessEnv): S3Settings | undefined {
  const bucket = env.SIBYL_RECORDINGS_S3_BUCKET?.trim();
  if (!bucket) return undefined;
  const accessKey = env.SIBYL_RECORDINGS_S3_ACCESS_KEY?.trim() ?? "";
  const secretKey = env.SIBYL_RECORDINGS_S3_SECRET_KEY?.trim() ?? "";
  if (!accessKey || !secretKey) throw new Error("SIBYL_RECORDINGS_S3_ACCESS_KEY and SIBYL_RECORDINGS_S3_SECRET_KEY are required with SIBYL_RECORDINGS_S3_BUCKET");
  const endpoint = env.SIBYL_RECORDINGS_S3_ENDPOINT?.trim().replace(/\/+$/, "") || undefined;
  const pathStyle = env.SIBYL_RECORDINGS_S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  return {
    bucket,
    region: env.SIBYL_RECORDINGS_S3_REGION?.trim() || "us-east-1",
    accessKey,
    secretKey,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: pathStyle ? pathStyle === "true" || pathStyle === "1" : Boolean(endpoint)
  };
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function objectUrl(settings: S3Settings, key: string): URL {
  const path = key.split("/").map(encode).join("/");
  if (settings.forcePathStyle) {
    const base = settings.endpoint ?? `https://s3.${settings.region}.amazonaws.com`;
    return new URL(`${base}/${encode(settings.bucket)}/${path}`);
  }
  const base = settings.endpoint ? new URL(settings.endpoint) : new URL(`https://s3.${settings.region}.amazonaws.com`);
  return new URL(`${base.protocol}//${settings.bucket}.${base.host}/${path}`);
}

const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function stamp(now: Date): { date: string; time: string } {
  const time = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { date: time.slice(0, 8), time };
}

function signature(settings: S3Settings, date: string, toSign: string): string {
  const key = hmac(hmac(hmac(hmac(`AWS4${settings.secretKey}`, date), settings.region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign).digest("hex");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}

/** A time-limited download link for one object. */
export function presignGet(settings: S3Settings, key: string, expiresSeconds = 300, now = new Date()): string {
  const url = objectUrl(settings, key);
  const { date, time } = stamp(now);
  const scope = `${date}/${settings.region}/s3/aws4_request`;
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${settings.accessKey}/${scope}`,
    "X-Amz-Date": time,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host"
  });
  const canonical = ["GET", url.pathname, canonicalQuery(params), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", time, scope, sha256(canonical)].join("\n");
  params.set("X-Amz-Signature", signature(settings, date, toSign));
  return `${url.origin}${url.pathname}?${canonicalQuery(params)}`;
}

/** Signed request with an Authorization header (DELETE for retention; PUT in tests). */
export async function s3Request(settings: S3Settings, method: "DELETE" | "PUT" | "HEAD", key: string, body?: Uint8Array, now = new Date()): Promise<Response> {
  const url = objectUrl(settings, key);
  const { date, time } = stamp(now);
  const scope = `${date}/${settings.region}/s3/aws4_request`;
  const payload = body ? createHash("sha256").update(body).digest("hex") : sha256("");
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": time };
  const signed = Object.keys(headers).sort();
  const canonical = [method, url.pathname, canonicalQuery(url.searchParams), signed.map((name) => `${name}:${headers[name]}\n`).join(""), signed.join(";"), payload].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", time, scope, sha256(canonical)].join("\n");
  const authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKey}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature(settings, date, toSign)}`;
  const { host: _host, ...sent } = headers;
  return fetch(url, { method, headers: { ...sent, authorization }, ...(body ? { body } : {}) });
}
