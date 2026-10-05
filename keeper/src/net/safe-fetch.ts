import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Fetching arbitrary URLs a model chose. The address check runs inside the
 * socket's DNS lookup, so a hostname cannot resolve to a public address when
 * checked and a private one when connected (DNS rebinding). Every redirect hop
 * is checked again, and bodies are capped.
 */

export class FetchRefused extends Error {}

export type SafeFetchResult = {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
};

export type SafeFetchOptions = {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
};

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  let url = parseUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 3;
  for (let hop = 0; ; hop++) {
    const response = await requestOnce(url, options);
    if (response.redirect === undefined) return response.result;
    if (hop >= maxRedirects) throw new FetchRefused("too many redirects");
    url = parseUrl(new URL(response.redirect, url).toString());
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchRefused("only http and https URLs are allowed");
  }
  if (url.username !== "" || url.password !== "")
    throw new FetchRefused("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicAddress(host))
    throw new FetchRefused("that address is not public");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new FetchRefused("that host is not public");
  }
  return url;
}

function checkedLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error !== null) return callback(error, []);
    const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
    if (blocked !== undefined || addresses.length === 0) {
      const refusal = Object.assign(
        new Error(`${hostname} resolves to a non-public address`),
        {
          code: "EREFUSED",
        },
      );
      return callback(refusal, []);
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

function requestOnce(
  url: URL,
  options: SafeFetchOptions,
): Promise<
  | { result: SafeFetchResult; redirect?: undefined }
  | { redirect: string; result?: undefined }
> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: checkedLookup as never,
        headers: {
          "user-agent": "Keeper/0.1 (Buzz research agent)",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
        },
        timeout: options.timeoutMs ?? 15_000,
        signal: options.signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location !== undefined) {
          response.resume();
          resolve({ redirect: location });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            response.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () =>
          resolve({
            result: {
              url: url.toString(),
              status,
              contentType: String(response.headers["content-type"] ?? ""),
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
            },
          });
        response.on("end", finish);
        response.on("error", (error) =>
          truncated ? undefined : reject(error),
        );
      },
    );
    request.on("timeout", () => request.destroy(new FetchRefused("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** Whether an IP address is globally routable; mirrors the relay's deny classes. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicV4(address);
  if (version === 6) return isPublicV6(address.toLowerCase());
  return false;
}

function isPublicV4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  const mapped =
    /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address) ??
    /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1] !== undefined) return isPublicV4(mapped[1]);
  if (/^::ffff:/.test(address) || /^64:ff9b:/.test(address)) return false;
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false; // link/site-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (address.startsWith("2001:db8:") || address.startsWith("2002:"))
    return false;
  if (
    first === 0x2001 &&
    Number.parseInt(address.split(":")[1] || "0", 16) < 0x200
  )
    return false;
  return true;
}

/** Readable text from an HTML page, without scripts, styles or markup. */
export function htmlToText(html: string): { title: string; text: string } {
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&(lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title: decodeEntities(title), text };
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&amp;": "&",
};

/** Decode each entity once, so `&amp;lt;` stays `&lt;`. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(lt|gt|quot|#39|amp);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : "";
}
