import Link from "next/link";
import { getDb } from "@/db/client";
import { listFeed, listSections } from "@/core/reader";
import { cached, TAG_FEED } from "@/lib/cache";
import { compactTime } from "@/lib/format";
import { HeadlineLink } from "./Feed";

/**
 * Right-hand rail for inner pages: the newest items, then section links and
 * the submission prompt. A listing, so it may come from the one-minute cache
 * even on a story page; the story itself is always read live (ARC-02).
 */
export async function Rail({ now, excludeUrls = [], title = "Latest news" }: { now: Date; excludeUrls?: string[]; title?: string }) {
  const db = getDb();
  const { items, sections } = await cached(["rail"], [TAG_FEED], async () => ({ items: (await listFeed(db, now, { limit: 14 })).items, sections: await listSections(db) }));
  const latest = items.filter((i) => !excludeUrls.includes(i.url)).slice(0, 8);
  return (
    <aside className="rail" aria-label="More from India Health News">
      {latest.length > 0 && (
        <section aria-labelledby="rail-latest">
          <h2 id="rail-latest" className="rail-title">
            {title}
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
      <section aria-labelledby="rail-sections">
        <h2 id="rail-sections" className="rail-title">
          Sections
        </h2>
        <ul className="rail-links">
          {sections.map((s) => (
            <li key={s.slug}>
              <Link href={`/section/${s.slug}`}>{s.name}</Link>
            </li>
          ))}
          <li>
            <Link href="/states">States and union territories</Link>
          </li>
        </ul>
      </section>
      <section className="rail-cta" aria-labelledby="rail-submit">
        <h2 id="rail-submit">Have health news to share?</h2>
        <p>Press releases, research and tips go to an editor before anything is published.</p>
        <Link className="button primary" href="/submit-news">
          Submit news
        </Link>
      </section>
    </aside>
  );
}

/** Main column plus the rail. The rail drops below the content on narrow screens. */
export function WithRail({ children, now, excludeUrls }: { children: React.ReactNode; now: Date; excludeUrls?: string[] }) {
  return (
    <div className="with-rail">
      <div className="main-col">{children}</div>
      <Rail now={now} excludeUrls={excludeUrls} />
    </div>
  );
}
