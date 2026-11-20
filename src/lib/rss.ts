import type { FeedItem } from "@/core/reader";
import { absolute, SITE_NAME } from "./site";
import { xml, xmlEscape } from "./xml";

/**
 * RSS 2.0. Items carry only what the rights register permits on the RSS
 * channel: the listing query already filters by channel. A source card links
 * to its origin and is described as a source update, never as our report.
 */
export function rss(o: { title: string; description: string; path: string; selfPath: string; items: FeedItem[] }): Response {
  const items = o.items.map((i) => {
    const link = i.isExternal ? i.url : absolute(i.url);
    const description = i.isExternal ? `Source update from ${i.publisher}. Read it at the publisher's site.` : (i.release ? `Press release${i.release.issuer ? ` from the ${i.release.issuer}` : ""}, republished from ${i.reproducedFrom}.` : (i.standfirst ?? ""));
    return `    <item>
      <title>${xmlEscape(i.title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="${i.isExternal ? "false" : "true"}">${xmlEscape(i.isExternal ? `source-update:${i.url}` : link)}</guid>
      <pubDate>${i.visibleFrom.toUTCString()}</pubDate>
      <description>${xmlEscape(description)}</description>
      <source url="${xmlEscape(i.isExternal ? i.url : absolute("/feed.xml"))}">${xmlEscape(i.publisher)}</source>
    </item>`;
  });
  const updated = o.items[0]?.visibleFrom ?? new Date();
  return xml(
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(o.title)}</title>
    <link>${absolute(o.path)}</link>
    <description>${xmlEscape(o.description)}</description>
    <language>en-in</language>
    <lastBuildDate>${updated.toUTCString()}</lastBuildDate>
    <atom:link href="${absolute(o.selfPath)}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`,
    "application/rss+xml",
  );
}

export const FEED_TITLE = SITE_NAME;
