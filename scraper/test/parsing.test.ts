import { describe, expect, it } from "vitest";
import { parseFeedDate } from "../lib/dates";
import { authorOf, cleanUrl, excerptOf, isHealthRelated, pathAllowed } from "../lib/filters";
import { parseDocument } from "../lib/parse";
import { parseRobots } from "../lib/robots";

const NOW = new Date("2026-11-26T00:00:00Z");
const at = (raw: string, zone?: string) => {
  const r = parseFeedDate(raw, { zone, now: NOW });
  return r.at ? r.at.toISOString() : `null: ${r.reason}`;
};

describe("feed documents", () => {
  it("reads RSS with CDATA, entities, FeedBurner origLink and permalink guids, and ignores markup inside CDATA", () => {
    const { kind, items } = parseDocument(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:feedburner="http://rssnamespace.org/feedburner/ext/1.0">
      <channel><title>Feed</title><link>https://example.in/</link>
      <item>
        <title><![CDATA[Dengue cases rise &amp; wards fill]]></title>
        <link>https://example.in/health/dengue-1.html?utm_source=rss</link>
        <guid isPermaLink="false">article-1</guid>
        <pubDate>Wed, 25 Nov 2026 15:52:27 +0530</pubDate>
        <description><![CDATA[<p>Hospitals in <b>Bengaluru</b> report more cases.</p><item>not an item</item>]]></description>
        <dc:creator>Jane Doe</dc:creator>
      </item>
      <!-- <item><title>commented out</title></item> -->
      <item>
        <title>Doctors&#8217; strike called off</title>
        <guid>https://example.in/health/strike-2.html</guid>
        <feedburner:origLink>https://example.in/health/strike-2.html</feedburner:origLink>
        <link>https://feeds.feedburner.com/~r/x/~3/abc/</link>
        <description>&lt;p&gt;Talks succeed.&lt;/p&gt;</description>
      </item>
      <item><title>Only a guid</title><guid>https://example.in/health/only-guid</guid></item>
      </channel></rss>`);
    expect(kind).toBe("rss");
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: "Dengue cases rise & wards fill", guid: "article-1", published: "Wed, 25 Nov 2026 15:52:27 +0530", author: "Jane Doe" });
    expect(items[0]!.summary).toContain("Hospitals in Bengaluru report more cases.");
    expect(items[1]).toMatchObject({ title: "Doctors’ strike called off", link: "https://example.in/health/strike-2.html", summary: "Talks succeed." });
    expect(items[2]!.link).toBe("https://example.in/health/only-guid");
  });

  it("reads Atom, preferring the alternate link and settling double-encoded entities", () => {
    const { kind, items } = parseDocument(`<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
      <entry><title type="html">Measles &amp;amp; mumps</title>
        <link rel="self" href="https://example.org/self"/><link rel="alternate" href="https://example.org/news/1"/>
        <id>tag:example.org,2026:1</id><updated>2026-11-25T10:00:00Z</updated><summary>Short</summary><author><name>Desk</name></author></entry></feed>`);
    expect(kind).toBe("atom");
    expect(items[0]).toMatchObject({ title: "Measles & mumps", link: "https://example.org/news/1", guid: "tag:example.org,2026:1", published: "2026-11-25T10:00:00Z", author: "Desk" });
  });

  it("reads a Google News sitemap and tells it apart from a sitemap index and from HTML", () => {
    const { kind, items } = parseDocument(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url><loc>https://www.example.com/health/a-1</loc><news:news><news:publication><news:name>X</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>2026-11-25T10:00:00+05:30</news:publication_date><news:title>Malaria vaccine rollout</news:title></news:news></url></urlset>`);
    expect(kind).toBe("news_sitemap");
    expect(items).toEqual([{ title: "Malaria vaccine rollout", link: "https://www.example.com/health/a-1", published: "2026-11-25T10:00:00+05:30" }]);
    expect(parseDocument(`<sitemapindex><sitemap><loc>https://x/1.xml</loc></sitemap></sitemapindex>`).kind).toBe("sitemap_index");
    expect(parseDocument(`<!doctype html><html><body>Access denied</body></html>`)).toEqual({ kind: "unknown", items: [] });
  });
});

describe("feed dates", () => {
  it("reads RFC 822 dates with numeric offsets and zone names", () => {
    expect(at("Wed, 25 Nov 2026 15:52:27 +0530")).toBe("2026-11-25T10:22:27.000Z");
    expect(at("Wed, 25 Nov 2026 06:33:33  EST")).toBe("2026-11-25T11:33:33.000Z");
    expect(at("Tue, 06 Oct 2020 16:42:38 Z")).toBe("2020-10-06T16:42:38.000Z");
    expect(at("Wed, 25 Nov 2026 10:30:00 GMT")).toBe("2026-11-25T10:30:00.000Z");
  });

  it("reads ISO 8601, and needs a zone from the manifest when the date has none", () => {
    expect(at("2026-11-25T15:13:12+05:30")).toBe("2026-11-25T09:43:12.000Z");
    expect(at("2026-11-25T10:00:00")).toBe("null: feed date has no time zone");
    expect(at("2026-11-25T10:00:00", "+05:30")).toBe("2026-11-25T04:30:00.000Z");
  });

  it("reads Fierce-style dates in a named zone, across daylight saving", () => {
    expect(at("Nov 24, 2026 4:58pm")).toBe("null: feed date has no time zone");
    expect(at("Nov 24, 2026 4:58pm", "America/New_York")).toBe("2026-11-24T21:58:00.000Z");
    expect(at("Jul 1, 2026 9:00am", "America/New_York")).toBe("2026-07-01T13:00:00.000Z");
  });

  it("rejects missing, unreadable and future dates with a reason", () => {
    expect(at("")).toBe("null: feed gives no publication time");
    expect(at("yesterday")).toBe("null: feed date is not readable");
    expect(at("Sat, 28 Nov 2026 12:00:00 +0000")).toBe("null: feed date is in the future");
  });
});

describe("URLs and relevance", () => {
  it("strips fragments and tracking, keeps meaningful parameters and upgrades to https", () => {
    expect(cleanUrl("https://www.indiatoday.in/india/story/x-3046674-2026-11-25?utm_source=rss")).toBe("https://www.indiatoday.in/india/story/x-3046674-2026-11-25");
    expect(cleanUrl("https://www.ndtv.com/health/a-12375578#publisher=newsstand")).toBe("https://www.ndtv.com/health/a-12375578");
    expect(cleanUrl("https://www.medscape.com/viewarticle/x?src=rss")).toBe("https://www.medscape.com/viewarticle/x");
    expect(cleanUrl("https://www.medscape.com/viewarticle/x?src=home&id=4")).toBe("https://www.medscape.com/viewarticle/x?src=home&id=4");
    expect(cleanUrl("http://example.in/a")).toBe("https://example.in/a");
    expect(cleanUrl("/health/b", "https://example.in/feed")).toBe("https://example.in/health/b");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("ftp://example.in/a")).toBeNull();
  });

  it("applies include and exclude paths", () => {
    const toi = (p: string) => pathAllowed(`https://timesofindia.indiatimes.com${p}`, ["/life-style/health-fitness"]);
    expect(toi("/life-style/health-fitness/diet/x.cms")).toBe(true);
    expect(toi("/life-style/travel/x.cms")).toBe(false);
    expect(pathAllowed("https://www.news18.com/photogallery/lifestyle/x.html", undefined, ["/photogallery"])).toBe(false);
    expect(pathAllowed("https://www.news18.com/lifestyle/health-and-fitness/x.html", undefined, ["/photogallery"])).toBe(true);
  });

  it("recognises health news by title or URL, and WHO only in capitals", () => {
    expect(isHealthRelated("Dengue cases rise in Bengaluru", "https://x.in/cities/a")).toBe(true);
    expect(isHealthRelated("WHO approves a new TB vaccine", "https://x.in/world/a")).toBe(true);
    expect(isHealthRelated("Who will win the election?", "https://x.in/india/a")).toBe(false);
    expect(isHealthRelated("Sensex closes higher on bank gains", "https://x.in/markets/a")).toBe(false);
    expect(isHealthRelated("Five things to know today", "https://x.in/health/five-things")).toBe(true);
  });

  it("leaves out the false positives found in the 26 November dry run", () => {
    const no = [
      "Will Prabhsimran Singh Replace Ayush Badoni? India A's Predicted XI",
      "Closed since outbreak of militancy, temple in Srinagar reopens",
      "'Healthy competition is very good': director sure the film will do well",
      "How NITI Aayog's Fiscal Health Index is rewiring India's federalism",
      "Bengaluru cops seize drugs worth Rs 5.8 crore, three arrested",
      "Pregnant Gujarat woman, husband die in road accident",
      "Huang apologises to Nvidia staff, says he is in therapy",
    ];
    for (const t of no) expect(isHealthRelated(t, "https://x.in/india/a"), t).toBe(false);
    const yes = [
      "Over 50% Indian women of reproductive age are anaemic: ICMR",
      "Ministry of Ayush launches a quality portal",
      "CDSCO flags 120 drug samples as not of standard quality",
      "Drug regulator orders recall of cough syrup batch",
      "AMR Awareness Week: Why the fight against superbugs needs political leadership",
      "Can mosquitoes help fight dengue instead of spreading it?",
    ];
    for (const t of yes) expect(isHealthRelated(t, "https://x.in/india/a"), t).toBe(true);
  });

  it("trims teasers to a short excerpt and drops ones that repeat the title", () => {
    expect(excerptOf("New wards open. The post New wards appeared first on Example News.", "New wards")).toBe("New wards open.");
    expect(excerptOf("Same as title", "Same as title")).toBeUndefined();
    const long = excerptOf("word ".repeat(200), "t")!;
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("keeps author names and drops bare e-mail addresses", () => {
    expect(authorOf("noreply@example.com (Jane Doe)")).toBe("Jane Doe");
    expect(authorOf("editor@example.com")).toBeUndefined();
    expect(authorOf("Staff Writer")).toBe("Staff Writer");
  });
});

describe("robots.txt", () => {
  const text = `
User-agent: *
Disallow: /private
Allow: /private/ok
Disallow: /*.pdf$

User-agent: OtherBot
User-agent: IndiaHealthNewsBot
Disallow: /feeds
`;

  it("uses the group naming our token, including a group shared with other agents", () => {
    const ours = parseRobots(text, "IndiaHealthNewsBot");
    expect(ours.allows("/private/x")).toBe(true);
    expect(ours.allows("/feeds/health.xml")).toBe(false);
  });

  it("falls back to *, with the longest rule winning and $ anchoring the end", () => {
    const anyone = parseRobots(text, "SomeBot");
    expect(anyone.allows("/private/x")).toBe(false);
    expect(anyone.allows("/private/ok/1")).toBe(true);
    expect(anyone.allows("/doc.pdf")).toBe(false);
    expect(anyone.allows("/doc.pdf?x=1")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow:\n", "SomeBot").allows("/anything")).toBe(true);
  });
});
