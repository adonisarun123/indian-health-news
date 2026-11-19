import { getDb } from "@/db/client";
import { listFeed } from "@/core/reader";
import { rss } from "@/lib/rss";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export const dynamic = "force-dynamic";

/** Site feed: our reports and the source updates we are permitted to redistribute by RSS. */
export async function GET(): Promise<Response> {
  const { items } = await listFeed(getDb(), new Date(), { channel: "rss", limit: 50 });
  return rss({ title: SITE_NAME, description: SITE_TAGLINE, path: "/", selfPath: "/feed.xml", items });
}
