import Link from "next/link";
import type { FeedItem } from "@/core/reader";
import { isoIst, shortDateTime } from "@/lib/format";

function Time({ date, now }: { date: Date; now: Date }) {
  return <time dateTime={isoIst(date)}>{shortDateTime(date, now)}</time>;
}

/**
 * An external source update. It names the publisher, links straight to the
 * original and never looks like the newsroom's own reporting (PUB-02, WEB-03).
 */
export function SourceCard({ item, now, heading: H = "h3" }: { item: FeedItem; now: Date; heading?: "h2" | "h3" }) {
  return (
    <article className="source-card" aria-label={`Source update from ${item.publisher}`}>
      <p className="kicker">Source update</p>
      <p className="publisher">{item.sourceSlug ? <Link href={`/sources/${item.sourceSlug}`}>{item.publisher}</Link> : item.publisher}</p>
      <H className="title">{item.title}</H>
      <p className="meta">
        <Time date={item.sourcePublishedAt ?? item.visibleFrom} now={now} />
        {item.state && <> · {item.state.name}</>}
      </p>
      <a className="read-at ext" href={item.url} rel="noopener external">
        Read at {item.publisher}
        <span className="visually-hidden">: {item.title}</span>
      </a>
    </article>
  );
}

export function StoryItem({ item, now }: { item: FeedItem; now: Date }) {
  const partner = item.articleType === "licensed_copy";
  return (
    <article className="item">
      <p className="kicker">
        {partner ? `Republished from ${item.publisher}` : item.articleType === "press_material" ? "Press material" : item.articleType === "analysis" ? "Analysis" : item.section ? <Link href={`/section/${item.section.slug}`}>{item.section.name}</Link> : "News"}
      </p>
      <h3>
        <Link href={item.url}>{item.title}</Link>
      </h3>
      {item.standfirst && <p className="standfirst">{item.standfirst}</p>}
      <p className="meta">
        {item.author && <>{item.author.name} · </>}
        <Time date={item.visibleFrom} now={now} />
        {item.state && <> · {item.state.name}</>}
      </p>
    </article>
  );
}

export function FeedList({ items, now, twoCol = false }: { items: FeedItem[]; now: Date; twoCol?: boolean }) {
  return (
    <ul className={twoCol ? "feed two-col" : "feed"}>
      {items.map((item) => (
        <li key={item.id}>{item.kind === "source_card" ? <SourceCard item={item} now={now} /> : <StoryItem item={item} now={now} />}</li>
      ))}
    </ul>
  );
}

/** Ordinary crawlable pagination: each page is a stable link (WEB-01, WEB-03). */
export function Pager({ newerHref, olderHref }: { newerHref?: string | null; olderHref?: string | null }) {
  if (!newerHref && !olderHref) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      {newerHref ? (
        <Link className="button" href={newerHref} rel="prev">
          Back to newest
        </Link>
      ) : (
        <span />
      )}
      {olderHref && (
        <Link className="button" href={olderHref} rel="next">
          Older updates
        </Link>
      )}
    </nav>
  );
}
