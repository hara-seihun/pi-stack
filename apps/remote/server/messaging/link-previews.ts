import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { MessagingLinkPreview } from "./protocol";
import { simpleLinkPreview } from "./links";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");

const MAX_HTML = 512 * 1024;
const MAX_IMAGE = 256 * 1024;
const DEADLINE_MS = 1_800;
const MAX_REDIRECTS = 3;
const CACHE_LIMIT = 256;

function safeUrl(input: string): URL {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname || url.href.length > 2048) throw new Error("Unsafe preview URL");
  return url;
}

async function pinnedAddress(url: URL, deadline: number): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Preview DNS timed out")), Math.max(1, Math.min(DEADLINE_MS, deadline - Date.now())));
    lookup(host, { all: true, verbatim: true }).then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
  // IPv6 answers are never passed to the socket. A private IPv4 answer mixed
  // with a public one rejects the whole response rather than risking rebinding.
  const ipv4 = addresses.filter(({ family }) => family === 4);
  if (!ipv4.length || ipv4.some(({ address }) => blocked.check(address, "ipv4"))) throw new Error("Preview target is not public IPv4");
  return ipv4[0].address;
}

async function download(input: string, maxBytes: number, deadline: number, hops = 0, addressForUrl = pinnedAddress): Promise<{ body: Buffer; type: string; url: URL }> {
  if (Date.now() >= deadline) throw new Error("Preview timed out");
  const url = safeUrl(input);
  const address = await addressForUrl(url, deadline);
  if (Date.now() >= deadline) throw new Error("Preview timed out");
  const response = await new Promise<{ body: Buffer; type: string; redirect?: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", agent: false, family: 4,
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers: { "accept": maxBytes === MAX_HTML ? "text/html,application/xhtml+xml" : "image/png,image/jpeg,image/webp,image/gif", "accept-encoding": "identity", "user-agent": "PiStack-LinkPreview/1.0" },
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ body: Buffer.alloc(0), type: "", redirect: res.headers.location });
        return;
      }
      if (status !== 200) { res.resume(); reject(new Error(`Preview HTTP ${status}`)); return; }
      const prefixOnly = maxBytes === MAX_HTML;
      const type = String(res.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase();
      const declared = Number(res.headers["content-length"]);
      if (!prefixOnly && declared > maxBytes) { res.destroy(); reject(new Error("Preview exceeds byte limit")); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) {
          if (prefixOnly) { chunks.push(chunk.subarray(0, maxBytes - (length - chunk.length))); resolve({ body: Buffer.concat(chunks), type }); res.destroy(); }
          else { res.destroy(); reject(new Error("Preview exceeds byte limit")); }
        } else {
          chunks.push(chunk);
          if (prefixOnly && length === maxBytes) { resolve({ body: Buffer.concat(chunks), type }); res.destroy(); }
        }
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks), type }));
      res.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("Preview timed out")), Math.max(1, Math.min(DEADLINE_MS, deadline - Date.now())));
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
  if (response.redirect) {
    if (hops >= MAX_REDIRECTS) throw new Error("Too many preview redirects");
    return download(new URL(response.redirect, url).href, maxBytes, deadline, hops + 1, addressForUrl);
  }
  return { body: response.body, type: response.type, url };
}

function decode(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const number = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "";
    }
    return named[name.toLowerCase()] ?? entity;
  });
}

function tidy(value: string | undefined): string | null {
  return value ? decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  return result;
}

function raster(body: Buffer, type: string): boolean {
  if (type === "image/jpeg") return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (type === "image/png") return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/webp") return body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP";
  if (type === "image/gif") return body.toString("ascii", 0, 6).startsWith("GIF8");
  return false;
}

async function resolvePreview(url: string, addressForUrl = pinnedAddress): Promise<MessagingLinkPreview> {
  const fallback = simpleLinkPreview(url);
  const deadline = Date.now() + 7_000;
  try {
    const page = await download(url, MAX_HTML, deadline, 0, addressForUrl);
    if (!/^(text\/html|application\/xhtml\+xml)$/.test(page.type)) return fallback;
    const html = page.body.toString("utf8");
    const meta = new Map<string, string>();
    for (const match of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      const attrs = attributes(match[0]);
      const key = (attrs.property ?? attrs.name)?.toLowerCase();
      if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
    }
    const title = tidy(meta.get("og:title") ?? meta.get("twitter:title") ?? /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]) ?? fallback.title;
    const description = tidy(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"));
    const siteName = tidy(meta.get("og:site_name"));
    const image = meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("twitter:image");
    let imageUrl: string | null = null;
    if (image) {
      try {
        const imageTarget = new URL(image, page.url).href;
        const response = await download(imageTarget, MAX_IMAGE, deadline, 0, addressForUrl);
        if (raster(response.body, response.type)) imageUrl = `data:${response.type};base64,${response.body.toString("base64")}`;
      } catch { /* Text metadata is still useful if an image cannot be fetched. */ }
    }
    return { url, title, description, imageUrl, siteName };
  } catch { return fallback; }
}

export class PreviewOverloaded extends Error {}

export function createLinkPreviewResolver(addressForUrl = pinnedAddress) {
  const cache = new Map<string, { expires: number; value: MessagingLinkPreview }>();
  const pending = new Map<string, Promise<MessagingLinkPreview>>();
  const waiting: Array<() => void> = [];
  let active = 0;
  return (url: string): Promise<MessagingLinkPreview> => {
    const existing = cache.get(url);
    if (existing && existing.expires > Date.now()) return Promise.resolve(existing.value);
    const inflight = pending.get(url);
    if (inflight) return inflight;
    if (active >= 4 && waiting.length >= 8) return Promise.reject(new PreviewOverloaded("Link previews are busy. Retry shortly."));
    const task = new Promise<MessagingLinkPreview>((resolve, reject) => {
      const run = () => {
        active++;
        void resolvePreview(url, addressForUrl).then(value => {
          cache.delete(url);
          cache.set(url, { value, expires: Date.now() + (value.title === new URL(url).hostname ? 5 * 60_000 : 60 * 60_000) });
          if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          resolve(value);
        }, reject).finally(() => {
          active--;
          pending.delete(url);
          waiting.shift()?.();
        });
      };
      if (active < 4) run();
      else waiting.push(run);
    });
    pending.set(url, task);
    return task;
  };
}

export const linkPreview = createLinkPreviewResolver();
