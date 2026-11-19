import { getDb } from "@/db/client";
import { getHub, listFeed } from "@/core/reader";
import { rss } from "@/lib/rss";
import { SITE_NAME } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const db = getDb();
  const now = new Date();
  const hub = await getHub(db, "section", slug, now);
  if (hub.kind !== "ok") return new Response("Not found", { status: 404 });
  const { items } = await listFeed(db, now, { channel: "rss", termId: hub.term.id, limit: 50 });
  return rss({ title: `${hub.term.name} | ${SITE_NAME}`, description: `Reports filed under ${hub.term.name}.`, path: `/section/${slug}`, selfPath: `/section/${slug}/feed.xml`, items });
}
