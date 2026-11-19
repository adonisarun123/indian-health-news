/**
 * Published projection (DB-02). Every public read goes through this module.
 *
 * It exposes only public versions, checks suppression at query time and
 * re-checks rights on each read, so an expired grant or a removal takes
 * effect even if a sweep or cache purge is late. Drafts are unreachable here.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { articleCitations, articles, articleVersions, people, redirects, sourceItems, sources } from "@/db/schema";
import { activeSuppression } from "./audit";
import { loadCurrentGrant } from "./cards";
import { type FeedItem, listFeed } from "./reader";

export type PublicFeedItem = FeedItem;

/** Kept for callers that only need the items. See `listFeed` for pagination and filters. */
export async function listPublicFeed(db: Db, now: Date, opts: { limit?: number; cursor?: { visibleFrom: Date; id: string }; channel?: string } = {}): Promise<PublicFeedItem[]> {
  return (await listFeed(db, now, opts)).items;
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
  publicVersionId: string;
  slug: string;
  type: (typeof articles.$inferSelect)["type"];
  headline: string;
  standfirst: string;
  body: unknown;
  language: string;
  author: { name: string; slug: string; hasProfile: boolean } | null;
  sourceAuthorLabel: string | null;
  /** Set when the story reproduces an official release word for word: the original's address. */
  canonicalUrl: string | null;
  publishedAt: Date;
  modifiedAt: Date | null;
  correctionNote: string | null;
  /** Every public story is indexable, partner copies included (publisher decision, 19 Nov 2026). */
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
      publicVersionId: a.publicVersionId,
      slug: a.slug,
      type: a.type,
      headline: v!.headline,
      standfirst: v!.standfirst,
      body: v!.body,
      language: v!.language,
      author: author ? { name: author.displayName, slug: author.slug, hasProfile: author.hasPublicProfile && author.status === "active" } : null,
      sourceAuthorLabel: v!.sourceAuthorLabel,
      canonicalUrl: a.canonicalUrl,
      publishedAt: a.firstPublishedAt,
      modifiedAt: a.modifiedAt,
      correctionNote: a.modifiedAt ? v!.correctionNote : null,
      robots: a.isIndexable ? "index" : "noindex",
      hasImage: Boolean(v!.leadAssetId) && imagesAllowed,
      citations: cites.map((c) => ({ url: c.url, label: c.label, publisher: c.publisherName, isPrimary: c.isPrimary })),
    },
  };
}
