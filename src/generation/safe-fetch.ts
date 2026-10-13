import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * SSRF-safe downloader for provider output URLs.
 *
 * Threat: a provider response (or a compromised/misconfigured adapter) names a URL that points inside our
 * network (cloud metadata, localhost, RFC1918) or at something huge/odd. Defences, in order:
 *   1. Only https; no credentials in the URL; default port only; host must match the adapter's allow-list.
 *   2. IP-literal hosts are classified; private/loopback/link-local/reserved ranges are refused.
 *   3. DNS is validated AT CONNECT TIME through the socket's `lookup` hook (defeats DNS rebinding):
 *      every resolved address must be public.
 *   4. Redirects are followed manually (bounded) and each hop goes through 1-3 again.
 *   5. Hard byte cap while streaming, an idle timeout PLUS an overall deadline for the whole download (a
 *      trickling server cannot hold a worker open), no cookies, no forwarded credentials.
 * Callers still validate the bytes (magic sniffing, size, kind) through the shared upload policy.
 */

export class UnsafeUrlError extends Error {
  constructor(
    readonly code:
      | "bad_url"
      | "scheme"
      | "credentials"
      | "port"
      | "host_not_allowed"
      | "private_address"
      | "too_many_redirects"
      | "too_large"
      | "timeout"
      | "http_error"
      | "network",
    message: string,
    /** HTTP status for `http_error`. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

// ───────────────────────── IP classification ─────────────────────────

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function parseIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const tail = text.lastIndexOf(":");
  let v4: number[] | null = null;
  if (text.includes(".")) {
    v4 = parseIPv4(text.slice(tail + 1));
    if (!v4) return null;
    text = `${text.slice(0, tail + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function ipv4IsPublic(b: number[]): boolean {
  const [a, b1, c] = b as [number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b1 >= 64 && b1 <= 127) return false; // CGNAT
  if (a === 169 && b1 === 254) return false; // link-local + cloud metadata
  if (a === 172 && b1 >= 16 && b1 <= 31) return false;
  if (a === 192 && b1 === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b1 === 168) return false;
  if (a === 198 && (b1 === 18 || b1 === 19)) return false;
  if (a === 198 && b1 === 51 && c === 100) return false;
  if (a === 203 && b1 === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

/** True only for globally routable unicast addresses. Unparseable input is treated as NOT public. */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip.replace(/^\[|\]$/g, ""));
  const clean = ip.replace(/^\[|\]$/g, "");
  if (family === 4) {
    const b = parseIPv4(clean);
    return b ? ipv4IsPublic(b) : false;
  }
  if (family === 6) {
    const b = parseIPv6(clean);
    if (!b) return false;
    const allZero = b.every((x) => x === 0);
    if (allZero) return false; // ::
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return false; // ::1
    if ((b[0]! & 0xfe) === 0xfc) return false; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false; // fe80::/10 link-local
    if (b[0] === 0xff) return false; // multicast
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded v4.
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
      return ipv4IsPublic(b.slice(12));
    }
    if (b.slice(0, 12).every((x) => x === 0)) return ipv4IsPublic(b.slice(12));
    // 6to4 (2002::/16) embeds an IPv4 address in bytes 2..5.
    if (b[0] === 0x20 && b[1] === 0x02) return ipv4IsPublic(b.slice(2, 6));
    // NAT64 well-known prefix 64:ff9b::/96
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return ipv4IsPublic(b.slice(12));
    return true;
  }
  return false;
}

// ───────────────────────── URL policy ─────────────────────────

function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    if (pat.startsWith("*.")) return h.endsWith(pat.slice(1)) && h.length > pat.length - 1;
    return h === pat;
  });
}

export interface UrlPolicy {
  /** Exact hosts or "*.suffix". REQUIRED: an empty list refuses every URL. */
  allowedHosts: readonly string[];
  /** Tests only. Never set by production code. */
  unsafeAllowLoopbackHttp?: boolean;
}

export function assertSafeUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("bad_url", "Output URL is not a valid URL.");
  }
  const testLoopback =
    Boolean(policy.unsafeAllowLoopbackHttp) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(testLoopback && url.protocol === "http:")) {
    throw new UnsafeUrlError("scheme", "Output URL must use https.");
  }
  if (url.username || url.password)
    throw new UnsafeUrlError("credentials", "Output URL must not contain credentials.");
  if (!testLoopback && url.port && url.port !== "443") {
    throw new UnsafeUrlError("port", "Output URL must use the default https port.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!testLoopback) {
    if (!hostMatches(host, policy.allowedHosts)) {
      throw new UnsafeUrlError("host_not_allowed", "Output host is not allowed for this provider.");
    }
    if (isIP(host) && !isPublicIp(host)) {
      throw new UnsafeUrlError("private_address", "Output URL points at a non-public address.");
    }
  }
  return url;
}

// ───────────────────────── Download ─────────────────────────

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export interface FetchedOutput {
  bytes: Uint8Array;
  contentType: string | null;
  /** Host only: never the full (possibly signed) URL. */
  host: string;
  redirects: number;
}

function checkedLookup(unsafeAllowLoopback: boolean) {
  return (
    hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as Array<{ address: string; family: number }>;
      const bad = list.find(
        (a) => !isPublicIp(a.address) && !(unsafeAllowLoopback && /^(127\.|::1$)/.test(a.address)),
      );
      if (bad || list.length === 0) {
        const e = new Error("Resolved to a non-public address") as NodeJS.ErrnoException;
        e.code = "EPRISM_PRIVATE_ADDRESS";
        return callback(e);
      }
      const wantAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (wantAll) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function once(
  url: URL,
  policy: UrlPolicy,
  limits: FetchLimits,
  /** Absolute epoch-ms deadline for the WHOLE download (all hops): `timeout` below is only an idle timeout. */
  deadlineAt: number,
): Promise<
  { kind: "body"; bytes: Uint8Array; contentType: string | null } | { kind: "redirect"; location: string }
> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    let settled = false;
    const done =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        fn(v);
      };
    const resolveOnce = done(resolve);
    const rejectOnce = done(reject);
    // A server that trickles one byte per idle-timeout would otherwise hold the worker (and its lease) open.
    const overall = setTimeout(
      () => {
        req.destroy();
        rejectOnce(new UnsafeUrlError("timeout", "Output download exceeded the time limit."));
      },
      Math.max(1, deadlineAt - Date.now()),
    );
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": "PrismStudio-Generation/1" },
        lookup: checkedLookup(Boolean(policy.unsafeAllowLoopbackHttp)) as never,
        timeout: limits.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          return resolveOnce({ kind: "redirect", location: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return rejectOnce(
            new UnsafeUrlError("http_error", `Output download failed with HTTP ${status}.`, status),
          );
        }
        const declared = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          res.destroy();
          return rejectOnce(new UnsafeUrlError("too_large", "Output is larger than the allowed size."));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > limits.maxBytes) {
            res.destroy();
            rejectOnce(new UnsafeUrlError("too_large", "Output is larger than the allowed size."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolveOnce({
            kind: "body",
            bytes: new Uint8Array(Buffer.concat(chunks)),
            contentType: (res.headers["content-type"] as string | undefined) ?? null,
          }),
        );
        res.on("error", () => rejectOnce(new UnsafeUrlError("network", "Output download was interrupted.")));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      rejectOnce(new UnsafeUrlError("timeout", "Output download timed out."));
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPRISM_PRIVATE_ADDRESS") {
        rejectOnce(new UnsafeUrlError("private_address", "Output URL resolved to a non-public address."));
      } else rejectOnce(new UnsafeUrlError("network", "Output download failed."));
    });
    req.end();
  });
}

export async function safeFetch(
  rawUrl: string,
  policy: UrlPolicy,
  limits: FetchLimits,
): Promise<FetchedOutput> {
  let url = assertSafeUrl(rawUrl, policy);
  const deadlineAt = Date.now() + limits.timeoutMs;
  for (let hop = 0; ; hop++) {
    const result = await once(url, policy, limits, deadlineAt);
    if (result.kind === "body") {
      return { bytes: result.bytes, contentType: result.contentType, host: url.hostname, redirects: hop };
    }
    if (hop >= limits.maxRedirects) {
      throw new UnsafeUrlError("too_many_redirects", "Output URL redirected too many times.");
    }
    // Every hop is re-validated against the same policy (scheme, host allow-list, address).
    url = assertSafeUrl(new URL(result.location, url).toString(), policy);
  }
}
