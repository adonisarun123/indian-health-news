import { getDb } from "@/db/client";
import { countSitemapArticles, NEWS_WINDOW_MS } from "@/core/reader";
import { absolute } from "@/lib/site";
import { indexingOn, NEWS_SHARD, xml } from "@/lib/xml";

export const dynamic = "force-dynamic";

/** News sitemap index. Shard one always exists, so the address stays valid in quiet periods. */
export async function GET(): Promise<Response> {
  const now = new Date();
  const n = (await indexingOn()) ? await countSitemapArticles(getDb(), now, new Date(now.getTime() - NEWS_WINDOW_MS)) : 0;
  const shards = Math.max(1, Math.ceil(n / NEWS_SHARD));
  return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Array.from({ length: shards }, (_, i) => `  <sitemap><loc>${absolute(`/news-sitemaps/${i + 1}.xml`)}</loc></sitemap>`).join("\n")}\n</sitemapindex>`);
}
