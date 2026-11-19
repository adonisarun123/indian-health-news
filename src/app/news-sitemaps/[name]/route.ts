import { getDb } from "@/db/client";
import { listSitemapArticles, NEWS_WINDOW_MS } from "@/core/reader";
import { istIso } from "@/core/jsonld";
import { absolute, SITE_NAME } from "@/lib/site";
import { indexingOn, NEWS_SHARD, xml, xmlEscape } from "@/lib/xml";

export const dynamic = "force-dynamic";

/**
 * Original, eligible news first published in the previous 48 hours, at most
 * 1,000 per shard. The date is the original publication time, so a correction
 * does not restart the clock and items age out even when nothing new arrives.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await ctx.params;
  const m = name.match(/^(\d{1,3})\.xml$/);
  if (!m || Number(m[1]) < 1) return new Response("Not found", { status: 404 });
  const shard = Number(m[1]);
  const now = new Date();
  const rows = (await indexingOn()) ? await listSitemapArticles(getDb(), now, { since: new Date(now.getTime() - NEWS_WINDOW_MS), limit: NEWS_SHARD, offset: (shard - 1) * NEWS_SHARD }) : [];
  if (rows.length === 0 && shard > 1) return new Response("Not found", { status: 404 });
  const items = rows.map(
    (r) => `  <url>
    <loc>${xmlEscape(absolute(`/news/${r.slug}`))}</loc>
    <news:news>
      <news:publication><news:name>${xmlEscape(SITE_NAME)}</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>${istIso(r.publishedAt)}</news:publication_date>
      <news:title>${xmlEscape(r.title)}</news:title>
    </news:news>
  </url>`,
  );
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${items.join("\n")}\n</urlset>`);
}
