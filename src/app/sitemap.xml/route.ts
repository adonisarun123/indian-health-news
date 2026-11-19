import { getDb } from "@/db/client";
import { countSitemapArticles } from "@/core/reader";
import { absolute } from "@/lib/site";
import { ARTICLE_SHARD, indexingOn, xml } from "@/lib/xml";

export const dynamic = "force-dynamic";

/** Sitemap index: static pages and hubs, then article shards (SEO-02). */
export async function GET(): Promise<Response> {
  const on = await indexingOn();
  const shards = on ? Math.ceil((await countSitemapArticles(getDb(), new Date())) / ARTICLE_SHARD) : 0;
  const names = ["pages.xml", ...Array.from({ length: shards }, (_, i) => `articles-${i + 1}.xml`)];
  return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${names.map((n) => `  <sitemap><loc>${absolute(`/sitemaps/${n}`)}</loc></sitemap>`).join("\n")}\n</sitemapindex>`);
}
