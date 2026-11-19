import { absolute } from "@/lib/site";

export const dynamic = "force-dynamic";

/** Public pages stay crawlable so crawlers can read their noindex directives. Private areas are disallowed. */
export function GET(): Response {
  const body = ["User-agent: *", "Disallow: /newsroom", "Disallow: /api/", "Allow: /", "", `Sitemap: ${absolute("/sitemap.xml")}`, `Sitemap: ${absolute("/news-sitemap.xml")}`, ""].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=3600" } });
}
