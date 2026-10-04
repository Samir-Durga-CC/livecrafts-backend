import dns from "node:dns/promises";
import net from "node:net";

/**
 * Download an IMAGE from a public web address, safely:
 *  - http(s) only, max 3 redirects (each hop is checked again),
 *  - the host must resolve to a PUBLIC address (no localhost, LAN, cloud metadata ...), so a prompt can never make
 *    the server probe its own network,
 *  - must really be an image (content-type AND file signature), at most 10 MB.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" };

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

async function assertPublic(u: URL) {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) image addresses are allowed.");
  if (u.username || u.password) throw new Error("Image addresses with a login inside are not allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length) throw new Error(`Cannot find the website ${host}.`);
  if (ips.some(isPrivateIp)) throw new Error("That address points to a private/internal network, so it is not downloaded.");
}

function sniff(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.subarray(4, 12).toString("ascii").startsWith("ftypavi")) return "image/avif";
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 300).toString("utf8"))) return "image/svg+xml";
  return null;
}

export interface DownloadedImage { buf: Buffer; mime: string; filename: string; finalUrl: string }

export async function downloadImage(url: string, opts: { fetchImpl?: typeof fetch; skipHostCheck?: boolean } = {}): Promise<DownloadedImage> {
  const f = opts.fetchImpl ?? fetch;
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("That is not a valid web address."); }
  for (let hop = 0; hop < 4; hop++) {
    if (!opts.skipHostCheck) await assertPublic(u);
    const res = await f(u, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Livecrafts/0.7 (+image import)", Accept: "image/*" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { u = new URL(res.headers.get("location")!, u); continue; }
    if (!res.ok) throw new Error(`The image address answered HTTP ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error("The image is larger than 10 MB.");
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > MAX_IMAGE_BYTES) throw new Error("The image is larger than 10 MB.");
      chunks.push(Buffer.from(c));
    }
    const buf = Buffer.concat(chunks);
    const mime = sniff(buf);
    if (!mime) throw new Error("That address did not return an image (jpg, png, gif, webp, avif or svg).");
    const base = decodeURIComponent(u.pathname.split("/").pop() || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "image";
    return { buf, mime, filename: `${base}.${TYPES[mime]}`, finalUrl: u.href };
  }
  throw new Error("Too many redirects.");
}
