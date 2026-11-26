/** Feed and news-sitemap documents to raw items. Nothing here filters or judges. */
import { elements, firstText, load, text } from "./xml";

export interface RawItem {
  title: string;
  link: string;
  guid?: string;
  published?: string;
  updated?: string;
  summary?: string;
  author?: string;
}

export type DocKind = "rss" | "atom" | "rdf" | "news_sitemap" | "sitemap_index" | "unknown";

export interface ParseResult {
  kind: DocKind;
  items: RawItem[];
}

export function detect(body: string): DocKind {
  const head = body.slice(0, 5000);
  if (/<rss[\s>]/i.test(head)) return "rss";
  if (/<feed[\s>]/i.test(head)) return "atom";
  if (/<rdf:RDF[\s>]/i.test(head)) return "rdf";
  if (/<urlset[\s>]/i.test(head)) return "news_sitemap";
  if (/<sitemapindex[\s>]/i.test(head)) return "sitemap_index";
  return "unknown";
}

const omitEmpty = (o: RawItem): RawItem => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined)) as unknown as RawItem;

export function parseDocument(xml: string): ParseResult {
  const doc = load(xml);
  const kind = detect(doc.body);
  const items: RawItem[] = [];

  if (kind === "rss" || kind === "rdf") {
    for (const { inner } of elements(doc.body, "item")) {
      const guidEl = elements(inner, "guid")[0];
      const guid = guidEl ? text(doc, guidEl.inner) : "";
      const permalinkGuid = guidEl && guidEl.attrs.ispermalink !== "false" && /^https?:\/\//i.test(guid) ? guid : "";
      items.push(
        omitEmpty({
          title: firstText(doc, inner, ["title"]),
          // FeedBurner puts the publisher's own address in origLink.
          link: firstText(doc, inner, ["feedburner:origLink", "link"]) || permalinkGuid,
          guid,
          published: firstText(doc, inner, ["pubDate", "dc:date", "published", "a10:updated"]),
          updated: firstText(doc, inner, ["atom:updated", "dc:modified"]),
          summary: firstText(doc, inner, ["description", "content:encoded"]),
          author: firstText(doc, inner, ["dc:creator", "author"]),
        }),
      );
    }
  } else if (kind === "atom") {
    for (const { inner } of elements(doc.body, "entry")) {
      const links = elements(inner, "link");
      const alt = links.find((l) => (l.attrs.rel ?? "alternate") === "alternate" && l.attrs.href) ?? links.find((l) => l.attrs.href);
      const updated = firstText(doc, inner, ["updated", "modified"]);
      const authorEl = elements(inner, "author")[0];
      items.push(
        omitEmpty({
          title: firstText(doc, inner, ["title"]),
          link: alt?.attrs.href ?? "",
          guid: firstText(doc, inner, ["id"]),
          published: firstText(doc, inner, ["published", "issued"]) || updated,
          updated,
          summary: firstText(doc, inner, ["summary", "content"]),
          author: authorEl ? firstText(doc, authorEl.inner, ["name"]) : "",
        }),
      );
    }
  } else if (kind === "news_sitemap") {
    for (const { inner } of elements(doc.body, "url")) {
      items.push(
        omitEmpty({
          title: firstText(doc, inner, ["news:title"]),
          link: firstText(doc, inner, ["loc"]),
          published: firstText(doc, inner, ["news:publication_date"]),
          updated: firstText(doc, inner, ["lastmod"]),
        }),
      );
    }
  }
  return { kind, items };
}
