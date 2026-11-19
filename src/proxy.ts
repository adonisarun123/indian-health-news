import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getPublicArticle } from "@/core/public";
import { SITE_NAME } from "@/lib/site";

/**
 * Removed stories (COR-01). A page component cannot answer 410 or 451, so the
 * check runs here, before rendering: a mandatory removal or an expired licence
 * gets the right status and an empty, uncacheable notice. This is also the
 * live suppression check that sits in front of any cached response (ARC-02).
 */
export async function proxy(request: NextRequest) {
  const slug = request.nextUrl.pathname.slice("/news/".length);
  if (!slug || slug.includes("/")) return NextResponse.next();
  let result;
  try {
    result = await getPublicArticle(getDb(), decodeURIComponent(slug), new Date());
  } catch {
    // Fail closed: if the suppression check cannot run, do not serve the story.
    return new NextResponse("Service temporarily unavailable.", { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
  }
  if (result.kind !== "gone") return NextResponse.next();
  const legal = result.status === 451;
  const title = legal ? "Unavailable for legal reasons" : "This page has been removed";
  const html = `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} | ${SITE_NAME}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${legal ? "This page is not available because of a legal restriction." : "This page has been permanently removed."}</p><p><a href="/latest">Latest updates</a> · <a href="/corrections">Corrections</a></p></body></html>`;
  return new NextResponse(html, { status: result.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

export const config = { matcher: "/news/:slug" };
