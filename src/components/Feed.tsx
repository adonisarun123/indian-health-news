import Link from "next/link";
import type { ReactNode } from "react";
import type { FeedItem } from "@/core/reader";
import { isoIst, shortDateTime } from "@/lib/format";

export function Time({ date, now, format = shortDateTime }: { date: Date; now: Date; format?: (d: Date, now: Date) => string }) {
  return <time dateTime={isoIst(date)}>{format(date, now)}</time>;
}

/** The label above a headline. Republished and press material are always named as such (PUB-02). */
export function kickerFor(item: FeedItem, { link = true }: { link?: boolean } = {}): ReactNode {
  if (item.kind === "source_card") return "Source update";
  if (item.articleType === "licensed_copy") return `Republished from ${item.publisher}`;
  if (item.reproducedFrom) return item.reproducedFrom === "Press Information Bureau" ? "Republished from PIB" : `Republished from ${item.reproducedFrom}`;
  if (item.articleType === "press_material") return "Press material";
  if (item.articleType === "analysis") return "Analysis";
  if (item.section) return link ? <Link href={`/section/${item.section.slug}`}>{item.section.name}</Link> : item.section.name;
  return "News";
}

/** Byline or issuer, time and place, as one muted line. */
export function ItemMeta({ item, now, format }: { item: FeedItem; now: Date; format?: (d: Date, now: Date) => string }) {
  if (item.kind === "source_card") {
    return (
      <p className="meta">
        {item.publisher} · <Time date={item.sourcePublishedAt ?? item.visibleFrom} now={now} format={format} />
        {item.state && <> · {item.state.name}</>}
      </p>
    );
  }
  return (
    <p className="meta">
      {item.release ? <>{item.release.issuer ?? item.reproducedFrom} · Issued </> : item.author ? <>{item.author.name} · </> : null}
      <Time date={item.visibleFrom} now={now} format={format} />
      {item.state && <> · {item.state.name}</>}
    </p>
  );
}

/** A linked headline. Source cards link straight to the publisher and say so (WEB-03). */
export function HeadlineLink({ item }: { item: FeedItem }) {
  return item.kind === "source_card" ? (
    <a className="ext" href={item.url} rel="noopener external">
      {item.title}
      <span className="visually-hidden"> (at {item.publisher})</span>
    </a>
  ) : (
    <Link href={item.url}>{item.title}</Link>
  );
}

/** Standfirst, or for a reproduced release the issuing body, section and reading time. */
function Dek({ item }: { item: FeedItem }) {
  if (item.release) {
    return (
      <p className="dek">
        {item.section && <>{item.section.name} · </>}
        {Math.max(1, Math.round(item.release.words / 200))} min read
      </p>
    );
  }
  return item.standfirst ? <p className="dek">{item.standfirst}</p> : null;
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

/** A listing row: kicker, headline, standfirst, byline and time. */
export function StoryItem({ item, now }: { item: FeedItem; now: Date }) {
  return (
    <article className="item">
      <p className="kicker">{kickerFor(item)}</p>
      <h3>
        <HeadlineLink item={item} />
      </h3>
      <Dek item={item} />
      <ItemMeta item={item} now={now} />
    </article>
  );
}

/** A teaser for the front page and rails, sized by `size`. */
export function Teaser({ item, now, size = "s", dek = false, kicker = true, as: H = "h3" }: { item: FeedItem; now: Date; size?: "xl" | "l" | "m" | "s"; dek?: boolean; kicker?: boolean; as?: "h2" | "h3" }) {
  return (
    <article className={`teaser teaser-${size}`}>
      {kicker && <p className="kicker">{kickerFor(item)}</p>}
      <H className="teaser-title">
        <HeadlineLink item={item} />
      </H>
      {dek && <Dek item={item} />}
      <ItemMeta item={item} now={now} />
    </article>
  );
}

export function FeedList({ items, now }: { items: FeedItem[]; now: Date; twoCol?: boolean }) {
  return (
    <ul className="feed">
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
