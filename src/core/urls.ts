/** URL handling for provenance and matching (ING-01, SEC-01). */

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "_ga",
  "_gl",
  "yclid",
]);

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

/**
 * Normalize a URL for matching: lowercase host, strip fragment, default port
 * and known tracking parameters. Semantic query parameters are preserved in
 * their original order.
 */
export function normalizeUrl(input: string): string {
  const u = new URL(input);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.port === "443") u.port = "";
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (!isTracking(k)) kept.push([k, v]);
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export interface AllowedHost {
  host: string;
  pathPrefix: string;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** A URL is acceptable when it is HTTPS, has no credentials and matches a registered host and path. */
export function checkSourceUrl(input: string, allowed: AllowedHost[]): UrlCheck {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "must use https" };
  if (u.username || u.password) return { ok: false, reason: "must not contain credentials" };
  if (u.port && u.port !== "443") return { ok: false, reason: "non-standard port is not approved" };
  const host = u.hostname.toLowerCase();
  const match = allowed.some((a) => a.host === host && pathMatches(u.pathname, a.pathPrefix));
  if (!match) return { ok: false, reason: "host or path is not approved for this source" };
  return { ok: true, url: u };
}

function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === "/" || prefix === "") return true;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === p || pathname.startsWith(`${p}/`);
}
