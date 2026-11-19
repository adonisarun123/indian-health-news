/**
 * Acceptance tests for publishing, SRS AT-01 to AT-06.
 * Deterministic fixtures, fixed clocks, mock grants and two independent producers.
 * Each test checks persisted state, the external response and audit evidence together.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  articles,
  auditEntries,
  clusterItems,
  deliveries,
  editorialTasks,
  featureFlags,
  feedEntries,
  ingestEvents,
  jobs,
  outbox,
  sourceItems,
  sourceRevisions,
  suppressions,
} from "@/db/schema";
import { CommandError, createArticle, createLicensedCopy, patchArticle, performAction, runScheduledPublish } from "@/core/articles";
import type { ApiError, Receipt } from "@/core/ingest/contract";
import { decideClusterItem } from "@/core/ingest/process";
import { claim } from "@/core/jobs";
import { processOutbox, replayOutboxEvent } from "@/core/outbox";
import { getPublicArticle, listPublicFeed } from "@/core/public";
import { at, createCtx, type Ctx, drain, key, notice, receipt, ROUTINE_STORY, send, sendRaw, T0 } from "./helpers";

const fail = async (p: Promise<unknown>): Promise<CommandError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CommandError) return e;
    throw e;
  }
  throw new Error("expected a CommandError");
};
const codes = (e: CommandError) => (e.extra.fieldErrors ?? []).map((f) => f.code);

describe("AT-01 · PUB, SRC — only the approved low-risk notice appears", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("auto-publishes one card to the exact source URL and holds the unknown-grant item", async () => {
    const approved = notice();
    const unknown = notice({ source_id: "unknown-grant-demo", external_id: "post-88", source_url: "https://unlicensed.example/posts/88", source_title: "Hospital board meeting schedule announced" });
    expect((await send(ctx, ctx.seed.producers.a, approved, T0)).status).toBe(202);
    expect((await send(ctx, ctx.seed.producers.a, unknown, T0)).status).toBe(202);
    await drain(ctx, T0);

    const feed = await listPublicFeed(ctx.db, T0);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "source_card", isExternal: true, url: "https://health.example/notices/204", publisher: "State Health Bulletin", title: "District reporting calendar released" });

    const ok = (await receipt(ctx, ctx.seed.producers.a, String(approved.event_id), T0)).body as Receipt;
    expect(ok).toMatchObject({ status: "applied", reason_code: "CARD_PUBLISHED" });
    const held = (await receipt(ctx, ctx.seed.producers.a, String(unknown.event_id), T0)).body as Receipt;
    expect(held).toMatchObject({ status: "held", reason_code: "RIGHTS_UNKNOWN" });

    // The held item has a reason and a next action in the newsroom, and no public payload anywhere.
    const [heldItem] = await ctx.db.select().from(sourceItems).where(eq(sourceItems.externalId, "post-88"));
    expect(await ctx.db.select().from(feedEntries).where(eq(feedEntries.sourceItemId, heldItem!.id))).toHaveLength(0);
    const tasks = await ctx.db.select().from(editorialTasks).where(eq(editorialTasks.subjectId, heldItem!.id));
    expect(tasks).toMatchObject([{ kind: "held_item", detail: "RIGHTS_UNKNOWN", status: "open" }]);
    expect(JSON.stringify(await listPublicFeed(ctx.db, T0, { channel: "rss" }))).not.toContain("Hospital board");
  });

  it("stops automatic posting when the duty switch is off, and keeps the item for review", async () => {
    await ctx.db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "auto_publish"));
    const e = notice({ external_id: "notice-205", source_url: "https://health.example/notices/205", source_title: "Consultation window opens for district plans" });
    await send(ctx, ctx.seed.producers.a, e, at(1));
    await drain(ctx, at(1));
    expect((await receipt(ctx, ctx.seed.producers.a, String(e.event_id), at(1))).body).toMatchObject({ status: "applied", reason_code: "AWAITING_EDITOR" });
    expect(await listPublicFeed(ctx.db, at(1))).toHaveLength(1);
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "auto_publish"));
  });
});

describe("AT-02 · API — lost 202, replay, altered bytes and producer isolation", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("returns the original receipt on a byte-identical replay with one work item", async () => {
    const event = notice();
    const first = await send(ctx, ctx.seed.producers.a, event, T0);
    expect(first.status).toBe(202);
    // The producer never saw the 202. It retries the same bytes with a fresh signature.
    const replay = await sendRaw(ctx, ctx.seed.producers.a, String(event.event_id), first.raw, at(2));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await ctx.db.select().from(ingestEvents)).toHaveLength(1);
    expect(await ctx.db.select().from(jobs)).toHaveLength(1);

    const altered = Buffer.from(JSON.stringify({ ...event, source_title: "A different headline" }));
    const conflict = await sendRaw(ctx, ctx.seed.producers.a, String(event.event_id), altered, at(2));
    expect(conflict.status).toBe(409);
    expect((conflict.body as ApiError).code).toBe("EVENT_ID_REUSED");
    expect(await ctx.db.select().from(jobs)).toHaveLength(1);

    expect((await receipt(ctx, ctx.seed.producers.a, String(event.event_id), at(2))).status).toBe(200);
    expect((await receipt(ctx, ctx.seed.producers.b, String(event.event_id), at(2))).status).toBe(404);
  });

  it("rejects at the boundary with the documented status codes", async () => {
    const a = ctx.seed.producers.a;
    const post = async (event: Record<string, unknown>, now = T0) => send(ctx, a, event, now);
    const code = (r: { body: unknown }) => (r.body as ApiError).code;

    const badSig = notice();
    const raw = Buffer.from(JSON.stringify(badSig));
    const { receiveEvent } = await import("@/core/ingest/receive");
    const ts = String(Math.floor(T0.getTime() / 1000));
    expect((await receiveEvent(ctx.db, { producerKey: a.keyId, timestamp: ts, signature: "0".repeat(64), idempotencyKey: String(badSig.event_id) }, raw, T0)).status).toBe(401);
    // A signature older than five minutes must be refreshed.
    const stale = notice();
    const staleRaw = Buffer.from(JSON.stringify(stale));
    const { headersFor } = await import("./helpers");
    expect(code(await receiveEvent(ctx.db, headersFor(a, String(stale.event_id), staleRaw, T0), staleRaw, at(6)))).toBe("TIMESTAMP_SKEW");

    expect((await sendRaw(ctx, a, randomUUID(), Buffer.from("{not json"), T0)).status).toBe(400);
    expect((await sendRaw(ctx, a, randomUUID(), Buffer.alloc(256 * 1024 + 1, 0x20), T0)).status).toBe(413);

    const unknownField = await post(notice({ publish: true }));
    expect(unknownField.status).toBe(422);
    const noReason = await post(notice({ source_published_at: null }));
    expect((noReason.body as ApiError).field_errors).toEqual([{ field: "source_published_at_reason", message: "is required when source_published_at is null" }]);
    expect(code(await post(notice({ schema_version: 2 })))).toBe("SCHEMA_VERSION_UNSUPPORTED");
    expect(code(await post(notice({ source_url: "https://evil.example/notices/204" })))).toBe("URL_NOT_ALLOWED");
    expect(code(await post(notice({ source_url: "http://health.example/notices/204" })))).toBe("VALIDATION_FAILED");

    // Producer A is not assigned to the partner source. Producer B is not assigned to the bulletin.
    expect((await post(notice({ source_id: "partner-demo", source_url: "https://partner.example/x" }))).status).toBe(403);
    expect((await send(ctx, ctx.seed.producers.b, notice(), T0)).status).toBe(403);

    // Same item and revision under a new event ID with different content.
    const conflict = await post(notice({ source_title: "Conflicting content for revision 1" }));
    expect(conflict.status).toBe(409);
    expect(code(conflict)).toBe("REVISION_CONFLICT");
    expect(await ctx.db.select().from(ingestEvents)).toHaveLength(1);
  });

  it("rate-limits a producer with Retry-After", async () => {
    const { producers } = await import("@/db/schema");
    await ctx.db.update(producers).set({ ratePerMinute: 2 }).where(eq(producers.id, ctx.seed.producers.b.id));
    const b = ctx.seed.producers.b;
    const e = (n: number) => notice({ source_id: "partner-demo", external_id: `p-${n}`, source_url: `https://partner.example/p/${n}`, source_title: `Clinic timetable ${n} published` });
    expect((await send(ctx, b, e(1), at(10))).status).toBe(202);
    expect((await send(ctx, b, e(2), at(10))).status).toBe(202);
    const limited = await send(ctx, b, e(3), at(10));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThan(0);
  });
});

describe("AT-03 · ING, DB — revision order, geography and clustering", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("keeps the item on revision 2 when revisions arrive as 2, 1, 2", async () => {
    const a = ctx.seed.producers.a;
    const r2 = notice({ revision: 2, source_title: "District reporting calendar released (revised dates)" });
    const r1 = notice({ revision: 1 });
    const r2again = { ...r2, event_id: randomUUID() };
    for (const e of [r2, r1, r2again]) expect((await send(ctx, a, e, T0)).status).toBe(202);
    await drain(ctx, T0);

    const status = async (e: Record<string, unknown>) => (await receipt(ctx, a, String(e.event_id), T0)).body;
    expect(await status(r2)).toMatchObject({ status: "applied" });
    expect(await status(r1)).toMatchObject({ status: "superseded", reason_code: "STALE_REVISION" });
    expect(await status(r2again)).toMatchObject({ status: "superseded", reason_code: "DUPLICATE_REVISION" });

    const [item] = await ctx.db.select().from(sourceItems).where(eq(sourceItems.externalId, "notice-204"));
    expect(item!.highestRevision).toBe(2);
    expect(await ctx.db.select().from(sourceRevisions).where(eq(sourceRevisions.itemId, item!.id))).toHaveLength(1);
    const feed = await listPublicFeed(ctx.db, T0);
    expect(feed.map((f) => f.title)).toEqual(["District reporting calendar released (revised dates)"]);
  });

  it("keeps a similar report from another state separate, and suggests a cluster for a partner copy", async () => {
    const kerala = notice({ source_id: "kerala-bulletin-demo", external_id: "kl-9", source_url: "https://kerala-health.example/notices/9", source_title: "District reporting calendar released (revised dates)" });
    await send(ctx, ctx.seed.producers.a, kerala, at(5));
    await drain(ctx, at(5));
    expect(await ctx.db.select().from(clusterItems)).toHaveLength(0);
    expect(await listPublicFeed(ctx.db, at(5))).toHaveLength(2);

    const copy = notice({ source_id: "partner-demo", external_id: "wire-1", source_url: "https://partner.example/wire/1", source_title: "District reporting calendar released (revised dates)" });
    await send(ctx, ctx.seed.producers.b, copy, at(6));
    await drain(ctx, at(6));

    const items = await ctx.db.select().from(sourceItems);
    const id = (ext: string) => items.find((i) => i.externalId === ext)!.id;
    const suggested = await ctx.db.select().from(clusterItems);
    // One suggestion pairs the partner copy with one state's notice. The two states are never joined.
    expect(suggested).toHaveLength(2);
    expect(new Set(suggested.map((s) => s.clusterId)).size).toBe(1);
    expect(suggested.map((s) => s.itemId)).toContain(id("wire-1"));
    expect(suggested.filter((s) => [id("notice-204"), id("kl-9")].includes(s.itemId))).toHaveLength(1);
    expect(suggested.every((s) => s.decision === "pending" && s.origin === "suggested")).toBe(true);

    // An editor confirms the cluster. Both source rows and both original links survive.
    const editor = await ctx.actor("editor");
    for (const s of suggested) await decideClusterItem(ctx.db, editor, { clusterId: s.clusterId, itemId: s.itemId, decision: "confirmed", reason: "Partner wire republished the state notice" }, at(7));
    expect(await ctx.db.select().from(sourceItems)).toHaveLength(3);
    const feed = await listPublicFeed(ctx.db, at(7));
    expect(feed.map((f) => f.url).sort()).toEqual(["https://health.example/notices/204", "https://kerala-health.example/notices/9", "https://partner.example/wire/1"]);
    const trail = await ctx.db.select().from(auditEntries).where(eq(auditEntries.action, "cluster.confirmed"));
    expect(trail).toHaveLength(2);
    expect(trail[0]!.reason).toBe("Partner wire republished the state notice");
  });

  it("suppresses the card immediately when the source withdraws the item", async () => {
    const w = { schema_version: 1, event_id: randomUUID(), source_id: "state-bulletin-demo", external_id: "notice-204", revision: 3, event_type: "item.withdraw", source_url: "https://health.example/notices/204", observed_at: "2026-11-19T10:30:00+05:30", reason: "Withdrawn by the department" };
    expect((await send(ctx, ctx.seed.producers.a, w, at(84))).status).toBe(202);
    await drain(ctx, at(84));
    const feed = await listPublicFeed(ctx.db, at(84));
    expect(feed.map((f) => f.url)).not.toContain("https://health.example/notices/204");
    expect(feed).toHaveLength(2);
  });
});

describe("AT-04 · ED, ADM — drug-safety notice needs both reviews on the exact version", () => {
  let ctx: Ctx;
  let articleId: string;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("never auto-posts a risk-flagged notice, on any format", async () => {
    const alert = notice({ external_id: "alert-17", source_url: "https://health.example/alerts/17", source_title: "Drug safety alert: batch recall for a paediatric syrup" });
    await send(ctx, ctx.seed.producers.a, alert, T0);
    await drain(ctx, T0);
    expect((await receipt(ctx, ctx.seed.producers.a, String(alert.event_id), T0)).body).toMatchObject({ status: "held", reason_code: "RISK_REVIEW_REQUIRED" });
    expect(await listPublicFeed(ctx.db, T0)).toHaveLength(0);
    expect(await ctx.db.select().from(feedEntries)).toHaveLength(0);

    // An editor cannot wave a risk-flagged card through either.
    const { releaseCard } = await import("@/core/cards");
    const [item] = await ctx.db.select().from(sourceItems);
    const released = await ctx.db.transaction(async (tx) => releaseCard(tx, await ctx.actor("editor"), item!.id, "looks fine", at(1)));
    expect(released).toMatchObject({ ok: false, reasons: ["RISK_REVIEW_REQUIRED"] });
  });

  it("blocks release until an editor and a credentialed medical reviewer approve the same version", async () => {
    const [rev] = await ctx.db.select().from(sourceRevisions);
    const reporter = await ctx.actor("reporter");
    const editor = await ctx.actor("editor");
    const reviewer = await ctx.actor("reviewer");
    const created = await createArticle(
      ctx.db,
      reporter,
      {
        type: "original_brief",
        headline: "Regulator recalls one batch of a paediatric syrup",
        standfirst: "The alert names one batch. Our desk checked it against the earlier notice.",
        body: [{ type: "paragraph", text: "The drug safety alert covers a single batch and asks pharmacies to stop sale." }],
        sectionSlug: "medicines-devices",
        contribution: "prior_notice_comparison",
        contributionNote: "Compared batch numbers with the previous alert.",
        citations: [{ url: "https://health.example/alerts/17", label: "Drug safety alert", publisherName: "State Health Bulletin", isPrimary: true, sourceRevisionId: rev!.id }],
      },
      at(10),
    );
    articleId = created.id;
    const [a] = await ctx.db.select().from(articles).where(eq(articles.id, articleId));
    expect(a!.riskRoute).toBe("clinical");

    let v = (await performAction(ctx.db, reporter, articleId, { action: "submit", expectedVersion: created.version, idempotencyKey: key() }, at(11))).version;
    // A reporter cannot approve or publish.
    expect((await fail(performAction(ctx.db, reporter, articleId, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(11)))).status).toBe(403);
    v = (await performAction(ctx.db, editor, articleId, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(12))).version;

    // Editorial approval alone is not enough for a clinical story.
    const early = await fail(performAction(ctx.db, editor, articleId, { action: "publish", expectedVersion: v, idempotencyKey: key() }, at(13)));
    expect(early.status).toBe(422);
    expect(codes(early)).toEqual(["MEDICAL_APPROVAL_MISSING"]);
    // An editor without a credential record cannot give clinical sign-off.
    expect((await fail(performAction(ctx.db, editor, articleId, { action: "approve-medical", expectedVersion: v, idempotencyKey: key(), evidence: "x" }, at(13)))).status).toBe(403);
    // Reviewer status alone does not allow publishing.
    const approved = await performAction(ctx.db, reviewer, articleId, { action: "approve-medical", expectedVersion: v, idempotencyKey: key(), evidence: "Checked the batch number against the regulator's alert PDF." }, at(14));
    expect(approved.status).toBe("approved");
    expect((await fail(performAction(ctx.db, reviewer, articleId, { action: "publish", expectedVersion: approved.version, idempotencyKey: key() }, at(14)))).status).toBe(403);
    // An administrator needs an explicit publishing role.
    expect((await fail(performAction(ctx.db, await ctx.actor("admin"), articleId, { action: "publish", expectedVersion: approved.version, idempotencyKey: key() }, at(14)))).status).toBe(403);

    expect((await getPublicArticle(ctx.db, created.slug, at(14))).kind).toBe("not_found");
    expect(await listPublicFeed(ctx.db, at(14))).toHaveLength(0);

    // A material headline edit after medical approval invalidates both approvals.
    const edited = await patchArticle(ctx.db, reporter, articleId, { expectedVersion: approved.version, headline: "Regulator recalls all batches of a paediatric syrup" }, at(15));
    expect(edited.status).toBe("draft");
    const blocked = await fail(performAction(ctx.db, editor, articleId, { action: "publish", expectedVersion: edited.version, idempotencyKey: key() }, at(16)));
    expect(blocked.status).toBe(422);
    expect(codes(blocked).sort()).toEqual(["EDITORIAL_APPROVAL_MISSING", "MEDICAL_APPROVAL_MISSING"]);
    expect((await getPublicArticle(ctx.db, created.slug, at(16))).kind).toBe("not_found");

    // Fresh sign-off on the new version, then release. The public version is the approved one.
    v = (await performAction(ctx.db, reporter, articleId, { action: "submit", expectedVersion: edited.version, idempotencyKey: key() }, at(17))).version;
    v = (await performAction(ctx.db, editor, articleId, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(18))).version;
    v = (await performAction(ctx.db, reviewer, articleId, { action: "approve-medical", expectedVersion: v, idempotencyKey: key(), evidence: "Re-checked against the alert: all batches." }, at(19))).version;
    const published = await performAction(ctx.db, editor, articleId, { action: "publish", expectedVersion: v, idempotencyKey: key() }, at(20));
    expect(published).toMatchObject({ status: "published", draftVersion: 2, publicVersion: 2 });

    const page = await getPublicArticle(ctx.db, created.slug, at(20));
    expect(page.kind === "ok" && page.article.headline).toBe("Regulator recalls all batches of a paediatric syrup");
    expect(page.kind === "ok" && page.article.citations[0]!.url).toBe("https://health.example/alerts/17");

    // Signed approval references: bound to version, reviewer, specialty and time.
    const signed = await ctx.db.select().from(approvals).where(eq(approvals.articleId, articleId));
    expect(signed.filter((s) => s.decision === "approved")).toHaveLength(4);
    expect(signed.find((s) => s.kind === "medical")).toMatchObject({ specialty: "Community medicine", reviewerPersonId: ctx.seed.people.reviewer });
    // Versions and approvals are immutable at the database level.
    await expect(ctx.db.update(approvals).set({ evidence: "tampered" })).rejects.toThrow();
  });

  it("requires two distinct people for editor and medical sign-off", async () => {
    const { memberships, reviewerCredentials } = await import("@/db/schema");
    // Give the reviewer an editor role too. One person still cannot hold both sign-offs.
    await ctx.db.insert(memberships).values({ personId: ctx.seed.people.reviewer, role: "editor" });
    void reviewerCredentials;
    const both = await ctx.actor("reviewer");
    const reporter = await ctx.actor("reporter");
    const c = await createArticle(ctx.db, reporter, { ...ROUTINE_STORY, headline: "Vaccine schedule notice compared with last year", slug: "vaccine-schedule-compared" }, at(30));
    let v = (await performAction(ctx.db, reporter, c.id, { action: "submit", expectedVersion: c.version, idempotencyKey: key() }, at(31))).version;
    v = (await performAction(ctx.db, both, c.id, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(32))).version;
    const same = await fail(performAction(ctx.db, both, c.id, { action: "approve-medical", expectedVersion: v, idempotencyKey: key(), evidence: "checked" }, at(33)));
    expect(codes(same)).toContain("SAME_PERSON");
  });
});

describe("AT-05 · PUB, COR — partner copy, grant expiry and outbox replay", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("publishes a labelled copy without the image, suppresses it on expiry and refuses the replay", async () => {
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "licensed_feeds"));
    const wire = notice({ source_id: "partner-demo", external_id: "wire-7", source_url: "https://partner.example/wire/7", source_title: "Community clinic timetable published", source_author: "Asha Menon" });
    await send(ctx, ctx.seed.producers.b, wire, T0);
    await drain(ctx, T0);
    const [rev] = await ctx.db.select().from(sourceRevisions);
    const editor = await ctx.actor("editor");
    const body = [{ type: "paragraph", text: "The clinic network has published its timetable for the coming quarter." }];

    // The grant allows text and disallows images.
    const withImage = await fail(createLicensedCopy(ctx.db, editor, { sourceRevisionId: rev!.id, body, sectionSlug: "healthcare-delivery", leadAssetId: randomUUID() }, at(1)));
    expect(codes(withImage)).toEqual(["IMAGES_NOT_PERMITTED"]);

    const copy = await createLicensedCopy(ctx.db, editor, { sourceRevisionId: rev!.id, body, sectionSlug: "healthcare-delivery" }, at(1));
    const v = (await performAction(ctx.db, editor, copy.id, { action: "approve-editorial", expectedVersion: copy.version, idempotencyKey: key() }, at(2))).version;
    await performAction(ctx.db, editor, copy.id, { action: "publish", expectedVersion: v, idempotencyKey: key() }, at(3));
    await drain(ctx, at(3));

    const live = await getPublicArticle(ctx.db, copy.slug, at(3));
    expect(live.kind).toBe("ok");
    if (live.kind !== "ok") return;
    expect(live.article).toMatchObject({ type: "licensed_copy", robots: "index", hasImage: false, sourceAuthorLabel: "Asha Menon", author: null });
    expect(live.article.citations).toEqual([{ url: "https://partner.example/wire/7", label: "Community clinic timetable published", publisher: "Partner Health Wire", isPrimary: true }]);
    const [row] = await ctx.db.select().from(articles).where(eq(articles.id, copy.id));
    expect(row).toMatchObject({ isIndexable: true, grantId: ctx.seed.grants.partner });

    const [publishEvent] = await ctx.db.select().from(outbox).where(and(eq(outbox.aggregateId, copy.id), eq(outbox.eventType, "article.published")));
    const delivered = ctx.delivered.filter((d) => d.event.id === publishEvent!.id);
    expect(delivered.map((d) => d.target).sort()).toEqual(["cache:article", "cache:home", "cache:hubs", "feed:rss", "sitemap"]);
    // The grant covers web only, so the copy stays out of RSS.
    expect((await listPublicFeed(ctx.db, at(3), { channel: "rss" })).map((f) => f.url)).not.toContain(`/news/${copy.slug}`);

    // Thirty-one days later the grant has expired. Reads stop at once, before any sweep runs.
    const later = new Date(T0.getTime() + 31 * 86_400_000);
    expect(await getPublicArticle(ctx.db, copy.slug, later)).toEqual({ kind: "gone", status: 410 });
    expect(await listPublicFeed(ctx.db, later)).toHaveLength(0);

    const before = ctx.delivered.length;
    const tick = await drain(ctx, later);
    expect(tick.copiesSuppressed).toBe(1);
    const tomb = await ctx.db.select().from(suppressions).where(eq(suppressions.subjectId, copy.id));
    expect(tomb).toMatchObject([{ kind: "rights_expiry", reason: "Grant v1 no longer covers this copy" }]);
    // The suppression itself is delivered so caches are purged.
    expect(ctx.delivered.slice(before).some((d) => d.event.eventType === "article.suppressed")).toBe(true);

    // Replaying the earlier publish event cannot resurrect the copy.
    const mark = ctx.delivered.length;
    const replay = await replayOutboxEvent(ctx.db, ctx.distributor, publishEvent!.id, later);
    expect(replay).toEqual({ delivered: 0, dropped: 5 });
    expect(ctx.delivered).toHaveLength(mark);
    expect(await getPublicArticle(ctx.db, copy.slug, later)).toEqual({ kind: "gone", status: 410 });
    const notes = await ctx.db.select().from(deliveries).where(eq(deliveries.outboxId, publishEvent!.id));
    expect(notes.every((n) => n.detail === "replay refused: suppressed")).toBe(true);
  });
});

describe("AT-06 · ADM, DB — concurrent editors and concurrent workers", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("returns 409 with the current version to the second stale write", async () => {
    const reporter = await ctx.actor("reporter");
    const created = await createArticle(ctx.db, reporter, { ...ROUTINE_STORY, slug: "stale-write" }, T0);
    const e1 = await ctx.actor("editor");
    const e2 = await ctx.actor("editor2");
    const results = await Promise.allSettled([
      patchArticle(ctx.db, e1, created.id, { expectedVersion: created.version, standfirst: "First editor's standfirst." }, at(1)),
      patchArticle(ctx.db, e2, created.id, { expectedVersion: created.version, standfirst: "Second editor's standfirst." }, at(1)),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ status: 409, code: "STALE_VERSION", extra: { currentVersion: 2 } });
  });

  it("produces one public revision, one first publication time and one delivery per target", async () => {
    const reporter = await ctx.actor("reporter");
    const editor = await ctx.actor("editor");
    const c = await createArticle(ctx.db, reporter, ROUTINE_STORY, at(2));
    let v = (await performAction(ctx.db, reporter, c.id, { action: "submit", expectedVersion: c.version, idempotencyKey: key() }, at(3))).version;
    v = (await performAction(ctx.db, editor, c.id, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(4))).version;

    // The same command retried with its idempotency key returns the first result and changes nothing.
    const k = key();
    const releaseAt = new Date("2026-11-19T10:00:00+05:30");
    const scheduled = await performAction(ctx.db, editor, c.id, { action: "schedule", expectedVersion: v, idempotencyKey: k, scheduledAt: "2026-11-19T10:00:00+05:30" }, at(5));
    expect(await performAction(ctx.db, editor, c.id, { action: "schedule", expectedVersion: v, idempotencyKey: k, scheduledAt: "2026-11-19T10:00:00+05:30" }, at(5))).toEqual(scheduled);
    const queued = await ctx.db.select().from(jobs).where(eq(jobs.kind, "article.publish"));
    expect(queued).toHaveLength(1);

    // Nothing is public before the scheduled time.
    await drain(ctx, at(10));
    expect((await getPublicArticle(ctx.db, c.slug, at(10))).kind).toBe("not_found");

    // Two workers race for the same job: exactly one claims it.
    const claims = await Promise.all([claim(ctx.db, "w1", releaseAt), claim(ctx.db, "w2", releaseAt)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    // Even if both ran the handler, the second is a no-op.
    const payload = queued[0]!.payload as { articleId: string; versionId: string };
    const runs = await Promise.all([runScheduledPublish(ctx.db, payload.articleId, payload.versionId, releaseAt), runScheduledPublish(ctx.db, payload.articleId, payload.versionId, releaseAt)]);
    expect(runs.sort()).toEqual(["published", "skipped"]);

    const [a] = await ctx.db.select().from(articles).where(eq(articles.id, c.id));
    expect(a!.firstPublishedAt?.toISOString()).toBe(releaseAt.toISOString());
    expect(await ctx.db.select().from(outbox).where(eq(outbox.aggregateId, c.id))).toHaveLength(1);
    expect(await ctx.db.select().from(feedEntries).where(eq(feedEntries.articleId, c.id))).toHaveLength(1);

    const drained = await Promise.all([processOutbox(ctx.db, ctx.distributor, releaseAt), processOutbox(ctx.db, ctx.distributor, releaseAt)]);
    expect(drained[0]!.delivered + drained[1]!.delivered).toBe(5);
    expect(ctx.delivered.map((d) => d.target).sort()).toEqual(["cache:article", "cache:home", "cache:hubs", "feed:rss", "sitemap"]);

    const page = await getPublicArticle(ctx.db, c.slug, releaseAt);
    expect(page.kind === "ok" && page.article).toMatchObject({ robots: "index", author: { name: "Mira Rao", slug: "mira" }, modifiedAt: null });

    // A correction keeps the URL and first publication time and sets a genuine modification time.
    const reporterEdit = await patchArticle(ctx.db, reporter, c.id, { expectedVersion: a!.lockVersion, correctionNote: "Corrected the date of the second reporting window.", body: [{ type: "paragraph", text: "The new notice revises the reporting calendar. The second window now opens a week later." }] }, at(120));
    expect(reporterEdit.status).toBe("published");
    const stillOld = await getPublicArticle(ctx.db, c.slug, at(121));
    expect(stillOld.kind === "ok" && stillOld.article.modifiedAt).toBeNull();
    let cv = (await performAction(ctx.db, reporter, c.id, { action: "submit", expectedVersion: reporterEdit.version, idempotencyKey: key() }, at(122))).version;
    cv = (await performAction(ctx.db, editor, c.id, { action: "approve-editorial", expectedVersion: cv, idempotencyKey: key() }, at(123))).version;
    const correctedAt = new Date("2026-11-19T11:10:00+05:30");
    await performAction(ctx.db, editor, c.id, { action: "correct", expectedVersion: cv, idempotencyKey: key() }, correctedAt);
    const corrected = await getPublicArticle(ctx.db, c.slug, correctedAt);
    expect(corrected.kind === "ok" && corrected.article).toMatchObject({ slug: c.slug, correctionNote: "Corrected the date of the second reporting window." });
    expect(corrected.kind === "ok" && corrected.article.publishedAt.toISOString()).toBe(releaseAt.toISOString());
    expect(corrected.kind === "ok" && corrected.article.modifiedAt?.toISOString()).toBe(correctedAt.toISOString());
    // The first publication time cannot be rewritten, even by direct SQL.
    await expect(ctx.db.update(articles).set({ firstPublishedAt: new Date() }).where(eq(articles.id, c.id))).rejects.toThrow();

    // Retraction: dated notice at the same URL, gone from the feed. Then mandatory removal: 410.
    const me = await ctx.actor("managingEditor");
    const [cur] = await ctx.db.select().from(articles).where(eq(articles.id, c.id));
    expect((await fail(performAction(ctx.db, editor, c.id, { action: "retract", expectedVersion: cur!.lockVersion, idempotencyKey: key(), reason: "x" }, at(200)))).status).toBe(403);
    const retracted = await performAction(ctx.db, me, c.id, { action: "retract", expectedVersion: cur!.lockVersion, idempotencyKey: key(), reason: "Source notice was issued in error", publicNote: "Retracted: the underlying notice was issued in error." }, at(200));
    expect(await getPublicArticle(ctx.db, c.slug, at(200))).toMatchObject({ kind: "retracted", note: "Retracted: the underlying notice was issued in error." });
    expect(await listPublicFeed(ctx.db, at(200))).toHaveLength(0);
    await performAction(ctx.db, me, c.id, { action: "remove", expectedVersion: retracted.version, idempotencyKey: key(), reason: "Legal removal", removalStatus: 410 }, at(210));
    expect(await getPublicArticle(ctx.db, c.slug, at(210))).toEqual({ kind: "gone", status: 410 });
  });
});
