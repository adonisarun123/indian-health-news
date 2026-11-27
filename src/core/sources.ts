/**
 * Source register and rights register commands (SRC-01, SRC-02, ADM-05).
 * Grants are immutable versions. Enabling, revoking, rights and automation
 * belong to a managing editor; a source operator can trial, pause and replay.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { articles, feedEntries, jobs, mediaAssets, sourceAutomation, sourceGrants, sourceHosts, sourceItems, sources, suppressions } from "@/db/schema";
import { type Actor, CommandError } from "./articles";
import { audit, emit, openTask } from "./audit";
import { loadCurrentGrant, pullCard } from "./cards";
import { replayDead } from "./jobs";

const has = (a: Actor, ...roles: Actor["roles"]) => a.roles.some((r) => roles.includes(r));
const needReason = (reason: string | undefined) => {
  if (!reason?.trim()) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.", { fieldErrors: [{ field: "reason", code: "REQUIRED", message: "Record the reason for this action." }] });
  return reason.trim();
};

export interface SourceInput {
  slug: string;
  legalName: string;
  displayName: string;
  homepageUrl: string;
  family: (typeof sources.$inferInsert)["family"];
  language?: string;
  hosts: string[];
  jurisdictionTermId?: string | null;
  contact?: string;
  defaultRiskRoute?: "routine" | "clinical" | "sensitive";
  defaultSectionSlug?: string | null;
  neutralLabel?: string | null;
}

/** Register a candidate source. It starts as proposed with an unknown grant: nothing can publish yet. */
export async function createSource(db: Db, actor: Actor, input: SourceInput, now: Date): Promise<string> {
  if (!has(actor, "source_operator", "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only a source operator or managing editor can register a source.");
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,118}$/.test(input.slug)) errors.push({ field: "slug", code: "INVALID", message: "Use lowercase letters, digits and hyphens." });
  if (!input.legalName.trim() || !input.displayName.trim()) errors.push({ field: "displayName", code: "REQUIRED", message: "Legal and display names are required." });
  let home: URL | null = null;
  try {
    home = new URL(input.homepageUrl);
  } catch {
    /* reported below */
  }
  if (home?.protocol !== "https:") errors.push({ field: "homepageUrl", code: "INVALID", message: "Homepage must be an https URL." });
  const hosts = [...new Set(input.hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
  if (hosts.length === 0 || hosts.some((h) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h))) errors.push({ field: "hosts", code: "INVALID", message: "Give at least one approved host name, such as health.example.gov.in." });
  if (errors.length) throw new CommandError(422, "VALIDATION_FAILED", "The source record is incomplete.", { fieldErrors: errors });
  return db.transaction(async (tx) => {
    if ((await tx.select({ id: sources.id }).from(sources).where(eq(sources.slug, input.slug))).length) throw new CommandError(409, "SLUG_TAKEN", "A source with this identifier exists.");
    const [s] = await tx
      .insert(sources)
      .values({ slug: input.slug, legalName: input.legalName.trim(), displayName: input.displayName.trim(), homepageUrl: home!.toString(), family: input.family, language: input.language ?? "en", jurisdictionTermId: input.jurisdictionTermId ?? null, contact: input.contact ?? null, defaultRiskRoute: input.defaultRiskRoute ?? "routine", defaultSectionSlug: input.defaultSectionSlug ?? null, neutralLabel: input.neutralLabel ?? null, ownerPersonId: actor.personId, createdAt: now, updatedAt: now })
      .returning();
    for (const host of hosts) await tx.insert(sourceHosts).values({ sourceId: s!.id, host });
    await tx.insert(sourceGrants).values({ sourceId: s!.id, version: 1, basis: "unknown", createdBy: actor.personId, effectiveAt: now });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "source.create", subjectType: "source", subjectId: s!.id, diff: { hosts } });
    return s!.id;
  });
}

export interface RegisterOutcome {
  slug: string;
  outcome: "registered" | "exists" | "hosts_differ" | "failed";
  status?: string;
  detail?: string;
}

/**
 * Register several sources at once, such as the scraper's manifest. A source
 * already in the register is left untouched and reported, with a note when its
 * approved hosts differ from the input. With `trialReason`, each new source
 * moves to under_review: intake is open, and nothing publishes while its grant
 * is unknown.
 */
export async function registerSources(db: Db, actor: Actor, inputs: SourceInput[], now: Date, opts: { trialReason?: string } = {}): Promise<RegisterOutcome[]> {
  const out: RegisterOutcome[] = [];
  for (const input of inputs) {
    const [existing] = await db.select({ id: sources.id, status: sources.status }).from(sources).where(eq(sources.slug, input.slug));
    if (existing) {
      const have = (await db.select({ host: sourceHosts.host }).from(sourceHosts).where(eq(sourceHosts.sourceId, existing.id))).map((h) => h.host).sort();
      const want = [...new Set(input.hosts.map((h) => h.trim().toLowerCase()))].sort();
      const same = have.length === want.length && have.every((h, i) => h === want[i]);
      out.push(same ? { slug: input.slug, outcome: "exists", status: existing.status } : { slug: input.slug, outcome: "hosts_differ", status: existing.status, detail: `register has ${have.join(" ")}; input has ${want.join(" ")}` });
      continue;
    }
    try {
      const id = await createSource(db, actor, input, now);
      const status = opts.trialReason ? (await sourceAction(db, actor, id, { action: "trial", reason: opts.trialReason }, now)).status : "proposed";
      out.push({ slug: input.slug, outcome: "registered", status });
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      out.push({ slug: input.slug, outcome: "failed", detail: `${e.code} ${e.message}${e.extra?.fieldErrors ? ` ${JSON.stringify(e.extra.fieldErrors)}` : ""}` });
    }
  }
  return out;
}

export interface GrantInput {
  basis: (typeof sourceGrants.$inferInsert)["basis"];
  evidenceUri: string;
  termsUrl?: string;
  allowHeadline: boolean;
  allowExcerpt: boolean;
  excerptMaxChars?: number;
  allowFullText: boolean;
  allowImages: boolean;
  channels: string[];
  attributionText?: string;
  expiresAt?: Date | null;
  reviewAt?: Date | null;
  reason: string;
}

/** Record a new grant version. The previous version stays on file as rights history. */
export async function addGrant(db: Db, actor: Actor, sourceId: string, input: GrantInput, now: Date): Promise<number> {
  if (!has(actor, "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only a managing editor can record a rights grant.");
  const reason = needReason(input.reason);
  const errors = [];
  if (input.basis !== "unknown" && !input.evidenceUri?.trim()) errors.push({ field: "evidenceUri", code: "REQUIRED", message: "Record where the evidence for this permission is kept." });
  if (input.basis === "link_only" && (input.allowFullText || input.allowImages || input.allowExcerpt)) errors.push({ field: "basis", code: "INVALID", message: "A link-only basis cannot allow excerpts, full text or images." });
  const channels = input.channels.filter((c) => ["web", "rss", "social"].includes(c));
  if (input.basis !== "unknown" && channels.length === 0) errors.push({ field: "channels", code: "REQUIRED", message: "Choose at least one distribution channel." });
  if (input.expiresAt && input.expiresAt <= now) errors.push({ field: "expiresAt", code: "PAST", message: "Expiry must be in the future." });
  if (errors.length) throw new CommandError(422, "VALIDATION_FAILED", "The grant is incomplete.", { fieldErrors: errors });
  return db.transaction(async (tx) => {
    await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, sourceId)).for("update");
    const [last] = await tx.select({ v: sourceGrants.version }).from(sourceGrants).where(eq(sourceGrants.sourceId, sourceId)).orderBy(desc(sourceGrants.version)).limit(1);
    const version = (last?.v ?? 0) + 1;
    await tx.insert(sourceGrants).values({ sourceId, version, basis: input.basis, evidenceUri: input.evidenceUri?.trim() || null, termsUrl: input.termsUrl?.trim() || null, allowHeadline: input.allowHeadline, allowExcerpt: input.allowExcerpt, excerptMaxChars: input.excerptMaxChars ?? 0, allowFullText: input.allowFullText, allowImages: input.allowImages, channels, attributionText: input.attributionText?.trim() || null, expiresAt: input.expiresAt ?? null, reviewAt: input.reviewAt ?? null, createdBy: actor.personId, effectiveAt: now });
    await tx.update(sources).set({ policyVersion: sql`${sources.policyVersion} + 1`, updatedAt: now }).where(eq(sources.id, sourceId));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "source.grant", subjectType: "source", subjectId: sourceId, reason, diff: { version, basis: input.basis, channels, fullText: input.allowFullText, images: input.allowImages } });
    return version;
  });
}

/** What a pause or revocation would touch, shown before a managing editor confirms (ADM-05). */
export async function sourceImpact(db: Db | Tx, sourceId: string) {
  const items = await db.select({ id: sourceItems.id }).from(sourceItems).where(eq(sourceItems.sourceId, sourceId));
  const ids = items.map((i) => i.id);
  const cards = ids.length ? await db.select({ id: feedEntries.id }).from(feedEntries).where(and(inArray(feedEntries.sourceItemId, ids), eq(feedEntries.status, "active"))) : [];
  const copies = ids.length ? await db.select({ id: articles.id }).from(articles).where(and(inArray(articles.sourceItemId, ids), eq(articles.type, "licensed_copy"), eq(articles.status, "published"))) : [];
  const grantIds = (await db.select({ id: sourceGrants.id }).from(sourceGrants).where(eq(sourceGrants.sourceId, sourceId))).map((g) => g.id);
  const assets = grantIds.length ? await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(inArray(mediaAssets.grantId, grantIds), isNull(mediaAssets.withdrawnAt))) : [];
  return { publicCards: cards.length, publicCopies: copies.length, assets: assets.length, copyIds: copies.map((c) => c.id), itemIds: ids };
}

export type SourceAction = "trial" | "enable" | "pause" | "revoke" | "replay";

export interface SourceActionResult {
  status: string;
  grantVersion: number | null;
  affected: { publicCards: number; publicCopies: number; assets: number; jobsReplayed: number };
}

export async function sourceAction(db: Db, actor: Actor, sourceId: string, input: { action: SourceAction; reason?: string }, now: Date): Promise<SourceActionResult> {
  const operator = has(actor, "source_operator", "managing_editor");
  const manager = has(actor, "managing_editor");
  if (!operator) throw new CommandError(403, "FORBIDDEN", "This account cannot manage sources.");
  if ((input.action === "enable" || input.action === "revoke") && !manager) throw new CommandError(403, "FORBIDDEN", "Only a managing editor can enable or revoke a source.");
  const reason = needReason(input.reason);

  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(sources).where(eq(sources.id, sourceId)).for("update");
    if (!s) throw new CommandError(404, "NOT_FOUND", "No such source.");
    const grant = await loadCurrentGrant(tx, s.id, now);
    const impact = await sourceImpact(tx, s.id);
    const affected = { publicCards: 0, publicCopies: 0, assets: 0, jobsReplayed: 0 };
    let status = s.status;
    const bad = (msg: string) => new CommandError(409, "INVALID_STATE", msg);

    switch (input.action) {
      case "trial":
        if (s.status !== "proposed" && s.status !== "paused") throw bad(`A ${s.status} source cannot start a trial.`);
        status = "under_review";
        break;
      case "enable":
        if (s.status === "revoked") throw bad("A revoked source cannot be enabled. Register it again with a new grant.");
        if (!grant) throw new CommandError(422, "RIGHTS_UNKNOWN", "Record a grant before enabling this source.", { fieldErrors: [{ field: "rights", code: "RIGHTS_UNKNOWN", message: "No grant is in force." }] });
        status = "enabled";
        break;
      case "pause":
        // A pause stops new intake. What is already public stays (COR-02).
        if (s.status !== "enabled" && s.status !== "under_review") throw bad(`A ${s.status} source cannot be paused.`);
        status = "paused";
        break;
      case "revoke": {
        // Revocation also takes down every affected card, copy and asset.
        status = "revoked";
        await tx.update(sourceGrants).set({ revokedAt: now, revokedReason: reason }).where(and(eq(sourceGrants.sourceId, s.id), isNull(sourceGrants.revokedAt)));
        await tx.update(sourceAutomation).set({ enabled: false, updatedBy: actor.personId, updatedAt: now }).where(eq(sourceAutomation.sourceId, s.id));
        for (const itemId of impact.itemIds) affected.publicCards += await pullCard(tx, itemId, "suppressed", "SOURCE_REVOKED");
        for (const copyId of impact.copyIds) {
          await tx.insert(suppressions).values({ subjectType: "article", subjectId: copyId, kind: "rights_revocation", reason, decidedBy: actor.personId, createdAt: now });
          await tx.update(feedEntries).set({ status: "suppressed" }).where(and(eq(feedEntries.articleId, copyId), eq(feedEntries.status, "active")));
          await emit(tx, { eventType: "article.suppressed", aggregateType: "article", aggregateId: copyId, payload: { kind: "rights_revocation" } });
          affected.publicCopies++;
        }
        const grantIds = (await tx.select({ id: sourceGrants.id }).from(sourceGrants).where(eq(sourceGrants.sourceId, s.id))).map((g) => g.id);
        if (grantIds.length) affected.assets = (await tx.update(mediaAssets).set({ withdrawnAt: now }).where(and(inArray(mediaAssets.grantId, grantIds), isNull(mediaAssets.withdrawnAt))).returning({ id: mediaAssets.id })).length;
        await openTask(tx, { kind: "source_revoked_review", subjectType: "source", subjectId: s.id, detail: "Review original stories that cite this source." });
        break;
      }
      case "replay": {
        const dead = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.queue, `source:${s.id}`), eq(jobs.status, "dead")));
        for (const j of dead) if (await replayDead(tx, j.id, now)) affected.jobsReplayed++;
        await tx.execute(sql`update ingest_events set status = 'accepted', reason_code = null where source_id = ${s.id} and status = 'failed'`);
        break;
      }
    }
    if (status !== s.status) await tx.update(sources).set({ status, updatedAt: now }).where(eq(sources.id, s.id));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: `source.${input.action}`, subjectType: "source", subjectId: s.id, reason, diff: { from: s.status, to: status, ...affected } });
    return { status, grantVersion: grant?.version ?? null, affected };
  });
}

/** Per-source, per-format automation switch (PUB-01). The switch and its history are audited. */
export async function setAutomation(db: Db, actor: Actor, sourceId: string, format: "source_card" | "licensed_copy", enabled: boolean, reason: string, now: Date): Promise<void> {
  if (!has(actor, "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only a managing editor decides which feeds may publish automatically.");
  needReason(reason);
  await db.transaction(async (tx) => {
    await tx.insert(sourceAutomation).values({ sourceId, format, enabled, updatedBy: actor.personId, updatedAt: now }).onConflictDoUpdate({ target: [sourceAutomation.sourceId, sourceAutomation.format], set: { enabled, updatedBy: actor.personId, updatedAt: now } });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "source.automation", subjectType: "source", subjectId: sourceId, reason, diff: { format, enabled } });
  });
}
