import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 3;

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface LookupFn {
  (hostname: string): Promise<string[]>;
}

export interface FetchImplResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

export interface FetchImpl {
  (url: URL, pinnedIps: string[], timeoutMs: number): Promise<FetchImplResponse>;
}

export async function defaultLookup(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export function isBlockedIp(address: string): boolean {
  const v = address.toLowerCase();
  if (v === "::1" || v === "0.0.0.0") return true;
  if (v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
  const mapped = v.startsWith("::ffff:") ? v.slice(7) : v;
  const parts = mapped.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return v === "::1";
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "metadata.google.internal"
    || host.endsWith(".internal");
}

async function assertPublic(hostname: string, lookup: LookupFn): Promise<string[]> {
  if (blockedHost(hostname)) throw new SafeFetchError(`Blocked host ${hostname}`);
  let ips: string[];
  try {
    ips = await lookup(hostname);
  } catch {
    throw new SafeFetchError(`Could not resolve ${hostname}`);
  }
  if (ips.length === 0) throw new SafeFetchError(`Could not resolve ${hostname}`);
  for (const ip of ips) {
    if (isBlockedIp(ip) || blockedHost(ip)) throw new SafeFetchError(`Blocked address ${ip}`);
  }
  return ips;
}

function header(headers: FetchImplResponse["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function nodeFetch(url: URL, pinnedIps: string[], timeoutMs: number): Promise<FetchImplResponse> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: "GET",
      headers: { "user-agent": "ReachBot/1.0", accept: "text/html,text/plain" },
      timeout: timeoutMs,
      lookup: (_hostname, _opts, cb) => {
        const family = pinnedIps[0]?.includes(":") ? 6 : 4;
        cb(null, pinnedIps[0]!, family);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > DEFAULT_MAX_BYTES) {
          req.destroy();
          reject(new SafeFetchError("Response exceeds 2MB"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = v;
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new SafeFetchError("Timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

export interface SafeResponse {
  url: string;
  status: number;
  text: string;
}

export async function safeFetch(input: string, opts: {
  lookup?: LookupFn;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
} = {}): Promise<SafeResponse> {
  const lookup = opts.lookup ?? defaultLookup;
  const fetchImpl = opts.fetchImpl ?? nodeFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new SafeFetchError("Invalid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("Only http and https");
    const ips = await assertPublic(url.hostname, lookup);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      fetchImpl(url, ips, timeoutMs),
      new Promise<FetchImplResponse>((_, reject) => {
        timer = setTimeout(() => reject(new SafeFetchError("Timed out")), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (response.body.byteLength > maxBytes) throw new SafeFetchError("Response exceeds 2MB");
    const location = header(response.headers, "location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === maxRedirects) throw new SafeFetchError("Too many redirects");
      current = new URL(location, url).toString();
      continue;
    }
    return { url: url.toString(), status: response.status, text: new TextDecoder().decode(response.body) };
  }
  throw new SafeFetchError("Too many redirects");
}

const PAGE_HINT = /(about|pricing|product|solutions|platform)/i;

export function linkedPages(html: string, base: string): string[] {
  const found: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = match[1];
    if (!href || !PAGE_HINT.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      found.push(url.toString());
    } catch {
      /* skip */
    }
  }
  return [...new Set(found)].slice(0, 3);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Homepage plus up to three about/pricing/product pages. Under 500 characters, the caller asks for a description. */
export async function fetchWebsite(start: string, opts: Parameters<typeof safeFetch>[1] = {}): Promise<{ text: string; thin: boolean; pages: string[] }> {
  const home = await safeFetch(start, opts);
  const pages = [home.url];
  let text = htmlToText(home.text);
  for (const link of linkedPages(home.text, home.url)) {
    try {
      const page = await safeFetch(link, opts);
      pages.push(page.url);
      text = `${text}\n${htmlToText(page.text)}`;
    } catch {
      /* a blocked linked page does not fail the homepage */
    }
  }
  return { text: text.slice(0, 50_000), thin: text.trim().length < 500, pages };
}
