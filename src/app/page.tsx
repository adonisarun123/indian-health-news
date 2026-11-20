import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { type FeedItem, getLead, listFeed, listSections, listTermsWithContent } from "@/core/reader";
import { HeadlineLink, ItemMeta, kickerFor, Teaser } from "@/components/Feed";
import { JsonLd } from "@/components/JsonLd";
import { homeGraph } from "@/core/jsonld";
import { cached, TAG_FEED } from "@/lib/cache";
import { compactTime } from "@/lib/format";
import { pageMeta } from "@/lib/page";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMeta({ title: SITE_NAME, description: SITE_TAGLINE, path: "/", indexable: true })), title: { absolute: SITE_NAME } };
}

/** Our own reporting, as opposed to republished releases, partner copies and source cards. */
const isOwn = (i: FeedItem) => i.kind === "article" && !i.reproducedFrom && i.articleType !== "licensed_copy";
const isRepublished = (i: FeedItem) => i.kind === "article" && (Boolean(i.reproducedFrom) || i.articleType === "licensed_copy");

/**
 * Home as a front page (WEB-01, UX-01): an editorial lead with two sub-leads,
 * a stack of top stories, the newest items in a rail, official releases in a
 * strip, then one block per section. Each item appears once.
 */
export default async function Home() {
  const db = getDb();
  const now = new Date();
  const { lead, items, sections, states } = await cached(["home", "front"], [TAG_FEED], async () => ({
    lead: await getLead(db, now),
    items: (await listFeed(db, now, { limit: 100 })).items,
    sections: await listSections(db),
    states: await listTermsWithContent(db, "state", now),
  }));

  const used = new Set<string>(lead ? [lead.id] : []);
  const take = (n: number, pred: (i: FeedItem) => boolean = () => true) => {
    const out: FeedItem[] = [];
    for (const i of items) {
      if (out.length >= n) break;
      if (!used.has(i.id) && pred(i)) {
        used.add(i.id);
        out.push(i);
      }
    }
    return out;
  };
  const subLeads = take(4, isOwn);
  const topStories = take(5, isOwn);
  const releases = take(4, isRepublished);
  const latest = take(9);
  const blocks = sections.map((s) => ({ ...s, items: take(5, (i) => i.section?.slug === s.slug) })).filter((b) => b.items.length > 0);
  const more = take(8);

  if (!lead && items.length === 0) {
    return (
      <>
        <h1 className="visually-hidden">{SITE_NAME}</h1>
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No reports have been published yet</h2>
          <p>Reports and source updates appear here as soon as an editor publishes them.</p>
          <p className="empty-actions">
            <Link className="button primary" href="/submit-news">
              Submit news
            </Link>
            <Link className="button" href="/about">
              About {SITE_NAME}
            </Link>
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <JsonLd graph={homeGraph({ origin: SITE_URL, name: SITE_NAME })} />
      <h1 className="visually-hidden">{SITE_NAME}</h1>

      <div className="front">
        <section className="front-lead" aria-label="Lead story">
          {lead && (
            <article className="lead">
              <p className="kicker">{kickerFor(lead)}</p>
              <h2>
                <HeadlineLink item={lead} />
              </h2>
              {lead.standfirst && <p className="standfirst">{lead.standfirst}</p>}
              <ItemMeta item={lead} now={now} />
            </article>
          )}
          {subLeads.length > 0 && (
            <div className="sub-leads">
              {subLeads.map((i) => (
                <Teaser key={i.id} item={i} now={now} size="m" dek />
              ))}
            </div>
          )}
        </section>

        {topStories.length > 0 && (
          <section className="front-stack" aria-labelledby="top-heading">
            <h2 id="top-heading" className="block-label">
              Top stories
            </h2>
            {topStories.map((i, n) => (
              <Teaser key={i.id} item={i} now={now} size="s" dek={n === 0} />
            ))}
          </section>
        )}

        {latest.length > 0 && (
          <section className="front-rail" aria-labelledby="latest-heading">
            <h2 id="latest-heading" className="rail-title">
              <Link href="/latest">Latest news</Link>
            </h2>
            <ol className="rail-list">
              {latest.map((i) => (
                <li key={i.id}>
                  <time className="rail-time">{compactTime(i.visibleFrom, now)}</time>
                  <HeadlineLink item={i} />
                </li>
              ))}
            </ol>
            <p className="rail-more">
              <Link href="/latest">All latest updates</Link>
            </p>
          </section>
        )}
      </div>

      {releases.length > 0 && (
        <section className="strip" aria-labelledby="releases-heading">
          <h2 id="releases-heading" className="strip-title">
            Official releases
          </h2>
          <ul className="strip-list">
            {releases.map((i) => (
              <li key={i.id}>
                <Teaser item={i} now={now} size="s" kicker={false} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {blocks.map((b) => (
        <section key={b.slug} className="block" aria-labelledby={`block-${b.slug}`}>
          <h2 id={`block-${b.slug}`} className="block-title">
            <Link href={`/section/${b.slug}`}>{b.name}</Link>
          </h2>
          <div className={b.items.length > 1 ? "block-grid" : "block-grid single"}>
            <Teaser item={b.items[0]!} now={now} size="l" dek kicker={false} />
            {b.items.length > 1 && (
              <ul className="block-list">
                {b.items.slice(1).map((i) => (
                  <li key={i.id}>
                    <Teaser item={i} now={now} size="s" kicker={false} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ))}

      {more.length > 0 && (
        <section className="block" aria-labelledby="more-heading">
          <h2 id="more-heading" className="block-title">
            <Link href="/latest">More updates</Link>
          </h2>
          <ul className="more-grid">
            {more.map((i) => (
              <li key={i.id}>
                <Teaser item={i} now={now} size="s" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {states.length > 0 && (
        <section className="block states-block" aria-labelledby="states-heading">
          <h2 id="states-heading" className="block-title">
            <Link href="/states">News by state</Link>
          </h2>
          <ul className="inline-links">
            {states.map((s) => (
              <li key={s.slug}>
                <Link href={`/state/${s.slug}`}>{s.name}</Link>
              </li>
            ))}
            <li>
              <Link href="/states">All states and union territories</Link>
            </li>
          </ul>
        </section>
      )}

      <section className="cta-band" aria-labelledby="cta-heading">
        <div>
          <h2 id="cta-heading">Have health news to share?</h2>
          <p>Send a press release, announcement, research finding or story tip to our desk. An editor reviews every submission before anything is published.</p>
        </div>
        <Link className="button primary" href="/submit-news">
          Submit news
        </Link>
      </section>
    </>
  );
}
