import { createHash } from "node:crypto";
import { revalidateTag, unstable_cache } from "next/cache";
import type { Distributor } from "@/core/outbox";

/**
 * Data cache for listings and navigation, with explicit invalidation (ARC-02).
 *
 * Article pages are never cached here: a story is always read live, behind
 * the removal check in proxy.ts, so a retraction or removal cannot be served
 * from a cache. Listings are cached for at most a minute. The cache key
 * carries the current minute, so an entry cannot outlive it even if an
 * invalidation is lost: there is no stale-while-revalidate past that bound.
 */
export const TAG_FEED = "feed";
export const TAG_ARTICLES = "articles";
const BUCKET_MS = 60_000;

/** Separates caches of different databases that share a build or a disk. */
const NAMESPACE = createHash("sha256").update(process.env.DATABASE_URL ?? "").digest("hex").slice(0, 12);

function pack(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    return this[key] instanceof Date ? { $date: (this[key] as Date).toISOString() } : v;
  });
}

function unpack<T>(text: string): T {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof v.$date === "string" && Object.keys(v).length === 1 ? new Date(v.$date) : v)) as T;
}

export async function cached<T>(key: string[], tags: string[], fn: () => Promise<T>): Promise<T> {
  if (process.env.DISABLE_DATA_CACHE === "1") return fn();
  const bucket = String(Math.floor(Date.now() / BUCKET_MS));
  const text = await unstable_cache(async () => pack(await fn()), [NAMESPACE, ...key, bucket], { tags, revalidate: 120 })();
  return unpack<T>(text);
}

/** Delivery targets mapped to cache tags. `expire: 0` means stale content is never served after a change. */
export const nextDistributor: Distributor = {
  async deliver(target) {
    revalidateTag(target === "cache:article" ? TAG_ARTICLES : TAG_FEED, { expire: 0 });
    if (target === "cache:article") revalidateTag(TAG_FEED, { expire: 0 });
  },
};
