/**
 * Published projection (DB-02). Every public read goes through this module.
 *
 * It exposes only public versions, checks suppression at query time and
 * re-checks rights on each read, so an expired grant or a removal takes
 * effect even if a sweep or cache purge is late. Drafts are unreachable here.
 */
import { and, asc, desc, eq, lt, lte, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { articleCitations, articles, articleVersions, feedEntries, people, redirects, sourceItems, sources } from "@/db/schema";
import { activeSuppression } from "./audit";
import { loadCurrentGrant } from "./cards";

export interface PublicFeedItem {
  id: string;
  kind: "source_card" | "article";
  title: string;
  publisher: string;
  /** External publisher URL for a card; local path for an article. */
  url: string;
  visibleFrom: Date;
  isExternal: boolean;
}

export async function listPublicFeed(
  db: Db,
  now: Date,
  opts: { limit?: number; cursor?: { visibleFrom: Date; id: string }; channel?: string } = {},
): Promise<PublicFeedItem[]> {
  const limit = opts.limit ?? 20;
  const channel = opts.channel ?? "web";
  const out: PublicFeedItem[] = [];
  const grantCache = new Map<string, boolean>();
  const sourceOk = async (sourceId: string) => {
    if (!grantCache.has(sourceId)) {
      const [s] = await db.select().from(sources).where(eq(sources.id, sourceId));
      const grant = s && s.status !== "revoked" ? await loadCurrentGrant(db, sourceId, now) : null;
      grantCache.set(sourceId, Boolean(grant?.channels.includes(channel)));
    }
    return grantCache.get(sourceId)!;
  };

  let cursor = opts.cursor;
  while (out.length < limit) {
    const page = await db
      .select()
      .from(feedEntries)
      .where(
        and(
          eq(feedEntries.status, "active"),
          lte(feedEntries.visibleFrom, now),
          cursor ? or(lt(feedEntries.visibleFrom, cursor.visibleFrom), and(eq(feedEntries.visibleFrom, cursor.visibleFrom), lt(feedEntries.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(feedEntries.visibleFrom), desc(feedEntries.id))
      .limit(limit * 2);
    if (page.length === 0) break;
    for (const e of page) {
      cursor = { visibleFrom: e.visibleFrom, id: e.id };
      if (!e.scope.includes(channel)) continue;
      if (e.kind === "source_card") {
        const [item] = await db.select().from(sourceItems).where(eq(sourceItems.id, e.sourceItemId!));
        if (!item || item.status !== "active") continue;
        if (await activeSuppression(db, "source_item", item.id)) continue;
        if (!(await sourceOk(item.sourceId))) continue;
      } else {
        const [a] = await db.select().from(articles).where(eq(articles.id, e.articleId!));
        if (!a?.publicVersionId) continue;
        if (await activeSuppression(db, "article", a.id)) continue;
        if (a.type === "licensed_copy" && !(await licensedRightsOk(db, a, now))) continue;
      }
      out.push({ id: e.id, kind: e.kind, title: e.displayTitle, publisher: e.publisherName, url: e.targetUrl, visibleFrom: e.visibleFrom, isExternal: e.kind === "source_card" });
      if (out.length >= limit) break;
    }
    if (page.length < limit * 2) break;
  }
  return out;
}

async function licensedRightsOk(db: Db, a: typeof articles.$inferSelect, now: Date): Promise<boolean> {
  if (!a.sourceItemId) return false;
  const [row] = await db.select({ s: sources }).from(sourceItems).innerJoin(sources, eq(sources.id, sourceItems.sourceId)).where(eq(sourceItems.id, a.sourceItemId));
  if (!row || row.s.status !== "enabled") return false;
  const grant = await loadCurrentGrant(db, row.s.id, now);
  return Boolean(grant && grant.id === a.grantId && grant.allowFullText && grant.channels.includes("web"));
}

export type PublicArticleResult =
  | { kind: "ok"; article: PublicArticle }
  | { kind: "redirect"; slug: string }
  | { kind: "retracted"; slug: string; note: string | null; date: Date }
  | { kind: "gone"; status: 410 | 451 }
  | { kind: "not_found" };

export interface PublicArticle {
  id: string;
  slug: string;
  type: (typeof articles.$inferSelect)["type"];
  headline: string;
  standfirst: string;
  body: unknown;
  language: string;
  author: { name: string; slug: string } | null;
  sourceAuthorLabel: string | null;
  publishedAt: Date;
  modifiedAt: Date | null;
  correctionNote: string | null;
  /** Licensed copies are always noindex. */
  robots: "index" | "noindex";
  hasImage: boolean;
  citations: { url: string; label: string; publisher: string; isPrimary: boolean }[];
}

export async function getPublicArticle(db: Db, slug: string, now: Date, locale = "en-IN"): Promise<PublicArticleResult> {
  const [a] = await db.select().from(articles).where(and(eq(articles.locale, locale), eq(articles.slug, slug)));
  if (!a) {
    const [r] = await db.select({ slug: articles.slug }).from(redirects).innerJoin(articles, eq(articles.id, redirects.articleId)).where(and(eq(redirects.locale, locale), eq(redirects.fromSlug, slug)));
    return r ? { kind: "redirect", slug: r.slug } : { kind: "not_found" };
  }
  if (!a.publicVersionId || !a.firstPublishedAt) return { kind: "not_found" };

  const s = await activeSuppression(db, "article", a.id);
  if (s) {
    if (s.kind === "removal_451") return { kind: "gone", status: 451 };
    if (s.kind === "retraction") return { kind: "retracted", slug: a.slug, note: s.publicNote, date: s.createdAt };
    if (s.kind === "risk_hold") return { kind: "not_found" };
    return { kind: "gone", status: 410 };
  }
  let imagesAllowed = true;
  if (a.type === "licensed_copy") {
    if (!(await licensedRightsOk(db, a, now))) return { kind: "gone", status: 410 };
    const [item] = await db.select().from(sourceItems).where(eq(sourceItems.id, a.sourceItemId!));
    imagesAllowed = Boolean((await loadCurrentGrant(db, item!.sourceId, now))?.allowImages);
  }

  const [v] = await db.select().from(articleVersions).where(eq(articleVersions.id, a.publicVersionId));
  const cites = await db.select().from(articleCitations).where(eq(articleCitations.versionId, a.publicVersionId)).orderBy(asc(articleCitations.position));
  const [author] = v!.authorPersonId ? await db.select().from(people).where(eq(people.id, v!.authorPersonId)) : [];
  return {
    kind: "ok",
    article: {
      id: a.id,
      slug: a.slug,
      type: a.type,
      headline: v!.headline,
      standfirst: v!.standfirst,
      body: v!.body,
      language: v!.language,
      author: author ? { name: author.displayName, slug: author.slug } : null,
      sourceAuthorLabel: v!.sourceAuthorLabel,
      publishedAt: a.firstPublishedAt,
      modifiedAt: a.modifiedAt,
      correctionNote: a.modifiedAt ? v!.correctionNote : null,
      robots: a.isIndexable && a.type !== "licensed_copy" ? "index" : "noindex",
      hasImage: Boolean(v!.leadAssetId) && imagesAllowed,
      citations: cites.map((c) => ({ url: c.url, label: c.label, publisher: c.publisherName, isPrimary: c.isPrimary })),
    },
  };
}
