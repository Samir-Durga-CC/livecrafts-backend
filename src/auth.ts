import crypto from "node:crypto";
import { secrets } from "./secrets.js";
import type { Site } from "./types.js";

/**
 * Who is calling the backend.
 *
 *   admin  - the Livecrafts app / admin panel, with LC_API_TOKEN (or anyone on localhost when no token is set)
 *   widget - the chat inside the WordPress widget, with the signed per-person token the Livecrafts plugin issues
 *            (header X-Livecrafts-Widget). It is checked with that site's secret, which the backend received once
 *            when the site was connected. A widget caller only ever sees its own site.
 */
export interface WidgetUser { id: number; login: string; name: string; edit: boolean; deploy: boolean }
export type Caller =
  | { via: "admin" }
  | { via: "widget"; site: Site; user: WidgetUser; token: string };

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();

/** The site and person a widget token belongs to, or null when it is not valid (wrong signature, expired, unknown site). */
export function verifyWidgetToken(token: string, sites: Site[], now = Date.now()): { site: Site; user: WidgetUser } | null {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig) return null;
  let data: any;
  try { data = JSON.parse(b64url(payload).toString("utf8")); } catch { return null; }
  if (!data || (data.k ?? "widget") !== "widget" || !data.uid || !data.exp || data.exp * 1000 < now) return null;
  const site = sites.find((s) => norm(s.url) === norm(String(data.site ?? "")));
  const secret = site ? secrets.siteSecret(site.id) : "";
  if (!site || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const given = b64url(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { site, user: { id: Number(data.uid), login: String(data.login ?? ""), name: String(data.name ?? ""), edit: !!data.edit, deploy: !!data.deploy } };
}

/** A widget caller may only touch its own site. */
export function canUseSite(caller: Caller, siteId: string) {
  return caller.via === "admin" || caller.site.id === siteId;
}
