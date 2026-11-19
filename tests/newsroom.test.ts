/** Phase 3 core: sign-in, staff administration, source register, reader cases, settings and partner automation. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { articles, auditEntries, cases, editorialTasks, featureFlags, feedEntries, ingestEvents, sourceAutomation, sourceRevisions, sources, staffSessions } from "@/db/schema";
import { CommandError, loadActor } from "@/core/articles";
import { beginEnrolment, completeEnrolment, getSession, inviteStaff, matchTotp, reinviteStaff, setPersonActive, setRole, signIn, signOut, stepOf, totpAt } from "@/core/auth";
import { linkStatuses, listCases, recordLinkCheck, resolveCase, submitCase } from "@/core/cases";
import { getPublicArticle, listPublicFeed } from "@/core/public";
import { getPage, saveSettings, setFlag } from "@/core/settings";
import { addGrant, createSource, setAutomation, sourceAction, sourceImpact } from "@/core/sources";
import { at, createCtx, type Ctx, drain, notice, receipt, send, T0 } from "./helpers";

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CommandError) return e;
    throw e;
  }
  throw new Error("expected a CommandError");
};

describe("staff sign-in (SEC-02, ADM-01)", () => {
  let ctx: Ctx;
  let secret = "";
  let personId = "";
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("implements RFC 6238 correctly", () => {
    // RFC 6238 appendix B, SHA-1, secret "12345678901234567890", truncated to six digits.
    const rfc = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpAt(rfc, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(rfc, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(rfc, Math.floor(2000000000 / 30))).toBe("279037");
    expect(matchTotp(rfc, "287082", new Date(59_000))).toBe(1);
    expect(matchTotp(rfc, "287082", new Date(125_000))).toBeNull();
  });

  it("invites, enrols with password and authenticator, and refuses sign-in before enrolment", async () => {
    const admin = await ctx.actor("admin");
    expect((await rejects(inviteStaff(ctx.db, await ctx.actor("editor"), { email: "x@newsroom.example", displayName: "X", roles: ["editor"] }, T0))).status).toBe(403);
    const invite = await inviteStaff(ctx.db, admin, { email: "Asha@Newsroom.example", displayName: "Asha Menon", roles: ["editor"] }, T0);
    personId = invite.personId;
    expect((await signIn(ctx.db, { email: "asha@newsroom.example", password: "anything-at-all", code: "000000" }, T0)).ok).toBe(false);

    const start = await beginEnrolment(ctx.db, invite.token, at(1));
    expect(start).toMatchObject({ email: "asha@newsroom.example", displayName: "Asha Menon" });
    secret = start!.secret;
    // Reloading the page keeps the same secret, so a scanned code stays valid.
    expect((await beginEnrolment(ctx.db, invite.token, at(1)))!.secret).toBe(secret);
    expect(await beginEnrolment(ctx.db, "not-a-token", at(1))).toBeNull();

    expect(await completeEnrolment(ctx.db, invite.token, "short", totpAt(secret, stepOf(at(2))), at(2))).toMatchObject({ ok: false });
    expect(await completeEnrolment(ctx.db, invite.token, "a long enough passphrase", "000000", at(2))).toMatchObject({ ok: false });
    expect(await completeEnrolment(ctx.db, invite.token, "a long enough passphrase", totpAt(secret, stepOf(at(2))), at(2))).toEqual({ ok: true });
    // The invitation is single use, and expires after 72 hours.
    expect(await beginEnrolment(ctx.db, invite.token, at(3))).toBeNull();
    const second = await inviteStaff(ctx.db, admin, { email: "late@newsroom.example", displayName: "Late Joiner", roles: ["reporter"] }, T0);
    expect(await beginEnrolment(ctx.db, second.token, at(73 * 60))).toBeNull();
  });

  it("requires the right password and a fresh code, and locks after repeated failures", async () => {
    const good = { email: "asha@newsroom.example", password: "a long enough passphrase" };
    const code = (t: Date) => totpAt(secret, stepOf(t));
    expect((await signIn(ctx.db, { ...good, password: "wrong passphrase!!", code: code(at(5)) }, at(5))).ok).toBe(false);
    expect((await signIn(ctx.db, { ...good, code: "123456" }, at(5))).ok).toBe(false);

    const ok = await signIn(ctx.db, { ...good, code: code(at(6)), userAgent: "vitest" }, at(6));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const session = await getSession(ctx.db, ok.token, at(7));
    expect(session).toMatchObject({ email: "asha@newsroom.example", roles: ["editor"], personId });
    // The same code cannot be used twice.
    expect((await signIn(ctx.db, { ...good, code: code(at(6)) }, at(6))).ok).toBe(false);
    // Sessions expire after twelve hours and can be ended by the user.
    expect(await getSession(ctx.db, ok.token, at(12 * 60 + 7))).toBeNull();
    await signOut(ctx.db, ok.token, at(8));
    expect(await getSession(ctx.db, ok.token, at(9))).toBeNull();
    expect(await getSession(ctx.db, "forged", at(9))).toBeNull();
    // Only a hash of the token is stored.
    const stored = await ctx.db.select().from(staffSessions);
    expect(stored.every((s) => s.tokenHash !== ok.token && s.tokenHash.length === 64)).toBe(true);

    for (let i = 0; i < 5; i++) await signIn(ctx.db, { ...good, password: "wrong passphrase!!", code: "000000" }, at(20));
    const locked = await signIn(ctx.db, { ...good, code: code(at(21)) }, at(21));
    expect(locked).toMatchObject({ ok: false, error: expect.stringContaining("locked") });
    expect((await signIn(ctx.db, { ...good, code: code(at(40)) }, at(40))).ok).toBe(true);
  });

  it("ends every session at once when an administrator disables the account, and audits role changes", async () => {
    const admin = await ctx.actor("admin");
    const s = await signIn(ctx.db, { email: "asha@newsroom.example", password: "a long enough passphrase", code: totpAt(secret, stepOf(at(50))) }, at(50));
    expect(s.ok && (await getSession(ctx.db, s.token, at(51)))).toBeTruthy();
    await setRole(ctx.db, admin, personId, "managing_editor", true, "Covering the desk", at(52));
    expect((await loadActor(ctx.db, personId)).roles.sort()).toEqual(["editor", "managing_editor"]);
    await setRole(ctx.db, admin, personId, "managing_editor", false, "Cover ended", at(53));
    expect((await loadActor(ctx.db, personId)).roles).toEqual(["editor"]);
    expect((await rejects(setRole(ctx.db, await ctx.actor("editor"), personId, "administrator", true, "self-promotion", at(53)))).status).toBe(403);

    await setPersonActive(ctx.db, admin, personId, false, "Left the newsroom", at(54));
    expect(s.ok && (await getSession(ctx.db, s.token, at(55)))).toBeNull();
    expect((await signIn(ctx.db, { email: "asha@newsroom.example", password: "a long enough passphrase", code: totpAt(secret, stepOf(at(56))) }, at(56))).ok).toBe(false);
    expect((await rejects(setPersonActive(ctx.db, admin, admin.personId, false, "oops", at(56)))).status).toBe(422);
    // A reset issues a new invitation and clears the old password and authenticator.
    await setPersonActive(ctx.db, admin, personId, true, "Rejoined", at(57));
    const token = await reinviteStaff(ctx.db, admin, personId, at(58));
    expect((await beginEnrolment(ctx.db, token, at(59)))!.secret).not.toBe(secret);
    const trail = (await ctx.db.select().from(auditEntries)).map((a) => a.action);
    expect(trail).toEqual(expect.arrayContaining(["staff.invite", "staff.enrol", "staff.sign_in", "staff.lockout", "staff.grant_role", "staff.revoke_role", "staff.disable", "staff.reinvite"]));
  });
});

describe("source register and rights (SRC-01, SRC-02, ADM-05)", () => {
  let ctx: Ctx;
  let id = "";
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("registers a source that cannot publish until a managing editor records a grant and enables it", async () => {
    const boss = await ctx.actor("managingEditor");
    const editor = await ctx.actor("editor");
    expect((await rejects(createSource(ctx.db, editor, { slug: "nhm-demo", legalName: "NHM", displayName: "NHM", homepageUrl: "https://nhm.example/", family: "state_local", hosts: ["nhm.example"] }, T0))).status).toBe(403);
    expect((await rejects(createSource(ctx.db, boss, { slug: "Bad Slug", legalName: "", displayName: "", homepageUrl: "http://x", family: "state_local", hosts: [] }, T0))).extra.fieldErrors).toHaveLength(4);
    id = await createSource(ctx.db, boss, { slug: "nhm-demo", legalName: "National Health Mission (demo)", displayName: "NHM Demo", homepageUrl: "https://nhm.example/", family: "state_local", hosts: ["nhm.example"] }, T0);
    expect((await rejects(sourceAction(ctx.db, boss, id, { action: "enable", reason: "go" }, T0))).code).toBe("RIGHTS_UNKNOWN");
    expect((await rejects(sourceAction(ctx.db, boss, id, { action: "trial" }, T0))).status).toBe(422);
    expect((await sourceAction(ctx.db, boss, id, { action: "trial", reason: "Five-item onboarding test" }, T0)).status).toBe("under_review");

    expect((await rejects(addGrant(ctx.db, editor, id, { basis: "link_only", evidenceUri: "x", allowHeadline: true, allowExcerpt: false, allowFullText: false, allowImages: false, channels: ["web"], reason: "r" }, T0))).status).toBe(403);
    expect((await rejects(addGrant(ctx.db, boss, id, { basis: "link_only", evidenceUri: "", allowHeadline: true, allowExcerpt: false, allowFullText: true, allowImages: false, channels: [], reason: "r" }, T0))).extra.fieldErrors?.map((f) => f.field)).toEqual(["evidenceUri", "basis", "channels"]);
    expect(await addGrant(ctx.db, boss, id, { basis: "link_only", evidenceUri: "private://grants/nhm-terms", allowHeadline: true, allowExcerpt: false, allowFullText: false, allowImages: false, channels: ["web", "rss"], reason: "Public terms permit linking with headline" }, T0)).toBe(2);
    expect((await sourceAction(ctx.db, boss, id, { action: "enable", reason: "Onboarding test passed" }, T0))).toMatchObject({ status: "enabled", grantVersion: 2 });
    expect((await rejects(setAutomation(ctx.db, editor, id, "source_card", true, "r", T0))).status).toBe(403);
    await setAutomation(ctx.db, boss, id, "source_card", true, "Routine notices only", T0);
  });

  it("pauses intake without unpublishing, and revocation takes down every affected card", async () => {
    const boss = await ctx.actor("managingEditor");
    const { producerSources } = await import("@/db/schema");
    await ctx.db.insert(producerSources).values({ producerId: ctx.seed.producers.a.id, sourceId: id });
    const e = notice({ source_id: "nhm-demo", external_id: "n-1", source_url: "https://nhm.example/n/1", source_title: "Meeting schedule for mission directors" });
    expect((await send(ctx, ctx.seed.producers.a, e, at(1))).status).toBe(202);
    await drain(ctx, at(1));
    expect((await listPublicFeed(ctx.db, at(1))).map((f) => f.publisher)).toEqual(["NHM Demo"]);

    expect((await sourceAction(ctx.db, boss, id, { action: "pause", reason: "Adapter drift" }, at(2))).status).toBe("paused");
    expect((await send(ctx, ctx.seed.producers.a, notice({ source_id: "nhm-demo", external_id: "n-2", source_url: "https://nhm.example/n/2" }), at(2))).status).toBe(403);
    expect(await listPublicFeed(ctx.db, at(2))).toHaveLength(1);

    expect(await sourceImpact(ctx.db, id)).toMatchObject({ publicCards: 1, publicCopies: 0 });
    const revoked = await sourceAction(ctx.db, boss, id, { action: "revoke", reason: "Publisher withdrew permission" }, at(3));
    expect(revoked).toMatchObject({ status: "revoked", affected: { publicCards: 1 } });
    expect(await listPublicFeed(ctx.db, at(3))).toHaveLength(0);
    expect((await ctx.db.select().from(sourceAutomation).where(eq(sourceAutomation.sourceId, id))).every((a) => !a.enabled)).toBe(true);
    expect((await rejects(sourceAction(ctx.db, boss, id, { action: "enable", reason: "undo" }, at(4)))).code).toBe("INVALID_STATE");
  });

  it("auto-publishes a routine partner copy only when the grant, the switches and the risk screen all allow it", async () => {
    const boss = await ctx.actor("managingEditor");
    const b = ctx.seed.producers.b;
    const wire = (ext: string, extra: Record<string, unknown> = {}) => notice({ source_id: "partner-demo", external_id: ext, source_url: `https://partner.example/wire/${ext}`, source_title: "Community clinic timetable published", source_author: "Asha Menon", body_text: "The clinic network has published its timetable.\n\nEvening hours start next month.", ...extra });

    // Switches off: the body is kept under the licence, and a link-only card goes out.
    const first = wire("w1");
    await send(ctx, b, first, at(10));
    await drain(ctx, at(10));
    expect((await receipt(ctx, b, String(first.event_id), at(10))).body).toMatchObject({ reason_code: "CARD_PUBLISHED" });

    await setFlag(ctx.db, boss, "licensed_feeds", true, "Pilot partner feed", at(11));
    await setAutomation(ctx.db, boss, ctx.seed.sources.partner, "licensed_copy", true, "Low-risk wire items", at(11));
    // No default section yet: the copy waits and a card goes out instead.
    const second = wire("w2", { source_title: "Clinic network adds a weekend desk" });
    await send(ctx, b, second, at(12));
    await drain(ctx, at(12));
    expect((await receipt(ctx, b, String(second.event_id), at(12))).body).toMatchObject({ reason_code: "CARD_PUBLISHED" });
    expect((await ctx.db.select().from(editorialTasks).where(eq(editorialTasks.kind, "partner_copy_blocked")))[0]?.detail).toBe("PARTNER_SECTION_NOT_SET");

    await ctx.db.update(sources).set({ defaultSectionSlug: "healthcare-delivery" }).where(eq(sources.id, ctx.seed.sources.partner));
    const third = wire("w3", { source_title: "Clinic network publishes holiday hours" });
    await send(ctx, b, third, at(13));
    await drain(ctx, at(13));
    expect((await receipt(ctx, b, String(third.event_id), at(13))).body).toMatchObject({ status: "applied", reason_code: "COPY_PUBLISHED" });
    const page = await getPublicArticle(ctx.db, "clinic-network-publishes-holiday-hours", at(13));
    expect(page.kind === "ok" && page.article).toMatchObject({ type: "licensed_copy", robots: "index", sourceAuthorLabel: "Asha Menon", author: null });
    expect(page.kind === "ok" && (page.article.body as { text: string }[]).map((x) => x.text)).toEqual(["The clinic network has published its timetable.", "Evening hours start next month."]);
    const [copy] = await ctx.db.select().from(articles).where(eq(articles.slug, "clinic-network-publishes-holiday-hours"));
    expect(copy).toMatchObject({ autoPublished: true, isIndexable: true });
    // The copy replaces the card: one public entry for the item, not two.
    expect(await ctx.db.select().from(feedEntries).where(and(eq(feedEntries.status, "active"), eq(feedEntries.articleId, copy!.id)))).toHaveLength(1);
    expect((await listPublicFeed(ctx.db, at(13))).filter((f) => f.title === "Clinic network publishes holiday hours")).toHaveLength(1);

    // A risk-flagged partner item is never automatic, whatever the switches say.
    const risky = wire("w4", { source_title: "Vaccine clinic hours extended" });
    await send(ctx, b, risky, at(14));
    await drain(ctx, at(14));
    expect((await receipt(ctx, b, String(risky.event_id), at(14))).body).toMatchObject({ status: "held", reason_code: "RISK_REVIEW_REQUIRED" });
  });

  it("discards full text from a source whose grant does not cover it", async () => {
    const e = notice({ external_id: "n-body", source_url: "https://health.example/notices/900", source_title: "Tender calendar published", body_text: "Full text the bulletin never licensed to us." });
    await send(ctx, ctx.seed.producers.a, e, at(20));
    await drain(ctx, at(20));
    const [rev] = await ctx.db.select().from(sourceRevisions).where(eq(sourceRevisions.title, "Tender calendar published"));
    expect(rev!.bodyText).toBeNull();
    const [event] = await ctx.db.select().from(ingestEvents).where(eq(ingestEvents.eventId, String(e.event_id)));
    expect(JSON.stringify(event!.payload)).not.toContain("never licensed");
  });
});

describe("reader cases, settings and policy pages (COR-01, GOV-02, SEC-05)", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("issues a case number, routes urgent reports, rate-limits and keeps contact details private", async () => {
    const report = (extra: Record<string, unknown> = {}) => submitCase(ctx.db, { reason: "factual_error", description: "The second window date is wrong.", contact: "reader@example.org", clientKey: "k1", ...extra }, T0);
    const r = await report();
    expect(r.ok && r.caseNumber).toMatch(/^IHN-20261119-\d{6}$/);
    expect(await report({ reason: "nonsense" })).toMatchObject({ ok: false });
    expect(await report({ description: "short" })).toMatchObject({ ok: false });
    const urgent = await report({ reason: "clinical_safety", description: "The dose in the third paragraph looks unsafe." });
    const broken = await report({ reason: "broken_source", description: "The notice link returns an error.", sourceUrl: "https://health.example/notices/204" });
    expect(urgent.ok && broken.ok).toBe(true);
    const tasks = await ctx.db.select().from(editorialTasks);
    expect(tasks.map((t) => t.kind).sort()).toEqual(["reader_case", "reader_case", "urgent_case", "verify_source"]);
    // Nothing a reader typed, and no contact detail, leaks into tasks or the audit trail.
    const leak = JSON.stringify([tasks, await ctx.db.select().from(auditEntries)]);
    expect(leak).not.toContain("reader@example.org");
    expect(leak).not.toContain("looks unsafe");

    for (let i = 0; i < 2; i++) await report();
    expect(await report()).toMatchObject({ ok: false, rateLimited: true });
    expect((await report({ clientKey: "k2" })).ok).toBe(true);

    expect((await rejects(listCases(ctx.db, await ctx.actor("reporter")))).status).toBe(403);
    const editor = await ctx.actor("editor");
    const open = await listCases(ctx.db, editor, "open");
    expect(open[0]!.isUrgent).toBe(true);
    await resolveCase(ctx.db, editor, open[0]!.id, { status: "resolved", decision: "Checked against the label; wording corrected.", response: "Thank you, corrected." }, at(5));
    expect((await ctx.db.select().from(cases).where(eq(cases.id, open[0]!.id)))[0]).toMatchObject({ status: "resolved", ownerId: editor.personId });

    // A reported link shows a status until an editor verifies it.
    expect((await linkStatuses(ctx.db, ["https://health.example/notices/204"])).get("https://health.example/notices/204")?.status).toBe("reported_broken");
    await recordLinkCheck(ctx.db, editor, { url: "https://health.example/notices/204", status: "replaced", replacementUrl: "https://health.example/archive/204", note: "Publisher moved the notice" }, at(6));
    expect((await linkStatuses(ctx.db, ["https://health.example/notices/204"])).get("https://health.example/notices/204")).toEqual({ status: "replaced", replacementUrl: "https://health.example/archive/204" });
  });

  it("fills policy pages from publisher settings and keeps every version", async () => {
    const before = await getPage(ctx.db, "complaints");
    expect(before).toMatchObject({ version: 1, reviewedBy: null });
    expect(before!.missing).toEqual(["Grievance officer name", "Grievance officer contact", "Complaint acknowledgement time", "Complaint resolution time"]);
    expect(JSON.stringify(before!.body)).toContain("[to be confirmed]");

    expect((await rejects(saveSettings(ctx.db, await ctx.actor("editor"), { legal_name: "X" }, T0))).status).toBe(403);
    await saveSettings(ctx.db, await ctx.actor("admin"), { grievance_officer_name: "R. Iyer", grievance_officer_contact: "grievance@newsroom.example", grievance_ack: "24 hours", grievance_resolve: "15 days", not_a_field: "ignored" }, T0);
    const after = await getPage(ctx.db, "complaints");
    expect(after!.missing).toEqual([]);
    expect(JSON.stringify(after!.body)).toContain("R. Iyer, at grievance@newsroom.example");

    const { savePage } = await import("@/core/settings");
    const v2 = await savePage(ctx.db, await ctx.actor("managingEditor"), { slug: "complaints", title: "Complaints", description: "How to complain.", body: [{ type: "paragraph", text: "Write to {{grievance_officer_name}}." }], reviewedBy: "Adviser, 20 Nov 2026", changeNote: "Reviewed and shortened" }, at(10));
    expect(v2).toBe(2);
    const current = await getPage(ctx.db, "complaints");
    expect(current).toMatchObject({ version: 2, reviewedBy: "Adviser, 20 Nov 2026" });
    expect(current!.history.map((h) => h.version)).toEqual([2, 1]);
    expect(await getPage(ctx.db, "no-such-page")).toBeNull();
  });

  it("lets any editor stop automatic publishing, with a reason on record", async () => {
    const editor = await ctx.actor("editor");
    expect((await rejects(setFlag(ctx.db, editor, "indexing", true, "go live", T0))).status).toBe(403);
    expect((await rejects(setFlag(ctx.db, editor, "auto_publish", false, "", T0))).status).toBe(422);
    await setFlag(ctx.db, editor, "auto_publish", false, "Suspected adapter fault", T0);
    expect((await ctx.db.select().from(featureFlags).where(eq(featureFlags.key, "auto_publish")))[0]!.enabled).toBe(false);
    // Intake keeps working. The item is recorded and waits for an editor.
    const e = notice({ external_id: "stop-1", source_url: "https://health.example/notices/950", source_title: "Workshop dates announced" });
    await send(ctx, ctx.seed.producers.a, e, at(1));
    await drain(ctx, at(1));
    expect((await receipt(ctx, ctx.seed.producers.a, String(e.event_id), at(1))).body).toMatchObject({ status: "applied", reason_code: "AWAITING_EDITOR" });
    expect((await rejects(setFlag(ctx.db, editor, "auto_publish", true, "looks fine", at(2)))).status).toBe(403);
  });
});
