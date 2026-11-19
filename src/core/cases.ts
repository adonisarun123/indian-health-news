/**
 * Reader reports and complaints (COR-01, COR-02, SEC-03). Contact details are
 * private: they never reach public pages, logs or analytics, and only staff
 * who handle cases can read them.
 */
import { randomInt } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { articles, cases, linkChecks } from "@/db/schema";
import { type Actor, CommandError } from "./articles";
import { audit, openTask } from "./audit";
import { overLimit } from "./auth";

export const CASE_REASONS = {
  factual_error: "Factual error",
  broken_source: "Broken or wrong source link",
  rights_objection: "Rights objection",
  privacy_concern: "Privacy concern",
  clinical_safety: "Urgent clinical safety concern",
  other: "Something else",
} as const;
export type CaseReason = keyof typeof CASE_REASONS;
const URGENT = new Set<string>(["clinical_safety", "privacy_concern"]);

export type SubmitResult = { ok: true; caseNumber: string } | { ok: false; error: string; rateLimited?: boolean };

export async function submitCase(db: Db, input: { reason: string; description: string; contact?: string; articleSlug?: string; sourceUrl?: string; clientKey: string }, now: Date): Promise<SubmitResult> {
  if (!(input.reason in CASE_REASONS)) return { ok: false, error: "Choose a reason." };
  const description = input.description.trim();
  if (description.length < 10) return { ok: false, error: "Tell us what is wrong in a sentence or two." };
  if (description.length > 5000) return { ok: false, error: "Keep the report under 5,000 characters." };
  if (await overLimit(db, `report:${input.clientKey}`, 5, 60, now)) return { ok: false, error: "Too many reports from this connection. Try again in an hour.", rateLimited: true };

  const [article] = input.articleSlug ? await db.select({ id: articles.id }).from(articles).where(eq(articles.slug, input.articleSlug)) : [];
  const urgent = URGENT.has(input.reason);
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return db.transaction(async (tx) => {
    let caseNumber = "";
    for (let i = 0; i < 5; i++) {
      caseNumber = `IHN-${day}-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
      if ((await tx.select({ id: cases.id }).from(cases).where(eq(cases.caseNumber, caseNumber))).length === 0) break;
    }
    const [row] = await tx.insert(cases).values({ caseNumber, reason: input.reason, articleId: article?.id ?? null, description, reporterContact: input.contact?.trim().slice(0, 300) || null, isUrgent: urgent, createdAt: now }).returning({ id: cases.id });
    // The task names the case only. No description or contact is copied anywhere else.
    await openTask(tx, { kind: urgent ? "urgent_case" : "reader_case", subjectType: "case", subjectId: row!.id, detail: `${caseNumber}: ${CASE_REASONS[input.reason as CaseReason]}` });
    if (input.reason === "broken_source" && input.sourceUrl?.startsWith("https://")) {
      await tx.insert(linkChecks).values({ url: input.sourceUrl.slice(0, 2048), status: "reported_broken", note: caseNumber, createdAt: now });
      await openTask(tx, { kind: "verify_source", subjectType: "case", subjectId: row!.id, detail: `${caseNumber}: reader reports a broken source link` });
    }
    await audit(tx, { actorType: "system", action: "case.open", subjectType: "case", subjectId: row!.id, diff: { reason: input.reason, urgent } });
    return { ok: true as const, caseNumber };
  });
}

const handlesCases = (a: Actor) => a.roles.some((r) => r === "editor" || r === "managing_editor");

export async function listCases(db: Db, actor: Actor, status?: "open" | "in_progress" | "resolved" | "rejected") {
  if (!handlesCases(actor)) throw new CommandError(403, "FORBIDDEN", "Only editors handle reader cases.");
  return db.select().from(cases).where(status ? eq(cases.status, status) : undefined).orderBy(desc(cases.isUrgent), desc(cases.createdAt)).limit(200);
}

export async function resolveCase(db: Db, actor: Actor, caseId: string, input: { status: "in_progress" | "resolved" | "rejected"; decision: string; response?: string }, now: Date): Promise<void> {
  if (!handlesCases(actor)) throw new CommandError(403, "FORBIDDEN", "Only editors handle reader cases.");
  if (!input.decision.trim()) throw new CommandError(422, "VALIDATION_FAILED", "Record the decision and its basis.");
  const closed = input.status !== "in_progress";
  await db.transaction(async (tx) => {
    await tx.update(cases).set({ status: input.status, ownerId: actor.personId, decision: input.decision.trim(), response: input.response?.trim() || null, resolvedAt: closed ? now : null }).where(eq(cases.id, caseId));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: `case.${input.status}`, subjectType: "case", subjectId: caseId, reason: input.decision.trim() });
  });
}

/** Record the outcome of checking a cited link. The public source list shows the latest status. */
export async function recordLinkCheck(db: Db, actor: Actor, input: { url: string; status: "broken" | "replaced" | "ok"; replacementUrl?: string; note: string }, now: Date): Promise<void> {
  if (!handlesCases(actor)) throw new CommandError(403, "FORBIDDEN", "Only editors verify sources.");
  if (input.status === "replaced" && !input.replacementUrl?.startsWith("https://")) throw new CommandError(422, "VALIDATION_FAILED", "A verified https replacement is required.");
  await db.insert(linkChecks).values({ url: input.url, status: input.status, replacementUrl: input.replacementUrl ?? null, note: input.note, checkedBy: actor.personId, createdAt: now });
  await audit(db, { actorType: "staff", actorId: actor.personId, action: "source_link.check", subjectType: "url", subjectId: input.url.slice(0, 200), reason: input.note, diff: { status: input.status } });
}

/** Latest known status for each URL: ok is the default when a link was never questioned. */
export async function linkStatuses(db: Db, urls: string[]): Promise<Map<string, { status: string; replacementUrl: string | null }>> {
  const out = new Map<string, { status: string; replacementUrl: string | null }>();
  for (const url of urls) {
    const [row] = await db.select().from(linkChecks).where(and(eq(linkChecks.url, url))).orderBy(desc(linkChecks.createdAt)).limit(1);
    if (row && row.status !== "ok") out.set(url, { status: row.status, replacementUrl: row.replacementUrl });
  }
  return out;
}
