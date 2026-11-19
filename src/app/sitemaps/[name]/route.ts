import { getDb } from "@/db/client";
import { getPage, PAGE_SLUGS } from "@/core/settings";
import { listIndexableAuthors, listIndexableHubs, listSitemapArticles } from "@/core/reader";
import { absolute } from "@/lib/site";
import { ARTICLE_SHARD, indexingOn, xml, xmlEscape } from "@/lib/xml";

export const dynamic = "force-dynamic";

const urlset = (entries: { loc: string; lastmod?: Date }[]) =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map((e) => `  <url><loc>${xmlEscape(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod.toISOString()}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>`;

/** Only canonical, indexable, 200 URLs. Drafts, partner copies and removed stories never appear. */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await ctx.params;
  const db = getDb();
  const now = new Date();
  const on = await indexingOn();

  if (name === "pages.xml") {
    if (!on) return xml(urlset([]));
    const entries: { loc: string; lastmod?: Date }[] = ["/", "/latest", "/states", "/corrections"].map((p) => ({ loc: absolute(p) }));
    for (const slug of PAGE_SLUGS) {
      const page = await getPage(db, slug);
      if (page) entries.push({ loc: absolute(`/${slug}`), lastmod: page.effectiveAt });
    }
    for (const hub of await listIndexableHubs(db, now)) entries.push({ loc: absolute(`/${hub.kind}/${hub.slug}`) });
    for (const slug of await listIndexableAuthors(db, now)) entries.push({ loc: absolute(`/authors/${slug}`) });
    return xml(urlset(entries));
  }

  const m = name.match(/^articles-(\d{1,4})\.xml$/);
  if (!m) return new Response("Not found", { status: 404 });
  const shard = Number(m[1]);
  const rows = on && shard >= 1 ? await listSitemapArticles(db, now, { limit: ARTICLE_SHARD, offset: (shard - 1) * ARTICLE_SHARD }) : [];
  if (rows.length === 0 && shard > 1) return new Response("Not found", { status: 404 });
  // lastmod is the genuine modification time: publication, or a published correction.
  return xml(urlset(rows.map((r) => ({ loc: absolute(`/news/${r.slug}`), lastmod: r.lastmod }))));
}
