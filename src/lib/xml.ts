import { getDb } from "@/db/client";
import { getFlags } from "@/core/audit";

export const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export function xml(body: string, type = "application/xml"): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "public, max-age=0, s-maxage=60" } });
}

/** Sitemaps list nothing until indexing is switched on (rollout control). */
export async function indexingOn(): Promise<boolean> {
  return Boolean((await getFlags(getDb())).indexing);
}

/** Shard sizes: well under the 50,000 URL and 50 MB limits; news shards are capped at 1,000 by Google. */
export const ARTICLE_SHARD = 10_000;
export const NEWS_SHARD = 1_000;
