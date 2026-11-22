/**
 * Reader-site queries (WEB-01..04, DB-02). Part of the published projection.
 *
 * One SQL definition decides what is public: active feed entries whose
 * article or source item is unsuppressed and whose grant is in force at the
 * time of the read. Listings, hubs, profiles and search all build on it, so a
 * removal or an expired grant disappears from every surface at once.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { approvals, articles, articleTerms, breakingStrips, people, searchSynonyms, sources, termAliases, terms } from "@/db/schema";
import { getFlags } from "./audit";

export interface FeedItem {
  id: string;
  kind: "source_card" | "article";
  title: string;
  publisher: string;
  /** External publisher URL for a card; local path for an article. */
  url: string;
  visibleFrom: Date;
  isExternal: boolean;
  articleType: string | null;
  standfirst: string | null;
  author: { name: string; slug: string } | null;
  /** A verbatim official release: credited to its publisher, never to a staff byline. */
  reproducedFrom: string | null;
  /** Shown on cards in place of the standfirst for a reproduced release. `excerpt` is the release's own opening words. */
  release: { issuer: string | null; words: number; excerpt: string | null } | null;
  section: { name: string; slug: string } | null;
  state: { name: string; slug: string } | null;
  /** The publisher's own publication time, shown on source cards. */
  sourcePublishedAt: Date | null;
  sourceSlug: string | null;
  modifiedAt: Date | null;
}

export interface Cursor {
  visibleFrom: Date;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return `${c.visibleFrom.getTime()}_${c.id}`;
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  const m = raw?.match(/^(\d{10,16})_([0-9a-f-]{36})$/);
  return m ? { visibleFrom: new Date(Number(m[1])), id: m[2]! } : undefined;
}

type Row = Record<string, unknown>;

const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** A grant is in force when the highest effective version is unrevoked, unexpired and covers the channel. */
function grantInForce(now: Date, channel: string, extra: SQL = sql`true`): SQL {
  return sql`exists (
    select 1 from source_grants g
    where g.source_id = s.id
      and g.version = (select max(g2.version) from source_grants g2 where g2.source_id = s.id and g2.effective_at <= ${iso(now)})
      and (g.revoked_at is null or g.revoked_at > ${iso(now)})
      and (g.expires_at is null or g.expires_at > ${iso(now)})
      and g.basis <> 'unknown'
      and ${channel} = any(g.channels)
      and ${extra})`;
}

const notSuppressed = (type: "article" | "source_item", idCol: SQL) =>
  sql`not exists (select 1 from suppressions x where x.subject_type = ${type} and x.subject_id = ${idCol} and x.lifted_at is null)`;

/** The published projection as a FROM/WHERE fragment. Aliases: fe, a, v, p, si, s, sr. */
function publicFeed(now: Date, channel: string, joins: SQL = sql``): SQL {
  return sql`
    from feed_entries fe
    left join articles a on a.id = fe.article_id
    left join article_versions v on v.id = a.public_version_id
    left join people p on p.id = v.author_person_id
    left join source_items si on si.id = coalesce(fe.source_item_id, a.source_item_id)
    left join sources s on s.id = si.source_id
    left join source_revisions sr on sr.id = fe.source_revision_id
    ${joins}
    where fe.status = 'active'
      and fe.visible_from <= ${iso(now)}
      and ${channel} = any(fe.scope)
      and (fe.kind <> 'article' or (
            a.public_version_id is not null
        and ${notSuppressed("article", sql`a.id`)}

        and (a.type <> 'licensed_copy' or (s.status = 'enabled' and ${grantInForce(now, "web", sql`g.id = a.grant_id and g.allow_full_text`)}))))
      and (fe.kind <> 'source_card' or (
            si.status = 'active'
        and s.status <> 'revoked'
        and ${notSuppressed("source_item", sql`si.id`)}
        and ${grantInForce(now, channel)}))`;
}

const COLUMNS = sql`
  fe.id, fe.kind, fe.display_title, fe.publisher_name, fe.target_url, fe.visible_from,
  a.type as article_type, a.modified_at, v.standfirst,
  p.display_name as author_name, p.slug as author_slug, p.has_public_profile as author_public,
  case when a.canonical_url is not null then (select c.publisher_name from article_citations c where c.version_id = v.id and c.is_primary limit 1) end as reproduced_from,
  a.source_issuer, case when a.canonical_url is not null then coalesce(array_length(regexp_split_to_array(btrim(v.body_text), '\s+'), 1), 0) end as release_words,
  case when a.canonical_url is not null then left(btrim(v.body_text), 480) end as release_head,
  sr.source_published_at, s.slug as source_slug,
  sec.slug as section_slug, sec.name as section_name,
  st.slug as state_slug, st.name as state_name`;

/** Primary section, and the first state: an article's own term or a card's source jurisdiction. */
const TAXONOMY = sql`
  left join lateral (
    select t.slug, t.name from article_terms x join terms t on t.id = x.term_id
    where x.article_id = a.id and x.is_primary_section limit 1) sec on true
  left join lateral (
    select t.slug, t.name from terms t
    where t.kind = 'state' and (
      (fe.kind = 'article' and t.id in (select x.term_id from article_terms x where x.article_id = a.id))
      or (fe.kind = 'source_card' and t.id = s.jurisdiction_term_id))
    order by t.name limit 1) st on true`;

/**
 * The opening of a reproduced release, cut at a sentence end where one falls
 * in range and at a word otherwise. The words are the issuer's own: nothing
 * is rewritten. Honorifics such as "Smt." and "Dr." do not count as an end.
 */
export function excerptOf(head: string | null, max = 220): string | null {
  const flat = (head ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const window = flat.slice(0, max);
  const ends = [...window.matchAll(/(?<=[a-z0-9)\]’”"]{3})[.!?](?=\s+[A-Z0-9“"‘(])/g)].map((m) => m.index).filter((i) => i >= 80);
  if (ends.length > 0) return window.slice(0, ends[0]! + 1);
  return `${window.slice(0, window.lastIndexOf(" ")).replace(/[\s,;:–—-]+$/, "")}…`;
}

function toItem(r: Row): FeedItem {
  const kind = r.kind as FeedItem["kind"];
  return {
    id: r.id as string,
    kind,
    title: r.display_title as string,
    publisher: r.publisher_name as string,
    url: r.target_url as string,
    visibleFrom: new Date(r.visible_from as string),
    isExternal: kind === "source_card",
    articleType: (r.article_type as string) ?? null,
    standfirst: (r.standfirst as string) || null,
    reproducedFrom: (r.reproduced_from as string) ?? null,
    release: r.reproduced_from ? { issuer: (r.source_issuer as string) ?? null, words: Number(r.release_words ?? 0), excerpt: excerptOf((r.release_head as string) ?? null) } : null,
    author: r.reproduced_from ? null : r.author_name && r.author_public ? { name: r.author_name as string, slug: r.author_slug as string } : r.author_name ? { name: r.author_name as string, slug: "" } : null,
    section: r.section_slug ? { name: r.section_name as string, slug: r.section_slug as string } : null,
    state: r.state_slug ? { name: r.state_name as string, slug: r.state_slug as string } : null,
    sourcePublishedAt: r.source_published_at ? new Date(r.source_published_at as string) : null,
    sourceSlug: (r.source_slug as string) ?? null,
    modifiedAt: r.modified_at ? new Date(r.modified_at as string) : null,
  };
}

export interface FeedFilter {
  /** Section, state or topic term. Cards match a state through their source's jurisdiction. */
  termId?: string;
  kind?: "source_card" | "article";
  /** Original and analysis work only: excludes cards, press material and partner copies. */
  originalsOnly?: boolean;
  authorId?: string;
  /** The credited publisher on a card, or a cited source on an original report (WEB-04). */
  sourceId?: string;
  excludeArticleId?: string;
}

function filterSql(f: FeedFilter): SQL {
  const parts: SQL[] = [];
  if (f.termId) {
    parts.push(sql`((fe.kind = 'article' and exists (select 1 from article_terms x where x.article_id = a.id and x.term_id = ${f.termId}))
                 or (fe.kind = 'source_card' and s.jurisdiction_term_id = ${f.termId}))`);
  }
  if (f.kind) parts.push(sql`fe.kind = ${f.kind}`);
  if (f.originalsOnly) parts.push(sql`fe.kind = 'article' and a.type in ('original_brief', 'original_report', 'analysis')`);
  if (f.authorId) parts.push(sql`v.author_person_id = ${f.authorId} and a.canonical_url is null`);
  if (f.excludeArticleId) parts.push(sql`(a.id is null or a.id <> ${f.excludeArticleId})`);
  if (f.sourceId) {
    parts.push(sql`((fe.kind = 'source_card' and s.id = ${f.sourceId})
      or (fe.kind = 'article' and exists (
            select 1 from article_citations c
            left join source_revisions cr on cr.id = c.source_revision_id
            left join source_items ci on ci.id = cr.item_id
            where c.version_id = a.public_version_id
              and (ci.source_id = ${f.sourceId} or c.publisher_name = (select display_name from sources where id = ${f.sourceId})))))`);
  }
  return parts.length ? sql.join(parts.map((p) => sql`and ${p}`), sql` `) : sql``;
}

/** Chronological listing with keyset pagination on (visible_from, id): stable while new items arrive. */
export async function listFeed(
  db: Db,
  now: Date,
  opts: FeedFilter & { limit?: number; cursor?: Cursor; channel?: string } = {},
): Promise<{ items: FeedItem[]; next: Cursor | null }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const after = opts.cursor ? sql`and (fe.visible_from, fe.id) < (${iso(opts.cursor.visibleFrom)}, ${opts.cursor.id}::uuid)` : sql``;
  const res = await db.execute<Row>(sql`
    select ${COLUMNS}
    from (select fe.id as fid ${publicFeed(now, opts.channel ?? "web")} ${filterSql(opts)} ${after}
          order by fe.visible_from desc, fe.id desc limit ${limit + 1}) page
    join feed_entries fe on fe.id = page.fid
    left join articles a on a.id = fe.article_id
    left join article_versions v on v.id = a.public_version_id
    left join people p on p.id = v.author_person_id
    left join source_items si on si.id = coalesce(fe.source_item_id, a.source_item_id)
    left join sources s on s.id = si.source_id
    left join source_revisions sr on sr.id = fe.source_revision_id
    ${TAXONOMY}
    order by fe.visible_from desc, fe.id desc`);
  const items = res.rows.slice(0, limit).map(toItem);
  const last = items[items.length - 1];
  return { items, next: res.rows.length > limit && last ? { visibleFrom: last.visibleFrom, id: last.id } : null };
}

export async function countFeed(db: Db, now: Date, f: FeedFilter = {}): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`select count(*) as n ${publicFeed(now, "web")} ${filterSql(f)}`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Homepage lead: editorial importance first, then the newest original report (WEB-01). */
export async function getLead(db: Db, now: Date): Promise<FeedItem | null> {
  const res = await db.execute<{ fid: string }>(sql`
    select fe.id as fid ${publicFeed(now, "web")}
      and fe.kind = 'article' and a.type in ('original_brief', 'original_report', 'analysis')
    order by (case when a.lead_rank is not null and (a.lead_until is null or a.lead_until > ${iso(now)}) then a.lead_rank else 0 end) desc,
             fe.visible_from desc, fe.id desc
    limit 1`);
  const fid = res.rows[0]?.fid;
  if (!fid) return null;
  return feedItemById(db, now, fid);
}

async function feedItemById(db: Db, now: Date, fid: string): Promise<FeedItem | null> {
  const res = await db.execute<Row>(sql`select ${COLUMNS} from (select fe.id as fid ${publicFeed(now, "web")} and fe.id = ${fid}) page
    join feed_entries fe on fe.id = page.fid
    left join articles a on a.id = fe.article_id
    left join article_versions v on v.id = a.public_version_id
    left join people p on p.id = v.author_person_id
    left join source_items si on si.id = coalesce(fe.source_item_id, a.source_item_id)
    left join sources s on s.id = si.source_id
    left join source_revisions sr on sr.id = fe.source_revision_id
    ${TAXONOMY}`);
  return res.rows[0] ? toItem(res.rows[0]) : null;
}

/** An unexpired strip whose story is still public. */
export async function getBreaking(db: Db, now: Date): Promise<{ text: string; url: string } | null> {
  const rows = await db.select().from(breakingStrips).where(sql`${breakingStrips.startsAt} <= ${iso(now)} and ${breakingStrips.expiresAt} > ${iso(now)}`);
  for (const strip of rows.sort((x, y) => y.startsAt.getTime() - x.startsAt.getTime())) {
    const live = await db.execute<{ target_url: string }>(sql`select fe.target_url ${publicFeed(now, "web")} and fe.article_id = ${strip.articleId} limit 1`);
    if (live.rows[0]) return { text: strip.text, url: live.rows[0].target_url };
  }
  return null;
}

/* ───────────── hubs and profiles ───────────── */

export type TermKind = "section" | "state" | "topic";

/** Hub review starts at five relevant original stories plus an editor-written introduction (WEB-02). */
export const HUB_MIN_ORIGINALS = Number(process.env.HUB_MIN_ORIGINALS ?? 5);

export type HubResult =
  | { kind: "ok"; term: typeof terms.$inferSelect; originals: number; indexable: boolean }
  | { kind: "redirect"; slug: string }
  | { kind: "not_found" };

export async function getHub(db: Db, kind: TermKind, slug: string, now: Date): Promise<HubResult> {
  const [term] = await db.select().from(terms).where(and(eq(terms.kind, kind), eq(terms.slug, slug)));
  if (!term) {
    // Renamed places and common spellings resolve to the canonical hub.
    const wanted = slug.replace(/-/g, " ");
    const [alias] = await db
      .select({ slug: terms.slug })
      .from(termAliases)
      .innerJoin(terms, eq(terms.id, termAliases.termId))
      .where(and(eq(terms.kind, kind), sql`lower(${termAliases.alias}) = ${wanted}`));
    return alias ? { kind: "redirect", slug: alias.slug } : { kind: "not_found" };
  }
  const originals = await countFeed(db, now, { termId: term.id, originalsOnly: true });
  const flags = await getFlags(db);
  // Any hub with public material is indexable. An empty hub would be a soft 404, so it stays out.
  const indexable = Boolean(flags.indexing) && (await countFeed(db, now, { termId: term.id })) > 0;
  return { kind: "ok", term, originals, indexable };
}

/** Terms that currently have public material, for navigation and discovery. Empty hubs are not linked. */
export async function listTermsWithContent(db: Db, kind: TermKind, now: Date): Promise<{ slug: string; name: string; count: number }[]> {
  const res = await db.execute<{ slug: string; name: string; n: string }>(sql`
    select t.slug, t.name, count(*) as n
    from terms t
    join lateral (
      select fe.id ${publicFeed(now, "web")}
        and ((fe.kind = 'article' and exists (select 1 from article_terms x where x.article_id = a.id and x.term_id = t.id))
          or (fe.kind = 'source_card' and s.jurisdiction_term_id = t.id))) hit on true
    where t.kind = ${kind}
    group by t.slug, t.name
    order by t.name`);
  return res.rows.map((r) => ({ slug: r.slug, name: r.name, count: Number(r.n) }));
}

export async function listSections(db: Db): Promise<{ id: string; slug: string; name: string }[]> {
  const order = ["public-health", "policy", "research", "medicines-devices", "healthcare-delivery"];
  const rows = await db.select({ id: terms.id, slug: terms.slug, name: terms.name }).from(terms).where(eq(terms.kind, "section"));
  return rows.sort((a, b) => (order.indexOf(a.slug) + 99) % 99 - (order.indexOf(b.slug) + 99) % 99);
}

export interface AuthorProfile {
  id: string;
  slug: string;
  name: string;
  bio: string | null;
  credentials: string | null;
  conflicts: string | null;
  roles: string[];
  reviews: number;
}

/** Public staff profile. Only people who opted into a public profile are reachable. */
export async function getAuthor(db: Db, slug: string): Promise<AuthorProfile | null> {
  const [p] = await db.select().from(people).where(and(eq(people.slug, slug), eq(people.hasPublicProfile, true), eq(people.status, "active")));
  if (!p) return null;
  const roles = await db.execute<{ role: string }>(sql`select role from memberships where person_id = ${p.id} and revoked_at is null`);
  const reviewed = await db
    .select({ id: approvals.id })
    .from(approvals)
    .innerJoin(articles, eq(articles.publicVersionId, approvals.versionId))
    .where(and(eq(approvals.reviewerPersonId, p.id), eq(approvals.kind, "medical"), eq(approvals.decision, "approved")));
  return { id: p.id, slug: p.slug, name: p.displayName, bio: p.bio, credentials: p.credentials, conflicts: p.conflicts, roles: roles.rows.map((r) => r.role), reviews: reviewed.length };
}

export interface SourceProfile {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  homepageUrl: string;
  family: string;
  state: { name: string; slug: string } | null;
  status: string;
}

/** Publisher profile. Proposed, under-review and revoked records stay private. */
export async function getSourceProfile(db: Db, slug: string): Promise<SourceProfile | null> {
  const [s] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!s || (s.status !== "enabled" && s.status !== "paused")) return null;
  const [state] = s.jurisdictionTermId ? await db.select().from(terms).where(eq(terms.id, s.jurisdictionTermId)) : [];
  return { id: s.id, slug: s.slug, name: s.displayName, legalName: s.legalName, homepageUrl: s.homepageUrl, family: s.family, state: state ? { name: state.name, slug: state.slug } : null, status: s.status };
}

/** Material corrections, newest first, for the public corrections page (COR-01, GOV-02). */
export async function listCorrections(db: Db, now: Date, limit = 50): Promise<{ title: string; url: string; note: string; correctedAt: Date }[]> {
  const res = await db.execute<Row>(sql`
    select fe.display_title, fe.target_url, v.correction_note, a.modified_at ${publicFeed(now, "web")}
      and fe.kind = 'article' and a.modified_at is not null and v.correction_note is not null
    order by a.modified_at desc limit ${limit}`);
  return res.rows.map((r) => ({ title: r.display_title as string, url: r.target_url as string, note: r.correction_note as string, correctedAt: new Date(r.modified_at as string) }));
}

/** Taxonomy and review details for an article page. */
export async function getArticleContext(db: Db, articleId: string, publicVersionId: string) {
  const termRows = await db
    .select({ id: terms.id, kind: terms.kind, slug: terms.slug, name: terms.name, primary: articleTerms.isPrimarySection })
    .from(articleTerms)
    .innerJoin(terms, eq(terms.id, articleTerms.termId))
    .where(eq(articleTerms.articleId, articleId));
  const [review] = await db
    .select({ name: people.displayName, slug: people.slug, isPublic: people.hasPublicProfile, specialty: approvals.specialty, at: approvals.createdAt })
    .from(approvals)
    .innerJoin(people, eq(people.id, approvals.reviewerPersonId))
    .where(and(eq(approvals.versionId, publicVersionId), eq(approvals.kind, "medical"), eq(approvals.decision, "approved")));
  return {
    section: termRows.find((t) => t.primary) ?? null,
    states: termRows.filter((t) => t.kind === "state"),
    topics: termRows.filter((t) => t.kind === "topic"),
    medicalReview: review ?? null,
  };
}

/* ───────────── search (WEB-03, WEB-04) ───────────── */

export interface SearchOptions {
  q: string;
  sort?: "relevance" | "latest";
  stateId?: string;
  sectionId?: string;
  sourceId?: string;
  page?: number;
  pageSize?: number;
}

export const SEARCH_MAX_PAGE = 50;

/** Words a reader typed, lower-cased with accents removed. Capped so a query cannot grow unbounded. */
export function searchTokens(q: string): string[] {
  return q
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .slice(0, 8);
}

/** Build a tsquery: every word must match, and each word also matches its registered spellings. */
export async function buildTsQuery(db: Db, q: string): Promise<string | null> {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return null;
  const rows = await db.select().from(searchSynonyms).where(sql`${searchSynonyms.term} in ${tokens} or ${searchSynonyms.synonym} in ${tokens}`);
  const groups = tokens.map((t) => {
    const alts = new Set([t]);
    for (const r of rows) {
      if (r.term === t) alts.add(r.synonym);
      if (r.synonym === t) alts.add(r.term);
    }
    return `(${[...alts].filter((a) => /^[a-z0-9]+$/.test(a)).join(" | ")})`;
  });
  return groups.join(" & ");
}

export async function searchPublic(db: Db, now: Date, o: SearchOptions): Promise<{ items: FeedItem[]; total: number; page: number; pages: number }> {
  const pageSize = Math.min(o.pageSize ?? 20, 50);
  const page = Math.min(Math.max(o.page ?? 1, 1), SEARCH_MAX_PAGE);
  const tsq = await buildTsQuery(db, o.q);
  if (!tsq) return { items: [], total: 0, page: 1, pages: 0 };
  const phrase = `%${searchTokens(o.q).join(" ")}%`;
  const filter: FeedFilter = { sourceId: o.sourceId };
  const termFilter = [o.stateId, o.sectionId].filter(Boolean).map(
    (id) => sql`and ((fe.kind = 'article' and exists (select 1 from article_terms x where x.article_id = a.id and x.term_id = ${id}))
                  or (fe.kind = 'source_card' and s.jurisdiction_term_id = ${id}))`,
  );
  // Tier 3: the query appears in the headline. Tier 2: headline words or a topic match. Tier 1: body.
  const tier = sql`case
      when lower(fe.display_title) like ${phrase} then 3
      when setweight(to_tsvector('english', fe.display_title), 'A') @@ q.tsq or tm.hit then 2
      else 1 end`;
  const order = o.sort === "latest" ? sql`fe.visible_from desc, fe.id desc` : sql`tier desc, fe.visible_from desc, fe.id desc`;
  const res = await db.execute<Row>(sql`
    with q as (select to_tsquery('english', ${tsq}) as tsq)
    select ${COLUMNS}, hit.tier, hit.total
    from (
      select fe.id as fid, ${tier} as tier, count(*) over () as total
      ${publicFeed(now, "web", TERM_MATCH)}
        and (coalesce(v.search_tsv, fe.search_tsv) @@ q.tsq or tm.hit)
        ${filterSql(filter)} ${sql.join(termFilter, sql` `)}
      order by ${order}
      limit ${pageSize} offset ${(page - 1) * pageSize}) hit
    join feed_entries fe on fe.id = hit.fid
    left join articles a on a.id = fe.article_id
    left join article_versions v on v.id = a.public_version_id
    left join people p on p.id = v.author_person_id
    left join source_items si on si.id = coalesce(fe.source_item_id, a.source_item_id)
    left join sources s on s.id = si.source_id
    left join source_revisions sr on sr.id = fe.source_revision_id
    ${TAXONOMY}
    order by ${o.sort === "latest" ? sql`fe.visible_from desc, fe.id desc` : sql`hit.tier desc, fe.visible_from desc, fe.id desc`}`);
  const total = Number(res.rows[0]?.total ?? 0);
  return { items: res.rows.map(toItem), total, page, pages: Math.min(Math.ceil(total / pageSize), SEARCH_MAX_PAGE) };
}

/** Joins the parsed query and a flag for a section, state or topic name that matches it. */
const TERM_MATCH = sql`
  cross join q
  join lateral (
    select exists (
      select 1 from terms t
      where to_tsvector('english', t.name) @@ q.tsq and (
        (fe.kind = 'article' and t.id in (select x.term_id from article_terms x where x.article_id = a.id))
        or (fe.kind = 'source_card' and t.id = s.jurisdiction_term_id))) as hit) tm on true`;

/* ───────────── sitemaps (SEO-02) ───────────── */

export const NEWS_WINDOW_MS = 48 * 3600 * 1000;

export interface SitemapArticle {
  slug: string;
  title: string;
  publishedAt: Date;
  lastmod: Date;
}

/**
 * Indexable stories, oldest first so shard membership is stable.
 * `since` restricts to stories first published after that instant: a
 * correction never moves a story back into the news window.
 */
export async function listSitemapArticles(db: Db, now: Date, opts: { since?: Date; limit: number; offset: number }): Promise<SitemapArticle[]> {
  // The news window lists our own writing only; republished partner copies stay in the general sitemap.
  const since = opts.since ? sql`and a.first_published_at > ${iso(opts.since)} and a.type <> 'licensed_copy'` : sql``;
  const res = await db.execute<Row>(sql`
    select a.slug, fe.display_title, a.first_published_at, coalesce(a.modified_at, a.first_published_at) as lastmod
    ${publicFeed(now, "web")}
      and fe.kind = 'article' and a.is_indexable and a.canonical_url is null ${since}
    order by a.first_published_at asc, a.id asc
    limit ${opts.limit} offset ${opts.offset}`);
  return res.rows.map((r) => ({ slug: r.slug as string, title: r.display_title as string, publishedAt: new Date(r.first_published_at as string), lastmod: new Date(r.lastmod as string) }));
}

export async function countSitemapArticles(db: Db, now: Date, since?: Date): Promise<number> {
  const cond = since ? sql`and a.first_published_at > ${iso(since)} and a.type <> 'licensed_copy'` : sql``;
  const res = await db.execute<{ n: string }>(sql`select count(*) as n ${publicFeed(now, "web")} and fe.kind = 'article' and a.is_indexable and a.canonical_url is null ${cond}`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Hubs that qualify for the index: every section, state or topic with public material. */
export async function listIndexableHubs(db: Db, now: Date): Promise<{ kind: TermKind; slug: string }[]> {
  const out: { kind: TermKind; slug: string }[] = [];
  for (const t of await db.select().from(terms)) {
    if ((await countFeed(db, now, { termId: t.id })) > 0) out.push({ kind: t.kind, slug: t.slug });
  }
  return out;
}

/** Authors with a public profile and at least one public report. */
export async function listIndexableAuthors(db: Db, now: Date): Promise<string[]> {
  const rows = await db.select().from(people).where(and(eq(people.hasPublicProfile, true), eq(people.status, "active")));
  const out: string[] = [];
  for (const p of rows) if ((await countFeed(db, now, { authorId: p.id })) > 0) out.push(p.slug);
  return out;
}
