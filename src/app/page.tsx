import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { type FeedItem, getLead, listFeed, listSections, listTermsWithContent } from "@/core/reader";
import { HeadlineLink, ItemMeta, kickerFor, Teaser, Time } from "@/components/Feed";
import { JsonLd } from "@/components/JsonLd";
import { homeGraph } from "@/core/jsonld";
import { cached, TAG_FEED } from "@/lib/cache";
import { compactTime, isoIst } from "@/lib/format";
import { pageMeta } from "@/lib/page";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMeta({ title: SITE_NAME, description: SITE_TAGLINE, path: "/", indexable: true })), title: { absolute: SITE_NAME } };
}

/** Our own reporting, as opposed to republished releases, partner copies and source cards. */
const isOwn = (i: FeedItem) => i.kind === "article" && !i.reproducedFrom && i.articleType !== "licensed_copy";
const isRepublished = (i: FeedItem) => i.kind === "article" && (Boolean(i.reproducedFrom) || i.articleType === "licensed_copy");

/** How many stories a section block shows: the first block is a feature, the rest are cards. */
const FEATURE = 5;
const CARD = 4;
/** Read per section: enough to fill a block after the lead, top stories, timeline and ministry band have taken theirs. */
const SECTION_POOL = 30;

/** A section heading with its "see all" link on the same line. */
function BlockHead({ slug, name }: { slug: string; name: string }) {
  return (
    <div className="block-head">
      <h2 id={`block-${slug}`} className="block-title">
        <Link href={`/section/${slug}`}>{name}</Link>
      </h2>
      <Link className="see-all" href={`/section/${slug}`} aria-label={`All ${name} news`}>
        See all
      </Link>
    </div>
  );
}

/**
 * Home as a front page (WEB-01, UX-01). In order: the lead in a panel with
 * our own top stories under it and the newest items in a timeline beside it;
 * official releases grouped by the ministry that issued them; one feature
 * section; the other sections as a grid of cards; more updates; states.
 * Each item appears once. No column depends on a single kind of story, so a
 * thin day leaves no hole: top stories fall back to the newest releases.
 */
export default async function Home() {
  const db = getDb();
  const now = new Date();
  const { lead, items, sections, states } = await cached(["home", "front", "v2"], [TAG_FEED], async () => {
    const sections = await listSections(db);
    // Each section is read on its own. A quiet section's stories are older than
    // the newest hundred items, and its block would otherwise come up short.
    const feeds = await Promise.all(sections.map((s) => listFeed(db, now, { termId: s.id, limit: SECTION_POOL })));
    return {
      lead: await getLead(db, now),
      items: (await listFeed(db, now, { limit: 100 })).items,
      sections: sections.map((s, n) => ({ slug: s.slug, name: s.name, pool: feeds[n]!.items })),
      states: await listTermsWithContent(db, "state", now),
    };
  });

  const used = new Set<string>(lead ? [lead.id] : []);
  const take = (n: number, pred: (i: FeedItem) => boolean = () => true, pool: FeedItem[] = items) => {
    const out: FeedItem[] = [];
    for (const i of pool) {
      if (out.length >= n) break;
      if (!used.has(i.id) && pred(i)) {
        used.add(i.id);
        out.push(i);
      }
    }
    return out;
  };
  const top = take(4, isOwn);
  // The timeline takes the newest items before anything else is filled, so it is never a day behind.
  const latest = take(7);
  if (top.length < 4) top.push(...take(4 - top.length));

  // Releases by issuing ministry: the two with the most recent releases, three each.
  const byIssuer = new Map<string, FeedItem[]>();
  for (const i of items) {
    const issuer = i.release?.issuer;
    if (!issuer || used.has(i.id) || !isRepublished(i)) continue;
    byIssuer.set(issuer, [...(byIssuer.get(issuer) ?? []), i]);
  }
  const desks = [...byIssuer.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([name, list]) => ({ name, items: list.slice(0, 3) }));
  for (const d of desks) for (const i of d.items) used.add(i.id);

  const blocks = sections.map((s, n) => ({ slug: s.slug, name: s.name, items: take(n === 0 ? FEATURE : CARD, (i) => i.section?.slug === s.slug, s.pool) })).filter((b) => b.items.length > 0);
  const feature = blocks[0]?.slug === sections[0]?.slug ? blocks[0] : undefined;
  const cards = feature ? blocks.slice(1) : blocks;
  const more = take(8);
  const updated = items[0]?.visibleFrom;

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

      <div className="home">
        <p className="edition">
          <span className="edition-label">Top of the news</span>
          {updated && (
            <span className="edition-updated">
              Last updated <Time date={updated} now={now} />
            </span>
          )}
        </p>

        <div className="front">
          <div className="front-main">
            {lead && (
              <article className="lead">
                <p className="kicker">{kickerFor(lead)}</p>
                <h2>
                  <HeadlineLink item={lead} />
                </h2>
                {lead.standfirst && <p className="standfirst">{lead.standfirst}</p>}
                <ItemMeta item={lead} now={now} />
                {lead.kind === "article" && (
                  <p>
                    <Link className="lead-more" href={lead.url} aria-hidden="true" tabIndex={-1}>
                      Read the full story
                    </Link>
                  </p>
                )}
              </article>
            )}
            {top.length > 0 && (
              <section className="top" aria-labelledby="top-heading">
                <h2 id="top-heading" className="block-label">
                  Top stories
                </h2>
                <ul className="top-grid">
                  {top.map((i) => (
                    <li key={i.id}>
                      <Teaser item={i} now={now} size="m" dek />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {latest.length > 0 && (
            <section className="front-rail" aria-labelledby="latest-heading">
              <h2 id="latest-heading" className="rail-title">
                <Link href="/latest">Latest news</Link>
              </h2>
              <ol className="rail-list">
                {latest.map((i) => (
                  <li key={i.id}>
                    <span className="rail-time">
                      <time dateTime={isoIst(i.visibleFrom)}>{compactTime(i.visibleFrom, now)}</time>
                      {i.kind === "source_card" && <> · Source update</>}
                    </span>
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

        {desks.length > 0 && (
          <section className="band" aria-labelledby="desks-heading">
            <div className="band-head">
              <h2 id="desks-heading" className="band-title">
                From the ministries
              </h2>
              <p className="band-note">Official press releases, reproduced in full and credited to the ministry that issued them.</p>
            </div>
            <div className={desks.length > 1 ? "desks" : "desks single"}>
              {desks.map((d) => (
                <section key={d.name} className="desk" aria-label={d.name}>
                  <h3 className="desk-title">{d.name}</h3>
                  <ul className="desk-list">
                    {d.items.map((i, n) => (
                      <li key={i.id}>
                        <Teaser item={i} now={now} size={n === 0 ? "m" : "s"} dek={n === 0} kicker={false} as="h4" />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
        )}

        {feature && (
          <section className="block" data-section={feature.slug} aria-labelledby={`block-${feature.slug}`}>
            <BlockHead slug={feature.slug} name={feature.name} />
            <div className={feature.items.length > 1 ? "block-grid" : "block-grid single"}>
              <Teaser item={feature.items[0]!} now={now} size="l" dek kicker={false} />
              {feature.items.length > 1 && (
                <ul className="block-list">
                  {feature.items.slice(1).map((i) => (
                    <li key={i.id}>
                      <Teaser item={i} now={now} size="s" kicker={false} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {cards.length > 0 && (
          <div className="section-grid">
            {cards.map((b) => (
              <section key={b.slug} className="block section-card" data-section={b.slug} aria-labelledby={`block-${b.slug}`}>
                <BlockHead slug={b.slug} name={b.name} />
                <ul className="card-list">
                  {b.items.map((i, n) => (
                    <li key={i.id}>
                      <Teaser item={i} now={now} size={n === 0 ? "m" : "s"} dek={n === 0} kicker={false} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {more.length > 0 && (
          <section className="block" aria-labelledby="more-heading">
            <div className="block-head">
              <h2 id="more-heading" className="block-title">
                More updates
              </h2>
              <Link className="see-all" href="/latest">
                All updates
              </Link>
            </div>
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
            <div className="block-head">
              <h2 id="states-heading" className="block-title">
                Browse by state
              </h2>
              <Link className="see-all" href="/states">
                All states and union territories
              </Link>
            </div>
            <ul className="chips">
              {states.map((s) => (
                <li key={s.slug}>
                  <Link href={`/state/${s.slug}`}>
                    {s.name}
                    <span className="chip-count" aria-label={`${s.count} ${s.count === 1 ? "item" : "items"}`}>
                      {s.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

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
