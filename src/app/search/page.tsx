import { and, asc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { sources, terms } from "@/db/schema";
import { listSections, listTermsWithContent, searchPublic, type SearchOptions } from "@/core/reader";
import { FeedList } from "@/components/Feed";
import { first, pageMeta } from "@/lib/page";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// Public search and arbitrary filter combinations are never indexed (WEB-01 URL map).
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Search", description: "Search reports and source updates by title, topic, source and state.", path: "/search", indexable: false });
}

type Params = { q: string; state?: string; section?: string; source?: string; sort?: string; page?: number };

function href(p: Params): string {
  const u = new URLSearchParams();
  if (p.q) u.set("q", p.q);
  if (p.state) u.set("state", p.state);
  if (p.section) u.set("section", p.section);
  if (p.source) u.set("source", p.source);
  if (p.sort === "latest") u.set("sort", "latest");
  if (p.page && p.page > 1) u.set("page", String(p.page));
  const qs = u.toString();
  return qs ? `/search?${qs}` : "/search";
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const p: Params = {
    q: (first(sp.q) ?? "").slice(0, 200).trim(),
    state: first(sp.state) || undefined,
    section: first(sp.section) || undefined,
    source: first(sp.source) || undefined,
    sort: first(sp.sort) === "latest" ? "latest" : undefined,
    page: Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1),
  };
  const db = getDb();
  const now = new Date();
  const sections = await listSections(db);
  const states = await listTermsWithContent(db, "state", now);
  const publishers = await db.select({ slug: sources.slug, name: sources.displayName }).from(sources).where(inArray(sources.status, ["enabled", "paused"])).orderBy(asc(sources.displayName));

  // Unknown filter values are ignored rather than trusted.
  const [state] = p.state ? await db.select().from(terms).where(and(eq(terms.kind, "state"), eq(terms.slug, p.state))) : [];
  const [section] = p.section ? await db.select().from(terms).where(and(eq(terms.kind, "section"), eq(terms.slug, p.section))) : [];
  const [source] = p.source ? await db.select().from(sources).where(and(eq(sources.slug, p.source), inArray(sources.status, ["enabled", "paused"]))) : [];
  const opts: SearchOptions = { q: p.q, sort: p.sort === "latest" ? "latest" : "relevance", stateId: state?.id, sectionId: section?.id, sourceId: source?.id, page: p.page };
  const result = p.q ? await searchPublic(db, now, opts) : null;
  const filtered = Boolean(state || section || source);
  // With little coverage in a state, offer the same search across India (WEB-03).
  const national = result && state && result.total < 3 ? await searchPublic(db, now, { ...opts, stateId: undefined, page: 1, pageSize: 5 }) : null;

  const chips = [
    state && { label: `State: ${state.name}`, to: href({ ...p, state: undefined, page: 1 }) },
    section && { label: `Section: ${section.name}`, to: href({ ...p, section: undefined, page: 1 }) },
    source && { label: `Source: ${source.displayName}`, to: href({ ...p, source: undefined, page: 1 }) },
  ].filter((c): c is { label: string; to: string } => Boolean(c));

  return (
    <>
      <h1 className="page-title">Search</h1>
      <form action="/search" method="get" role="search">
        <div className="search-form">
          <label className="visually-hidden" htmlFor="q">
            Search reports and source updates
          </label>
          <input id="q" name="q" type="search" defaultValue={p.q} placeholder="Title, topic, source or state" autoComplete="off" enterKeyHint="search" />
          <button className="button primary" type="submit">
            Search
          </button>
        </div>
        <details className="filters" open={filtered || p.sort === "latest"}>
          <summary>Filters{chips.length > 0 ? ` (${chips.length} active)` : ""}</summary>
          <div className="filters-body">
            <div className="field">
              <label htmlFor="state">State or union territory</label>
              <select id="state" name="state" defaultValue={state?.slug ?? ""}>
                <option value="">All of India</option>
                {states.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="section">Section</label>
              <select id="section" name="section" defaultValue={section?.slug ?? ""}>
                <option value="">All sections</option>
                {sections.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="source">Source</label>
              <select id="source" name="source" defaultValue={source?.slug ?? ""}>
                <option value="">All sources</option>
                {publishers.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="sort">Sort by</label>
              <select id="sort" name="sort" defaultValue={p.sort ?? "relevance"}>
                <option value="relevance">Relevance</option>
                <option value="latest">Latest</option>
              </select>
            </div>
            <button className="button primary" type="submit">
              Apply
            </button>
          </div>
        </details>
      </form>

      {chips.length > 0 && (
        <ul className="chips" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.label}>
              <Link className="remove" href={c.to} aria-label={`Remove filter ${c.label}`}>
                {c.label}
              </Link>
            </li>
          ))}
          <li>
            <Link href={href({ q: p.q })}>Reset filters</Link>
          </li>
        </ul>
      )}

      {!result && <p className="note">Search by headline, topic, source publisher or state. Try “reporting calendar” or a state name.</p>}

      {result && (
        <section aria-labelledby="results-heading">
          <h2 id="results-heading" className="result-count" role="status">
            {result.total === 0 ? `No results for “${p.q}”` : `${result.total} ${result.total === 1 ? "result" : "results"} for “${p.q}”`}
            {result.pages > 1 && `, page ${result.page} of ${result.pages}`}
          </h2>
          {result.total === 0 && (
            <div className="note">
              <p>Check the spelling, try fewer words or search for a state or publisher name.</p>
              <p style={{ marginTop: "0.5rem" }}>
                {filtered && (
                  <>
                    <Link href={href({ q: p.q })}>Search all of India without filters</Link> ·{" "}
                  </>
                )}
                <Link href="/latest">Browse the latest updates</Link>
              </p>
            </div>
          )}
          {result.items.length > 0 && <FeedList items={result.items} now={now} />}
          {result.pages > 1 && (
            <nav className="pager" aria-label="Pagination">
              {result.page > 1 ? (
                <Link className="button" rel="prev" href={href({ ...p, page: result.page - 1 })}>
                  Previous
                </Link>
              ) : (
                <span />
              )}
              {result.page < result.pages && (
                <Link className="button" rel="next" href={href({ ...p, page: result.page + 1 })}>
                  Next
                </Link>
              )}
            </nav>
          )}
        </section>
      )}

      {national && national.total > result!.total && (
        <section aria-labelledby="national-heading">
          <h2 id="national-heading" className="section-title">
            From across India
          </h2>
          <p className="meta" style={{ marginBottom: "1rem" }}>
            There is little coverage in {state!.name} for this search. These results are from all states.
          </p>
          <FeedList items={national.items} now={now} />
          <p style={{ marginTop: "1rem" }}>
            <Link className="button" href={href({ ...p, state: undefined, page: 1 })}>
              See all {national.total} results
            </Link>
          </p>
        </section>
      )}
    </>
  );
}
