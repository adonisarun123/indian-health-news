/**
 * Editorial commands (ED-02, ED-04, ADM-01..03, COR-01, DB-03).
 *
 * Every state change takes the expected version and an idempotency key. A
 * stale write is a 409 carrying the current version; missing approvals or
 * rights are a 422 with field-level errors. Approvals bind to one exact
 * version, so any edit needs fresh sign-off before release.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "@/db/client";
import {
  approvals,
  articleCitations,
  articles,
  articleTerms,
  articleVersions,
  commandLog,
  feedEntries,
  memberships,
  redirects,
  reviewerCredentials,
  sourceGrants,
  sourceItems,
  sourceRevisions,
  sources,
  suppressions,
  terms,
} from "@/db/schema";
import { activeSuppression, audit, emit, getFlags, openTask } from "./audit";
import { loadCurrentGrant } from "./cards";
import { canonicalJson, sha256Hex } from "./crypto";
import { enqueue } from "./jobs";
import { checkArticlePublish, type FieldError, isIndexable } from "./policy";
import { assessRisk, type RiskRoute } from "./risk";

export const SITE_NAME = process.env.SITE_NAME ?? "India Health News";

export type StaffRole = (typeof memberships.$inferSelect)["role"];

export interface Actor {
  personId: string;
  roles: StaffRole[];
}

export async function loadActor(db: Db | Tx, personId: string): Promise<Actor> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.personId, personId), isNull(memberships.revokedAt)));
  return { personId, roles: rows.map((r) => r.role) };
}

export class CommandError extends Error {
  constructor(
    public status: 403 | 404 | 409 | 422,
    public code: string,
    message: string,
    public extra: { fieldErrors?: FieldError[]; currentVersion?: number } = {},
  ) {
    super(message);
  }
}

const has = (actor: Actor, ...roles: StaffRole[]) => actor.roles.some((r) => roles.includes(r));
/** Publishing needs an explicitly assigned editor role. Administrator alone is not enough (ADM-01). */
const canPublish = (actor: Actor) => has(actor, "editor", "managing_editor");

/* ───────────── input shapes ───────────── */

const block = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("paragraph"), text: z.string().min(1).max(5000) }),
  z.strictObject({ type: z.literal("heading"), text: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal("list"), ordered: z.boolean().default(false), items: z.array(z.string().min(1).max(1000)).min(1).max(50) }),
  z.strictObject({ type: z.literal("quote"), text: z.string().min(1).max(2000), attribution: z.string().max(300).optional() }),
]);
export type Block = z.infer<typeof block>;

const citation = z.strictObject({
  url: z.string().max(2048).refine((s) => s.startsWith("https://"), "must be a direct https link"),
  label: z.string().min(1).max(300),
  publisherName: z.string().min(1).max(200),
  isPrimary: z.boolean().default(false),
  sourceRevisionId: z.uuid().optional(),
});

const fields = {
  headline: z.string().min(1).max(200),
  standfirst: z.string().max(400),
  body: z.array(block).min(1).max(400),
  language: z.string().min(2).max(35),
  authorPersonId: z.uuid().nullable(),
  citations: z.array(citation).max(50),
  contribution: z.enum(["prior_notice_comparison", "on_record_interview", "local_reporting", "dataset_analysis"]).nullable(),
  contributionNote: z.string().max(2000).nullable(),
  correctionNote: z.string().max(2000).nullable(),
  assistModel: z.string().max(120).nullable(),
  sectionSlug: z.string().min(1),
  termSlugs: z.array(z.strictObject({ kind: z.enum(["state", "topic"]), slug: z.string() })),
};
const contentSchema = z.strictObject(fields);
type Content = z.infer<typeof contentSchema>;

export const createInput = z.strictObject({
  type: z.enum(["original_brief", "original_report", "analysis", "press_material"]),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120).optional(),
  embargoUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  headline: fields.headline,
  standfirst: fields.standfirst.default(""),
  body: fields.body,
  language: fields.language.default("en"),
  authorPersonId: fields.authorPersonId.default(null),
  citations: fields.citations.default([]),
  contribution: fields.contribution.default(null),
  contributionNote: fields.contributionNote.default(null),
  correctionNote: fields.correctionNote.default(null),
  assistModel: fields.assistModel.default(null),
  sectionSlug: fields.sectionSlug,
  termSlugs: fields.termSlugs.default([]),
});

/** No defaults here: an omitted field must keep its current value. */
export const patchInput = contentSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  embargoUntil: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const actionInput = z.strictObject({
  action: z.enum(["submit", "approve-editorial", "approve-medical", "return", "schedule", "publish", "correct", "retract", "remove", "classify"]),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().min(1).max(2000).optional(),
  evidence: z.string().min(1).max(2000).optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  publicNote: z.string().max(1000).optional(),
  removalStatus: z.union([z.literal(410), z.literal(451)]).optional(),
  riskRoute: z.enum(["routine", "clinical", "sensitive"]).optional(),
});
export type ActionInput = z.infer<typeof actionInput>;

export interface CommandResult {
  id: string;
  slug: string;
  status: string;
  version: number;
  draftVersion: number;
  publicVersion: number | null;
}

/* ───────────── helpers ───────────── */

export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/, "");
  return s || "story";
}

/** Deterministic under collision: base, base-2, base-3 … Former slugs stay reserved. */
async function uniqueSlug(tx: Tx, locale: string, base: string): Promise<string> {
  const taken = new Set<string>();
  const like = `${base}%`;
  for (const r of await tx.select({ s: articles.slug }).from(articles).where(and(eq(articles.locale, locale), sql`${articles.slug} like ${like}`))) taken.add(r.s);
  for (const r of await tx.select({ s: redirects.fromSlug }).from(redirects).where(and(eq(redirects.locale, locale), sql`${redirects.fromSlug} like ${like}`))) taken.add(r.s);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function bodyText(body: Block[]): string {
  return body.map((b) => (b.type === "list" ? b.items.join("\n") : b.text)).join("\n\n");
}

function materialHash(c: Content): string {
  return sha256Hex(
    canonicalJson({
      headline: c.headline,
      standfirst: c.standfirst,
      body: c.body,
      author: c.authorPersonId,
      citations: c.citations.map((x) => [x.url, x.label, x.publisherName, x.isPrimary]),
      contribution: c.contribution,
      contributionNote: c.contributionNote,
      correctionNote: c.correctionNote,
    }),
  );
}

const stricter = (a: RiskRoute, b: RiskRoute): RiskRoute => {
  const rank = { routine: 0, clinical: 1, sensitive: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
};

async function writeVersion(tx: Tx, articleId: string, version: number, c: Content, actorId: string | null, now: Date, extra: { sourceAuthorLabel?: string | null; leadAssetId?: string | null } = {}) {
  const [row] = await tx
    .insert(articleVersions)
    .values({
      articleId,
      version,
      headline: c.headline,
      standfirst: c.standfirst,
      body: c.body,
      bodyText: bodyText(c.body),
      language: c.language,
      authorPersonId: c.authorPersonId,
      contribution: c.contribution,
      contributionNote: c.contributionNote,
      correctionNote: c.correctionNote,
      assistModel: c.assistModel,
      sourceAuthorLabel: extra.sourceAuthorLabel ?? null,
      leadAssetId: extra.leadAssetId ?? null,
      contentHash: materialHash(c),
      createdBy: actorId,
      createdAt: now,
    })
    .returning();
  if (c.citations.length > 0) {
    await tx.insert(articleCitations).values(
      c.citations.map((x, i) => ({
        versionId: row!.id,
        position: i + 1,
        url: x.url,
        label: x.label,
        publisherName: x.publisherName,
        isPrimary: x.isPrimary || (i === 0 && !c.citations.some((y) => y.isPrimary)),
        sourceRevisionId: x.sourceRevisionId ?? null,
      })),
    );
  }
  return row!;
}

async function setTerms(tx: Tx, articleId: string, sectionSlug: string, extra: Content["termSlugs"]): Promise<void> {
  const [section] = await tx.select().from(terms).where(and(eq(terms.kind, "section"), eq(terms.slug, sectionSlug)));
  if (!section) throw new CommandError(422, "VALIDATION_FAILED", "Unknown section.", { fieldErrors: [{ field: "sectionSlug", code: "UNKNOWN_TERM", message: "No such section." }] });
  const others: string[] = [];
  for (const t of extra) {
    const [term] = await tx.select().from(terms).where(and(eq(terms.kind, t.kind), eq(terms.slug, t.slug)));
    if (!term) throw new CommandError(422, "VALIDATION_FAILED", "Unknown term.", { fieldErrors: [{ field: "termSlugs", code: "UNKNOWN_TERM", message: `No ${t.kind} "${t.slug}".` }] });
    others.push(term.id);
  }
  await tx.delete(articleTerms).where(eq(articleTerms.articleId, articleId));
  await tx.insert(articleTerms).values([
    { articleId, termId: section.id, isPrimarySection: true },
    ...[...new Set(others)].filter((id) => id !== section.id).map((termId) => ({ articleId, termId, isPrimarySection: false })),
  ]);
}

async function versionNumber(tx: Tx, versionId: string | null): Promise<number | null> {
  if (!versionId) return null;
  const [v] = await tx.select({ n: articleVersions.version }).from(articleVersions).where(eq(articleVersions.id, versionId));
  return v?.n ?? null;
}

async function resultOf(tx: Tx, articleId: string): Promise<CommandResult> {
  const [a] = await tx.select().from(articles).where(eq(articles.id, articleId));
  return {
    id: a!.id,
    slug: a!.slug,
    status: a!.status,
    version: a!.lockVersion,
    draftVersion: (await versionNumber(tx, a!.draftVersionId)) ?? 0,
    publicVersion: await versionNumber(tx, a!.publicVersionId),
  };
}

async function contentOf(tx: Tx, versionId: string, articleId: string): Promise<Content> {
  const [v] = await tx.select().from(articleVersions).where(eq(articleVersions.id, versionId));
  const cites = await tx.select().from(articleCitations).where(eq(articleCitations.versionId, versionId)).orderBy(asc(articleCitations.position));
  const termRows = await tx.select({ t: terms, primary: articleTerms.isPrimarySection }).from(articleTerms).innerJoin(terms, eq(terms.id, articleTerms.termId)).where(eq(articleTerms.articleId, articleId));
  return {
    headline: v!.headline,
    standfirst: v!.standfirst,
    body: v!.body as Block[],
    language: v!.language,
    authorPersonId: v!.authorPersonId,
    citations: cites.map((c) => ({ url: c.url, label: c.label, publisherName: c.publisherName, isPrimary: c.isPrimary, sourceRevisionId: c.sourceRevisionId ?? undefined })),
    contribution: v!.contribution,
    contributionNote: v!.contributionNote,
    correctionNote: v!.correctionNote,
    assistModel: v!.assistModel,
    sectionSlug: termRows.find((r) => r.primary)?.t.slug ?? "",
    termSlugs: termRows.filter((r) => !r.primary).map((r) => ({ kind: r.t.kind as "state" | "topic", slug: r.t.slug })),
  };
}

/* ───────────── create and edit ───────────── */

export async function createArticle(db: Db, actor: Actor, raw: unknown, now: Date): Promise<CommandResult> {
  if (!has(actor, "reporter", "editor", "managing_editor")) throw new CommandError(403, "FORBIDDEN", "This account cannot write stories.");
  const input = parse(createInput, raw);
  return db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, "en-IN", input.slug ?? slugify(input.headline));
    const risk = assessRisk(`${input.headline} ${input.standfirst} ${bodyText(input.body)}`);
    const [article] = await tx
      .insert(articles)
      .values({ slug, type: input.type, riskRoute: risk.route, embargoUntil: input.embargoUntil ? new Date(input.embargoUntil) : null, createdBy: actor.personId, createdAt: now, updatedAt: now })
      .returning();
    const { type: _t, slug: _s, embargoUntil: _e, ...c } = input;
    const version = await writeVersion(tx, article!.id, 1, { ...c, authorPersonId: c.authorPersonId ?? actor.personId }, actor.personId, now);
    await setTerms(tx, article!.id, input.sectionSlug, input.termSlugs);
    await tx.update(articles).set({ draftVersionId: version.id }).where(eq(articles.id, article!.id));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "article.create", subjectType: "article", subjectId: article!.id, diff: { riskFlags: risk.flags } });
    return resultOf(tx, article!.id);
  });
}

export async function patchArticle(db: Db, actor: Actor, articleId: string, raw: unknown, now: Date): Promise<CommandResult> {
  const input = parse(patchInput, raw);
  return db.transaction(async (tx) => {
    const article = await lockArticle(tx, articleId, input.expectedVersion);
    if (article.type === "licensed_copy") throw new CommandError(422, "LICENSED_COPY_IMMUTABLE", "A licensed copy reproduces the source. Prepare a new copy instead of editing it.");
    if (article.status === "removed" || article.status === "retracted") throw new CommandError(409, "ARTICLE_CLOSED", "A retracted or removed story cannot be edited.", { currentVersion: article.lockVersion });
    const editor = has(actor, "editor", "managing_editor");
    if (!editor && !(has(actor, "reporter") && article.createdBy === actor.personId)) throw new CommandError(403, "FORBIDDEN", "Reporters can edit only their own assigned drafts.");

    const prior = await contentOf(tx, article.draftVersionId!, article.id);
    const { expectedVersion: _v, embargoUntil, ...changes } = input;
    const next: Content = { ...prior, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) } as Content;
    const latest = await tx.select({ n: articleVersions.version }).from(articleVersions).where(eq(articleVersions.articleId, article.id)).orderBy(desc(articleVersions.version)).limit(1);
    const version = await writeVersion(tx, article.id, (latest[0]?.n ?? 0) + 1, next, actor.personId, now);
    if (changes.sectionSlug !== undefined || changes.termSlugs !== undefined) await setTerms(tx, article.id, next.sectionSlug, next.termSlugs);

    // The risk route can only tighten on edit. A managing editor reclassifies explicitly.
    const risk = assessRisk(`${next.headline} ${next.standfirst} ${bodyText(next.body)}`);
    const preReview = article.status === "in_review" || article.status === "approved" || article.status === "scheduled";
    await tx
      .update(articles)
      .set({
        draftVersionId: version.id,
        lockVersion: article.lockVersion + 1,
        riskRoute: stricter(article.riskRoute, risk.route),
        // Editing invalidates sign-off: the new version has no approvals and any schedule is cancelled.
        status: preReview ? "draft" : article.status,
        scheduledAt: preReview ? null : article.scheduledAt,
        scheduledVersionId: preReview ? null : article.scheduledVersionId,
        ...(embargoUntil !== undefined ? { embargoUntil: embargoUntil ? new Date(embargoUntil) : null } : {}),
        updatedAt: now,
      })
      .where(eq(articles.id, article.id));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "article.edit", subjectType: "article", subjectId: article.id, diff: { fields: Object.keys(changes), version: version.version, approvalsInvalidated: preReview } });
    return resultOf(tx, article.id);
  });
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new CommandError(422, "VALIDATION_FAILED", "One or more fields are invalid.", {
    fieldErrors: r.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", code: "INVALID", message: i.message })),
  });
}

async function lockArticle(tx: Tx, articleId: string, expectedVersion: number) {
  const [article] = await tx.select().from(articles).where(eq(articles.id, articleId)).for("update");
  if (!article) throw new CommandError(404, "NOT_FOUND", "No such story.");
  if (article.lockVersion !== expectedVersion) {
    throw new CommandError(409, "STALE_VERSION", "The story changed since you loaded it. Review the difference and retry.", { currentVersion: article.lockVersion });
  }
  return article;
}

/* ───────────── approvals ───────────── */

/** Sign-offs in force for a version. A later "returned" decision clears earlier approvals. */
async function approvalsFor(tx: Tx, versionId: string) {
  const rows = await tx.select().from(approvals).where(eq(approvals.versionId, versionId)).orderBy(asc(approvals.createdAt));
  let editorial: string | null = null;
  let medical: string | null = null;
  let returned = false;
  for (const r of rows) {
    if (r.decision === "returned") {
      editorial = medical = null;
      returned = true;
    } else if (r.kind === "editorial") editorial = r.reviewerPersonId;
    else medical = r.reviewerPersonId;
  }
  return { editorial, medical, returned };
}

async function credentialOf(tx: Tx, personId: string, now: Date) {
  const rows = await tx.select().from(reviewerCredentials).where(eq(reviewerCredentials.personId, personId));
  return rows.find((c) => c.verifiedAt && c.verifiedAt <= now && !c.revokedAt) ?? null;
}

async function publishErrors(tx: Tx, article: typeof articles.$inferSelect, versionId: string, at: Date, automated = false): Promise<FieldError[]> {
  const [version] = await tx.select().from(articleVersions).where(eq(articleVersions.id, versionId));
  const cites = await tx.select().from(articleCitations).where(eq(articleCitations.versionId, versionId));
  const signoff = await approvalsFor(tx, versionId);
  const revIds = cites.map((c) => c.sourceRevisionId).filter((x): x is string => Boolean(x));
  const withdrawn = revIds.length
    ? await tx
        .select({ id: sourceItems.id })
        .from(sourceRevisions)
        .innerJoin(sourceItems, eq(sourceItems.id, sourceRevisions.itemId))
        .where(and(inArray(sourceRevisions.id, revIds), eq(sourceItems.status, "withdrawn")))
    : [];
  const section = await tx.select().from(articleTerms).where(and(eq(articleTerms.articleId, article.id), eq(articleTerms.isPrimarySection, true)));
  const flags = await getFlags(tx);
  let grant = null;
  if (article.type === "licensed_copy" && article.sourceItemId) {
    const [item] = await tx.select().from(sourceItems).where(eq(sourceItems.id, article.sourceItemId));
    // Hold the policy rows steady while the public pointer changes (DB-03).
    await tx.select({ id: sourceGrants.id }).from(sourceGrants).where(eq(sourceGrants.sourceId, item!.sourceId)).for("share");
    const [source] = await tx.select().from(sources).where(eq(sources.id, item!.sourceId));
    grant = source?.status === "enabled" ? await loadCurrentGrant(tx, item!.sourceId, at) : null;
  }
  return checkArticlePublish({
    type: article.type,
    riskRoute: article.riskRoute,
    hasAuthor: Boolean(version!.authorPersonId || version!.deskId),
    hasPrimarySection: section.length === 1,
    citationCount: cites.length,
    hasContribution: Boolean(version!.contribution && version!.contributionNote),
    editorialApprover: signoff.editorial,
    medicalApprover: signoff.medical,
    medicalApproverCredentialed: signoff.medical ? Boolean(await credentialOf(tx, signoff.medical, at)) : false,
    embargoUntil: article.embargoUntil,
    suppressed: Boolean(await activeSuppression(tx, "article", article.id)),
    withdrawnCitations: withdrawn.length,
    boundGrantId: article.grantId,
    grant,
    licensedFeedsEnabled: flags.licensed_feeds ?? false,
    automated,
    now: at,
  });
}

/**
 * Move the public pointer. Runs with the article row locked. Rights, embargo,
 * risk, approvals and tombstones are all rechecked here, whatever the caller
 * checked earlier (ING-05).
 */
async function publishVersion(tx: Tx, article: typeof articles.$inferSelect, versionId: string, actorId: string | null, now: Date, isCorrection: boolean, automated = false): Promise<void> {
  const errors = await publishErrors(tx, article, versionId, now, automated);
  if (errors.length > 0) throw new CommandError(422, "PUBLISH_BLOCKED", "This version cannot be released yet.", { fieldErrors: errors });
  const [version] = await tx.select().from(articleVersions).where(eq(articleVersions.id, versionId));
  const firstPublishedAt = article.firstPublishedAt ?? now;
  await tx
    .update(articles)
    .set({
      publicVersionId: versionId,
      status: "published",
      firstPublishedAt,
      modifiedAt: isCorrection ? now : article.modifiedAt,
      scheduledAt: null,
      scheduledVersionId: null,
      isIndexable: isIndexable(article.type, Boolean(version!.contribution && version!.contributionNote)),
      lockVersion: article.lockVersion + 1,
      updatedAt: now,
    })
    .where(eq(articles.id, article.id));

  let publisherName = SITE_NAME;
  let scope = ["web", "rss", "social"];
  if (article.type === "licensed_copy" && article.sourceItemId) {
    const [row] = await tx.select({ s: sources }).from(sourceItems).innerJoin(sources, eq(sources.id, sourceItems.sourceId)).where(eq(sourceItems.id, article.sourceItemId));
    const grant = await loadCurrentGrant(tx, row!.s.id, now);
    publisherName = row!.s.displayName;
    scope = grant?.channels ?? [];
  }
  const [live] = await tx.select().from(feedEntries).where(and(eq(feedEntries.articleId, article.id), eq(feedEntries.status, "active")));
  if (live) await tx.update(feedEntries).set({ displayTitle: version!.headline, scope }).where(eq(feedEntries.id, live.id));
  else {
    await tx.insert(feedEntries).values({ kind: "article", articleId: article.id, displayTitle: version!.headline, publisherName, targetUrl: `/news/${article.slug}`, visibleFrom: firstPublishedAt, scope, grantId: article.grantId });
  }
  await emit(tx, {
    eventType: isCorrection ? "article.corrected" : "article.published",
    aggregateType: "article",
    aggregateId: article.id,
    payload: { versionId, version: version!.version, slug: article.slug },
  });
  await audit(tx, { actorType: actorId ? "staff" : "system", actorId, action: isCorrection ? "article.correct" : "article.publish", subjectType: "article", subjectId: article.id, diff: { version: version!.version } });
}

/* ───────────── actions ───────────── */

export async function performAction(db: Db, actor: Actor, articleId: string, raw: unknown, now: Date): Promise<CommandResult> {
  const cmd = parse(actionInput, raw);
  return db.transaction(async (tx) => {
    // Serialize on the article first, so a concurrent duplicate sees the stored result.
    const [locked] = await tx.select().from(articles).where(eq(articles.id, articleId)).for("update");
    if (!locked) throw new CommandError(404, "NOT_FOUND", "No such story.");
    const [done] = await tx.select().from(commandLog).where(eq(commandLog.idempotencyKey, cmd.idempotencyKey));
    if (done) {
      if (done.actorId !== actor.personId || done.articleId !== articleId || done.action !== cmd.action) throw new CommandError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key belongs to a different command.");
      return done.result as CommandResult;
    }
    if (locked.lockVersion !== cmd.expectedVersion) throw new CommandError(409, "STALE_VERSION", "The story changed since you loaded it.", { currentVersion: locked.lockVersion });
    await runAction(tx, actor, locked, cmd, now);
    const result = await resultOf(tx, articleId);
    await tx.insert(commandLog).values({ idempotencyKey: cmd.idempotencyKey, actorId: actor.personId, articleId, action: cmd.action, result });
    return result;
  });
}

async function runAction(tx: Tx, actor: Actor, a: typeof articles.$inferSelect, cmd: ActionInput, now: Date): Promise<void> {
  const need = (ok: boolean, message: string) => {
    if (!ok) throw new CommandError(403, "FORBIDDEN", message);
  };
  const requireReason = () => {
    if (!cmd.reason) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.", { fieldErrors: [{ field: "reason", code: "REQUIRED", message: "Record the reason for this action." }] });
    return cmd.reason;
  };
  const bump = (set: Partial<typeof articles.$inferInsert>) =>
    tx.update(articles).set({ ...set, lockVersion: a.lockVersion + 1, updatedAt: now }).where(eq(articles.id, a.id));
  const state = (allowed: (typeof a.status)[], what: string) => {
    if (!allowed.includes(a.status)) throw new CommandError(409, "INVALID_STATE", `Cannot ${what} a story that is ${a.status}.`, { currentVersion: a.lockVersion });
  };
  const draftId = a.draftVersionId!;
  const pendingRevision = draftId !== a.publicVersionId;
  const log = (action: string, diff?: Record<string, unknown>) =>
    audit(tx, { actorType: "staff", actorId: actor.personId, action, subjectType: "article", subjectId: a.id, reason: cmd.reason, diff });

  switch (cmd.action) {
    case "submit": {
      need(has(actor, "reporter", "editor", "managing_editor"), "This account cannot submit stories.");
      state(["draft", "published"], "submit");
      const cites = await tx.select({ id: articleCitations.id }).from(articleCitations).where(eq(articleCitations.versionId, draftId));
      const errors: FieldError[] = [];
      if (cites.length < 1) errors.push({ field: "citations", code: "SOURCE_REQUIRED", message: "At least one visible source link is required." });
      if ((await approvalsFor(tx, draftId)).returned) errors.push({ field: "version", code: "REVISION_RETURNED", message: "This revision was returned. Edit it before resubmitting." });
      if (!pendingRevision) errors.push({ field: "version", code: "NOTHING_TO_REVIEW", message: "There is no unpublished revision." });
      if (errors.length) throw new CommandError(422, "SUBMIT_BLOCKED", "This revision cannot be submitted.", { fieldErrors: errors });
      await bump(a.status === "draft" ? { status: "in_review" } : {});
      await log("article.submit");
      return;
    }
    case "approve-editorial":
    case "approve-medical": {
      const medical = cmd.action === "approve-medical";
      need(medical ? has(actor, "medical_reviewer") : canPublish(actor), medical ? "Only a medical reviewer can give clinical sign-off." : "Only an editor can approve.");
      state(["in_review", "approved", "published"], "approve");
      if (!pendingRevision) throw new CommandError(409, "INVALID_STATE", "There is no unpublished revision to approve.", { currentVersion: a.lockVersion });
      const signoff = await approvalsFor(tx, draftId);
      if (signoff.returned) throw new CommandError(409, "INVALID_STATE", "This revision was returned and needs an edit.", { currentVersion: a.lockVersion });
      if (medical ? signoff.medical : signoff.editorial) throw new CommandError(409, "ALREADY_APPROVED", "This version already has that sign-off.", { currentVersion: a.lockVersion });
      let specialty: string | null = null;
      if (medical) {
        const cred = await credentialOf(tx, actor.personId, now);
        const errors: FieldError[] = [];
        if (!cred) errors.push({ field: "reviewer", code: "REVIEWER_NOT_CREDENTIALED", message: "No verified credential record for this reviewer." });
        if (!cmd.evidence) errors.push({ field: "evidence", code: "REQUIRED", message: "Record the primary evidence checked." });
        if (signoff.editorial === actor.personId) errors.push({ field: "reviewer", code: "SAME_PERSON", message: "Editor and medical reviewer must be two distinct people." });
        if (errors.length) throw new CommandError(422, "APPROVAL_BLOCKED", "Clinical sign-off cannot be recorded.", { fieldErrors: errors });
        specialty = cred!.specialty;
      } else if (signoff.medical === actor.personId) {
        throw new CommandError(422, "APPROVAL_BLOCKED", "Editor and medical reviewer must be two distinct people.", { fieldErrors: [{ field: "reviewer", code: "SAME_PERSON", message: "You already gave clinical sign-off on this version." }] });
      }
      await tx.insert(approvals).values({ articleId: a.id, versionId: draftId, kind: medical ? "medical" : "editorial", decision: "approved", reviewerPersonId: actor.personId, specialty, evidence: cmd.evidence ?? null, reason: cmd.reason ?? null, createdAt: now });
      const after = await approvalsFor(tx, draftId);
      const complete = Boolean(after.editorial) && (a.riskRoute === "routine" || Boolean(after.medical));
      await bump(a.status === "in_review" && complete ? { status: "approved" } : {});
      await log(`article.${cmd.action}`, { version: await versionNumber(tx, draftId), specialty });
      return;
    }
    case "return": {
      need(has(actor, "editor", "managing_editor", "medical_reviewer"), "Only a reviewer can return a revision.");
      state(["in_review", "approved", "scheduled", "published"], "return");
      const reason = requireReason();
      // Returned rows live in the approvals log; the partial unique index covers approved rows only.
      await tx.insert(approvals).values({ articleId: a.id, versionId: draftId, kind: has(actor, "medical_reviewer") && !canPublish(actor) ? "medical" : "editorial", decision: "returned", reviewerPersonId: actor.personId, reason, createdAt: now });
      await bump(a.status === "published" ? {} : { status: "draft", scheduledAt: null, scheduledVersionId: null });
      await log("article.return");
      return;
    }
    case "schedule": {
      need(canPublish(actor), "Only an editor with a publishing role can schedule.");
      state(["approved"], "schedule");
      if (!cmd.scheduledAt) throw new CommandError(422, "VALIDATION_FAILED", "scheduledAt is required.", { fieldErrors: [{ field: "scheduledAt", code: "REQUIRED", message: "Give a time with an explicit offset." }] });
      const at = new Date(cmd.scheduledAt);
      if (at <= now) throw new CommandError(422, "VALIDATION_FAILED", "scheduledAt must be in the future.", { fieldErrors: [{ field: "scheduledAt", code: "PAST", message: "Use publish for an immediate release." }] });
      const errors = await publishErrors(tx, a, draftId, at);
      if (errors.length) throw new CommandError(422, "PUBLISH_BLOCKED", "This version cannot be scheduled.", { fieldErrors: errors });
      await bump({ status: "scheduled", scheduledAt: at, scheduledVersionId: draftId });
      await enqueue(tx, { queue: "publish", kind: "article.publish", key: `publish:${a.id}:${draftId}:${at.getTime()}`, payload: { articleId: a.id, versionId: draftId }, runAt: at });
      await log("article.schedule", { scheduledAt: at.toISOString() });
      return;
    }
    case "publish": {
      need(canPublish(actor), "Releasing a story needs an explicitly assigned publishing role.");
      // Earlier states are allowed through so the caller gets the full list of missing sign-offs as a 422.
      state(["draft", "in_review", "approved", "scheduled"], "publish");
      if (a.publicVersionId) throw new CommandError(409, "INVALID_STATE", "This story is already public. Use correct.", { currentVersion: a.lockVersion });
      await publishVersion(tx, a, draftId, actor.personId, now, false);
      return;
    }
    case "correct": {
      need(canPublish(actor), "Releasing a correction needs an explicitly assigned publishing role.");
      state(["published"], "correct");
      if (!pendingRevision) throw new CommandError(409, "INVALID_STATE", "There is no unpublished revision to release.", { currentVersion: a.lockVersion });
      const [v] = await tx.select().from(articleVersions).where(eq(articleVersions.id, draftId));
      if (!v!.correctionNote) throw new CommandError(422, "PUBLISH_BLOCKED", "A correction needs a public note.", { fieldErrors: [{ field: "correctionNote", code: "REQUIRED", message: "Describe what changed for readers." }] });
      await publishVersion(tx, a, draftId, actor.personId, now, true);
      return;
    }
    case "retract":
    case "remove": {
      need(has(actor, "managing_editor"), "Only a managing editor can retract or remove a story.");
      if (!a.publicVersionId) throw new CommandError(409, "INVALID_STATE", "This story was never public.", { currentVersion: a.lockVersion });
      const reason = requireReason();
      const kind = cmd.action === "retract" ? "retraction" : cmd.removalStatus === 451 ? "removal_451" : "removal_410";
      await tx.insert(suppressions).values({ subjectType: "article", subjectId: a.id, kind, reason, publicNote: cmd.publicNote ?? null, decidedBy: actor.personId, createdAt: now });
      await tx.update(feedEntries).set({ status: "suppressed" }).where(and(eq(feedEntries.articleId, a.id), eq(feedEntries.status, "active")));
      await bump({ status: cmd.action === "retract" ? "retracted" : "removed", isIndexable: false, scheduledAt: null, scheduledVersionId: null });
      await emit(tx, { eventType: cmd.action === "retract" ? "article.retracted" : "article.removed", aggregateType: "article", aggregateId: a.id, payload: { kind, slug: a.slug } });
      await log(`article.${cmd.action}`, { kind });
      return;
    }
    case "classify": {
      need(has(actor, "managing_editor"), "Only a managing editor can reclassify risk.");
      requireReason();
      if (!cmd.riskRoute) throw new CommandError(422, "VALIDATION_FAILED", "riskRoute is required.", { fieldErrors: [{ field: "riskRoute", code: "REQUIRED", message: "Choose routine, clinical or sensitive." }] });
      await bump({ riskRoute: cmd.riskRoute });
      await log("article.classify", { from: a.riskRoute, to: cmd.riskRoute });
      return;
    }
  }
}

/* ───────────── scheduled release ───────────── */

/**
 * Worker entry for a scheduled release. Safe to run twice: the second run sees
 * the public pointer already on this version and does nothing.
 */
export async function runScheduledPublish(db: Db, articleId: string, versionId: string, now: Date): Promise<"published" | "skipped" | "blocked"> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(articles).where(eq(articles.id, articleId)).for("update");
    if (!a || a.publicVersionId === versionId) return "skipped";
    if (a.status !== "scheduled" || a.scheduledVersionId !== versionId || a.draftVersionId !== versionId) return "skipped";
    if (a.scheduledAt && a.scheduledAt > now) return "skipped";
    try {
      await publishVersion(tx, a, versionId, null, now, Boolean(a.publicVersionId));
      return "published";
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      await tx.update(articles).set({ status: "approved", scheduledAt: null, scheduledVersionId: null, lockVersion: a.lockVersion + 1, updatedAt: now }).where(eq(articles.id, a.id));
      await openTask(tx, { kind: "scheduled_publish_blocked", subjectType: "article", subjectId: a.id, detail: (e.extra.fieldErrors ?? []).map((f) => f.code).join(", ") });
      return "blocked";
    }
  });
}

/* ───────────── licensed republication ───────────── */

export const licensedInput = z.strictObject({
  sourceRevisionId: z.uuid(),
  body: z.array(block).min(1).max(400),
  sectionSlug: z.string().min(1),
  leadAssetId: z.uuid().optional(),
});

/**
 * Prepare a labelled, noindex copy of a partner item. The grant must cover the
 * exact use: full text for the body, a separate image allowance for any image.
 */
export async function createLicensedCopy(db: Db, actor: Actor, raw: unknown, now: Date): Promise<CommandResult> {
  if (!canPublish(actor)) throw new CommandError(403, "FORBIDDEN", "Only an editor can prepare a licensed copy.");
  const input = parse(licensedInput, raw);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ rev: sourceRevisions, item: sourceItems, source: sources })
      .from(sourceRevisions)
      .innerJoin(sourceItems, eq(sourceItems.id, sourceRevisions.itemId))
      .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
      .where(eq(sourceRevisions.id, input.sourceRevisionId));
    if (!row || row.rev.kind !== "upsert" || !row.rev.title) throw new CommandError(404, "NOT_FOUND", "No such source revision.");
    const grant = row.source.status === "enabled" ? await loadCurrentGrant(tx, row.source.id, now) : null;
    const errors: FieldError[] = [];
    if (!grant) errors.push({ field: "rights", code: "RIGHTS_UNKNOWN", message: "No grant is in force for this source." });
    else {
      if (!grant.allowFullText) errors.push({ field: "rights", code: "FULL_TEXT_NOT_PERMITTED", message: "The grant does not cover full text." });
      if (input.leadAssetId && !grant.allowImages) errors.push({ field: "leadAssetId", code: "IMAGES_NOT_PERMITTED", message: "The grant does not cover images. Publish the copy without one." });
    }
    if (row.item.currentRevisionId !== row.rev.id) errors.push({ field: "sourceRevisionId", code: "REVISION_NOT_CURRENT", message: "A newer source revision exists." });
    if (errors.length || !grant) throw new CommandError(422, "RIGHTS_BLOCKED", "This item cannot be republished.", { fieldErrors: errors });

    const slug = await uniqueSlug(tx, "en-IN", slugify(row.rev.title));
    const [article] = await tx
      .insert(articles)
      .values({ slug, type: "licensed_copy", riskRoute: row.rev.riskRoute, sourceItemId: row.item.id, grantId: grant.id, isIndexable: false, embargoUntil: row.item.embargoUntil, createdBy: actor.personId, createdAt: now, updatedAt: now })
      .returning();
    const c: Content = {
      headline: row.rev.title,
      standfirst: "",
      body: input.body,
      language: row.rev.language ?? "en",
      authorPersonId: null,
      citations: [{ url: row.rev.submittedUrl, label: row.rev.title, publisherName: row.source.displayName, isPrimary: true, sourceRevisionId: row.rev.id }],
      contribution: null,
      contributionNote: null,
      correctionNote: null,
      assistModel: null,
      sectionSlug: input.sectionSlug,
      termSlugs: [],
    };
    const version = await writeVersion(tx, article!.id, 1, c, actor.personId, now, { sourceAuthorLabel: row.rev.sourceAuthor ?? row.source.displayName, leadAssetId: input.leadAssetId ?? null });
    await setTerms(tx, article!.id, input.sectionSlug, []);
    await tx.update(articles).set({ draftVersionId: version.id, status: "in_review" }).where(eq(articles.id, article!.id));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "article.create_licensed", subjectType: "article", subjectId: article!.id, diff: { grantVersion: grant.version } });
    return resultOf(tx, article!.id);
  });
}

/**
 * Rights sweep for partner copies (COR-01). A copy whose grant has expired,
 * been revoked or replaced is suppressed with a recorded grant reference.
 */
export async function sweepArticleRights(db: Db, now: Date): Promise<number> {
  const copies = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.type, "licensed_copy"), eq(articles.status, "published")));
  let suppressed = 0;
  for (const { id } of copies) {
    await db.transaction(async (tx) => {
      const [a] = await tx.select().from(articles).where(eq(articles.id, id)).for("update");
      if (!a || a.status !== "published" || !a.sourceItemId) return;
      if (await activeSuppression(tx, "article", a.id)) return;
      const [row] = await tx.select({ s: sources }).from(sourceItems).innerJoin(sources, eq(sources.id, sourceItems.sourceId)).where(eq(sourceItems.id, a.sourceItemId));
      const grant = row!.s.status === "enabled" ? await loadCurrentGrant(tx, row!.s.id, now) : null;
      if (grant && grant.id === a.grantId && grant.allowFullText && grant.channels.includes("web")) return;
      const [bound] = await tx.select().from(sourceGrants).where(eq(sourceGrants.id, a.grantId!));
      const revoked = Boolean(bound?.revokedAt) || row!.s.status === "revoked";
      await tx.insert(suppressions).values({ subjectType: "article", subjectId: a.id, kind: revoked ? "rights_revocation" : "rights_expiry", reason: `Grant v${bound?.version ?? "?"} no longer covers this copy`, createdAt: now });
      await tx.update(feedEntries).set({ status: "suppressed" }).where(and(eq(feedEntries.articleId, a.id), eq(feedEntries.status, "active")));
      await emit(tx, { eventType: "article.suppressed", aggregateType: "article", aggregateId: a.id, payload: { kind: revoked ? "rights_revocation" : "rights_expiry", slug: a.slug } });
      await audit(tx, { actorType: "system", action: "article.rights_suppress", subjectType: "article", subjectId: a.id, diff: { grantId: a.grantId, grantVersion: bound?.version } });
      suppressed++;
    });
  }
  return suppressed;
}

/* ───────────── moved slugs and homepage placement ───────────── */

/**
 * Move a story to a new address (SEO-01). The old slug becomes a redirect
 * that points at the article itself, so every former address is one hop away
 * however many times the story moves.
 */
export async function renameSlug(db: Db, actor: Actor, articleId: string, input: { expectedVersion: number; slug: string; reason: string }, now: Date): Promise<CommandResult> {
  if (!has(actor, "editor", "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only an editor can move a story.");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 120) throw new CommandError(422, "VALIDATION_FAILED", "Invalid slug.", { fieldErrors: [{ field: "slug", code: "INVALID", message: "Use lowercase words separated by hyphens." }] });
  if (!input.reason) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.", { fieldErrors: [{ field: "reason", code: "REQUIRED", message: "Record why the address must change." }] });
  return db.transaction(async (tx) => {
    const a = await lockArticle(tx, articleId, input.expectedVersion);
    if (a.slug === input.slug) return resultOf(tx, a.id);
    const [clash] = await tx.select({ id: articles.id }).from(articles).where(and(eq(articles.locale, a.locale), eq(articles.slug, input.slug)));
    const [reserved] = await tx.select().from(redirects).where(and(eq(redirects.locale, a.locale), eq(redirects.fromSlug, input.slug)));
    if (clash || (reserved && reserved.articleId !== a.id)) throw new CommandError(409, "SLUG_TAKEN", "That address is in use or reserved by a former address.", { currentVersion: a.lockVersion });
    // Moving back to a former address of the same story frees that redirect.
    if (reserved) await tx.delete(redirects).where(eq(redirects.id, reserved.id));
    await tx.insert(redirects).values({ locale: a.locale, fromSlug: a.slug, articleId: a.id, createdAt: now });
    await tx.update(articles).set({ slug: input.slug, lockVersion: a.lockVersion + 1, updatedAt: now }).where(eq(articles.id, a.id));
    await tx.update(feedEntries).set({ targetUrl: `/news/${input.slug}` }).where(eq(feedEntries.articleId, a.id));
    if (a.publicVersionId) await emit(tx, { eventType: "article.moved", aggregateType: "article", aggregateId: a.id, payload: { from: a.slug, slug: input.slug } });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "article.move", subjectType: "article", subjectId: a.id, reason: input.reason, diff: { from: a.slug, to: input.slug } });
    return resultOf(tx, a.id);
  });
}

/** Set or clear a story's homepage lead placement (WEB-01). */
export async function setLead(db: Db, actor: Actor, articleId: string, input: { rank: number | null; until: Date | null; reason: string }): Promise<void> {
  if (!has(actor, "editor", "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only an editor can choose the lead.");
  await db.transaction(async (tx) => {
    await tx.update(articles).set({ leadRank: input.rank, leadUntil: input.until }).where(eq(articles.id, articleId));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "article.set_lead", subjectType: "article", subjectId: articleId, reason: input.reason, diff: { rank: input.rank, until: input.until?.toISOString() ?? null } });
  });
}

/* ───────────── automatic partner republication ───────────── */

/** Plain text to paragraph blocks. No markup is accepted from a source (SEC-01). */
export function textToBlocks(text: string): Block[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap((p) => (p.match(/.{1,4800}(\s|$)/g) ?? [p]).map((t) => ({ type: "paragraph" as const, text: t.trim() })))
    .slice(0, 400);
}

/**
 * Publish or refresh a partner copy without a named editor. The caller has
 * already checked the automation switches; every rights and risk rule is
 * checked again inside publishVersion. Returns the article id, or the reasons
 * the copy could not be released.
 */
export async function autoPublishLicensedCopy(
  tx: Tx,
  input: { source: typeof sources.$inferSelect; item: typeof sourceItems.$inferSelect; revision: typeof sourceRevisions.$inferSelect; grantId: string },
  now: Date,
): Promise<{ ok: true; articleId: string } | { ok: false; reasons: string[] }> {
  const { source, item, revision } = input;
  if (!revision.bodyText || !revision.title) return { ok: false, reasons: ["NO_BODY"] };
  if (!source.defaultSectionSlug) return { ok: false, reasons: ["PARTNER_SECTION_NOT_SET"] };
  const body = textToBlocks(revision.bodyText);
  if (body.length === 0) return { ok: false, reasons: ["NO_BODY"] };

  const [existing] = await tx.select().from(articles).where(and(eq(articles.sourceItemId, item.id), eq(articles.type, "licensed_copy"))).for("update");
  if (existing && (existing.status === "removed" || existing.status === "retracted")) return { ok: false, reasons: ["COPY_WITHDRAWN"] };
  // A copy an editor prepared by hand is theirs to update.
  if (existing && !existing.autoPublished) return { ok: false, reasons: ["EDITOR_OWNED_COPY"] };

  const c: Content = {
    headline: revision.title,
    standfirst: "",
    body,
    language: revision.language ?? "en",
    authorPersonId: null,
    citations: [{ url: revision.submittedUrl, label: revision.title, publisherName: source.displayName, isPrimary: true, sourceRevisionId: revision.id }],
    contribution: null,
    contributionNote: null,
    correctionNote: existing?.publicVersionId ? `Updated to match the publisher's revision ${revision.revision}.` : null,
    assistModel: null,
    sectionSlug: source.defaultSectionSlug,
    termSlugs: [],
  };
  try {
    let article = existing;
    if (!article) {
      const slug = await uniqueSlug(tx, "en-IN", slugify(revision.title));
      [article] = await tx
        .insert(articles)
        .values({ slug, type: "licensed_copy", riskRoute: revision.riskRoute, sourceItemId: item.id, grantId: input.grantId, isIndexable: false, autoPublished: true, embargoUntil: item.embargoUntil, createdAt: now, updatedAt: now })
        .returning();
      await setTerms(tx, article!.id, source.defaultSectionSlug, []);
    }
    const latest = await tx.select({ n: articleVersions.version }).from(articleVersions).where(eq(articleVersions.articleId, article!.id)).orderBy(desc(articleVersions.version)).limit(1);
    const version = await writeVersion(tx, article!.id, (latest[0]?.n ?? 0) + 1, c, null, now, { sourceAuthorLabel: revision.sourceAuthor ?? source.displayName });
    await tx.update(articles).set({ draftVersionId: version.id, grantId: input.grantId, riskRoute: revision.riskRoute }).where(eq(articles.id, article!.id));
    const [fresh] = await tx.select().from(articles).where(eq(articles.id, article!.id));
    await publishVersion(tx, fresh!, version.id, null, now, Boolean(fresh!.publicVersionId), true);
    await audit(tx, { actorType: "system", action: "article.auto_publish_licensed", subjectType: "article", subjectId: article!.id, diff: { sourceRevision: revision.revision, grantId: input.grantId } });
    return { ok: true, articleId: article!.id };
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, reasons: (e.extra.fieldErrors ?? []).map((f) => f.code) };
    throw e;
  }
}

/* ───────────── newsroom reads ───────────── */

/** Everything the editor screen needs. A reporter can open only their own drafts (ADM-01). */
export async function getDraft(db: Db, actor: Actor, articleId: string) {
  return db.transaction(async (tx) => {
    const [article] = await tx.select().from(articles).where(eq(articles.id, articleId));
    if (!article?.draftVersionId) throw new CommandError(404, "NOT_FOUND", "No such story.");
    const staffOnly = has(actor, "editor", "managing_editor", "medical_reviewer", "auditor", "administrator");
    if (!staffOnly && article.createdBy !== actor.personId) throw new CommandError(403, "FORBIDDEN", "Reporters can open only their own drafts.");
    const content = await contentOf(tx, article.draftVersionId, article.id);
    const versions = await tx.select({ id: articleVersions.id, version: articleVersions.version, createdAt: articleVersions.createdAt, createdBy: articleVersions.createdBy }).from(articleVersions).where(eq(articleVersions.articleId, article.id)).orderBy(desc(articleVersions.version));
    const log = await tx.select().from(approvals).where(eq(approvals.articleId, article.id)).orderBy(asc(approvals.createdAt));
    const signoff = await approvalsFor(tx, article.draftVersionId);
    const blockers = article.status === "removed" || article.status === "retracted" ? [] : await publishErrors(tx, article, article.draftVersionId, new Date());
    return { article, content, versions, approvals: log, signoff, blockers, draftVersion: versions.find((v) => v.id === article.draftVersionId)?.version ?? 0, publicVersion: versions.find((v) => v.id === article.publicVersionId)?.version ?? null };
  });
}
