import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { getFlags } from "@/core/audit";
import { absolute, SITE_NAME } from "./site";

/**
 * Shared page metadata (SEO-02). A page is indexable only when its own policy
 * allows it and the rollout flag for indexing is on. Public noindex pages stay
 * crawlable so crawlers can read the directive.
 */
export async function pageMeta(o: { title: string; description: string; path: string; indexable: boolean; type?: "article" | "website"; publishedTime?: string; modifiedTime?: string }): Promise<Metadata> {
  const flags = await getFlags(getDb());
  const index = o.indexable && Boolean(flags.indexing);
  const url = absolute(o.path);
  return {
    title: o.title,
    description: o.description,
    alternates: { canonical: url },
    robots: index ? { index: true, follow: true, "max-image-preview": "large" } : { index: false, follow: true },
    openGraph: {
      title: o.title,
      description: o.description,
      url,
      siteName: SITE_NAME,
      locale: "en_IN",
      type: o.type ?? "website",
      ...(o.publishedTime ? { publishedTime: o.publishedTime, modifiedTime: o.modifiedTime } : {}),
    },
    twitter: { card: "summary", title: o.title, description: o.description },
  };
}

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
