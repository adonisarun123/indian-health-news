import { revalidateTag } from "next/cache";
import { TAG_ARTICLES, TAG_FEED } from "@/lib/cache";
import { internalAuthorized } from "@/lib/internal";

export const runtime = "nodejs";

/** Cache invalidation for a worker that runs outside the web process. */
export async function POST(request: Request): Promise<Response> {
  if (!internalAuthorized(request)) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { target?: string };
  const tags = body.target === "cache:article" ? [TAG_ARTICLES, TAG_FEED] : [TAG_FEED];
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return Response.json({ revalidated: tags });
}
