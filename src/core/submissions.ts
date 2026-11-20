/**
 * News submissions from the public: press releases, announcements, research
 * and story tips sent to the desk for consideration.
 *
 * A submission is stored as a reader case with the reason `news_submission`,
 * so it lands in the same private queue as reader reports and inherits the
 * same rules (SEC-03): the sender's contact details never reach public pages,
 * logs or analytics, and only editors can read them. Nothing here publishes
 * anything. An editor decides whether a submission becomes a story.
 */
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { cases } from "@/db/schema";
import { audit, openTask } from "./audit";
import { overLimit } from "./auth";

export const SUBMISSION_REASON = "news_submission";

export const SUBMISSION_KINDS = {
  press_release: "Press release or official statement",
  announcement: "Programme, service or event announcement",
  research: "Research, report or data",
  tip: "Story tip",
  other: "Something else",
} as const;
export type SubmissionKind = keyof typeof SUBMISSION_KINDS;

export type SubmissionInput = {
  kind: string;
  name: string;
  organisation?: string;
  email: string;
  phone?: string;
  headline: string;
  details: string;
  link?: string;
  confirmed: boolean;
  clientKey: string;
};

export type SubmissionResult = { ok: true; reference: string } | { ok: false; error: string; rateLimited?: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oneLine = (s: string | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function submitNews(db: Db, input: SubmissionInput, now: Date): Promise<SubmissionResult> {
  if (!(input.kind in SUBMISSION_KINDS)) return { ok: false, error: "Choose what you are sending." };
  const name = oneLine(input.name, 120);
  const organisation = oneLine(input.organisation, 160);
  const email = oneLine(input.email, 160);
  const phone = oneLine(input.phone, 30);
  const headline = oneLine(input.headline, 200);
  const details = input.details.trim();
  const link = (input.link ?? "").trim();

  if (name.length < 2) return { ok: false, error: "Tell us your name." };
  if (!EMAIL.test(email)) return { ok: false, error: "Give an email address we can reply to." };
  if (headline.length < 10) return { ok: false, error: "Give the news a headline of at least ten characters." };
  if (details.length < 50) return { ok: false, error: "Tell us the details in a few sentences: what happened, where, when and who is involved." };
  if (details.length > 5000) return { ok: false, error: "Keep the details under 5,000 characters. Add a link for anything longer." };
  if (link && !/^https:\/\/\S+$/.test(link)) return { ok: false, error: "The link must be a full address starting with https://" };
  if (link.length > 2048) return { ok: false, error: "That link is too long." };
  if (!input.confirmed) return { ok: false, error: "Confirm that the information is accurate and that you may share it." };
  if (await overLimit(db, `submit:${input.clientKey}`, 3, 60, now)) return { ok: false, error: "Too many submissions from this connection. Try again in an hour.", rateLimited: true };

  const kindLabel = SUBMISSION_KINDS[input.kind as SubmissionKind];
  const description = [`Type: ${kindLabel}`, `Headline: ${headline}`, organisation ? `Organisation: ${organisation}` : null, link ? `Link: ${link}` : null, "", details].filter((l) => l !== null).join("\n");
  const contact = [name, organisation || null, email, phone || null].filter(Boolean).join(" · ").slice(0, 300);
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");

  return db.transaction(async (tx) => {
    let reference = "";
    for (let i = 0; i < 5; i++) {
      reference = `IHN-${day}-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
      if ((await tx.select({ id: cases.id }).from(cases).where(eq(cases.caseNumber, reference))).length === 0) break;
    }
    const [row] = await tx.insert(cases).values({ caseNumber: reference, reason: SUBMISSION_REASON, description, reporterContact: contact, isUrgent: false, createdAt: now }).returning({ id: cases.id });
    // The task names the reference and type only. The text and contact stay in the case.
    await openTask(tx, { kind: "news_submission", subjectType: "case", subjectId: row!.id, detail: `${reference}: news submission (${kindLabel.toLowerCase()})` });
    await audit(tx, { actorType: "system", action: "case.open", subjectType: "case", subjectId: row!.id, diff: { reason: SUBMISSION_REASON, kind: input.kind } });
    return { ok: true as const, reference };
  });
}
