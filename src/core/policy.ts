/**
 * Publishing rules (PUB-01..03, ED-04, COR-01). Pure functions, no I/O.
 *
 * The same functions run at ingest, approval and publication, so the most
 * restrictive applicable rule is applied at every step, including scheduled
 * and retried jobs (ING-05).
 */
import type { RiskRoute } from "./risk";

export interface GrantView {
  id: string;
  version: number;
  basis: "unknown" | "link_only" | "public_terms" | "written_permission" | "licence" | "fair_dealing_reviewed";
  allowHeadline: boolean;
  allowExcerpt: boolean;
  excerptMaxChars: number;
  allowFullText: boolean;
  allowImages: boolean;
  channels: string[];
  effectiveAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * The grant in force is the highest effective version. If that version is
 * revoked or expired there is no grant: an older version never comes back.
 */
export function currentGrant<G extends GrantView>(grants: G[], now: Date): G | null {
  const effective = grants.filter((g) => g.effectiveAt <= now).sort((a, b) => b.version - a.version);
  const latest = effective[0];
  if (!latest) return null;
  if (latest.revokedAt && latest.revokedAt <= now) return null;
  if (latest.expiresAt && latest.expiresAt <= now) return null;
  if (latest.basis === "unknown") return null;
  return latest;
}

export type CardOutcome = "publish" | "await_editor" | "hold";

export interface CardDecision {
  outcome: CardOutcome;
  reasons: string[];
}

export interface CardInput {
  sourceStatus: "proposed" | "under_review" | "enabled" | "paused" | "revoked";
  grant: GrantView | null;
  riskRoute: RiskRoute;
  riskFlags: string[];
  flags: { autoPublish: boolean; sourceCards: boolean };
  automationEnabled: boolean;
  embargoUntil: Date | null;
  sourcePublishedAt: Date | null;
  languageMismatch: boolean;
  suppressed: boolean;
  now: Date;
}

/** Ten minutes of tolerance for a source clock that runs ahead. */
const FUTURE_DATE_TOLERANCE_MS = 10 * 60 * 1000;

export function decideSourceCard(i: CardInput): CardDecision {
  const hold: string[] = [];
  if (i.suppressed) hold.push("SUPPRESSED");
  if (i.sourceStatus !== "enabled") hold.push("SOURCE_NOT_ENABLED");
  if (!i.grant) hold.push("RIGHTS_UNKNOWN");
  else if (!i.grant.channels.includes("web")) hold.push("RIGHTS_NO_WEB_CHANNEL");
  if (i.riskRoute !== "routine" || i.riskFlags.length > 0) hold.push("RISK_REVIEW_REQUIRED");
  if (i.embargoUntil && i.embargoUntil > i.now) hold.push("EMBARGO_ACTIVE");
  if (!i.sourcePublishedAt) hold.push("AMBIGUOUS_DATE");
  else if (i.sourcePublishedAt.getTime() > i.now.getTime() + FUTURE_DATE_TOLERANCE_MS) hold.push("AMBIGUOUS_DATE");
  if (i.languageMismatch) hold.push("LANGUAGE_MISMATCH");
  if (hold.length > 0) return { outcome: "hold", reasons: hold };

  const wait: string[] = [];
  if (!i.flags.autoPublish) wait.push("AUTO_PUBLISH_STOPPED");
  if (!i.flags.sourceCards) wait.push("SOURCE_CARDS_DISABLED");
  if (!i.automationEnabled) wait.push("SOURCE_AUTOMATION_OFF");
  if (wait.length > 0) return { outcome: "await_editor", reasons: wait };
  return { outcome: "publish", reasons: [] };
}

/** What a card may show. The headline appears only when it is a permitted field. */
export function cardTitle(grant: GrantView, sourceTitle: string | null, neutralLabel: string | null, publisher: string): string {
  if (grant.allowHeadline && sourceTitle) return sourceTitle;
  return neutralLabel ?? `New notice from ${publisher}`;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ArticlePublishInput {
  type: "original_brief" | "original_report" | "analysis" | "press_material" | "licensed_copy";
  riskRoute: RiskRoute;
  hasAuthor: boolean;
  hasPrimarySection: boolean;
  citationCount: number;
  hasContribution: boolean;
  editorialApprover: string | null;
  medicalApprover: string | null;
  medicalApproverCredentialed: boolean;
  embargoUntil: Date | null;
  suppressed: boolean;
  withdrawnCitations: number;
  /** Licensed copies only. */
  boundGrantId: string | null;
  grant: GrantView | null;
  licensedFeedsEnabled: boolean;
  now: Date;
}

/** Returns every missing requirement, so the API can report them all at once (ADM-02). */
export function checkArticlePublish(i: ArticlePublishInput): FieldError[] {
  const e: FieldError[] = [];
  const add = (field: string, code: string, message: string) => e.push({ field, code, message });

  if (i.suppressed) add("article", "SUPPRESSED", "A removal or retraction decision is in force for this story.");
  if (i.embargoUntil && i.embargoUntil > i.now) add("embargo_until", "EMBARGO_ACTIVE", "The embargo has not been released.");
  if (i.citationCount < 1) add("citations", "SOURCE_REQUIRED", "At least one visible source link is required.");
  if (i.withdrawnCitations > 0) add("citations", "SOURCE_WITHDRAWN", "A cited source has been withdrawn upstream and needs review.");
  if (!i.hasPrimarySection) add("section", "SECTION_REQUIRED", "One primary section is required.");

  if (i.type === "licensed_copy") {
    if (!i.licensedFeedsEnabled) add("rights", "LICENSED_FEEDS_DISABLED", "Licensed republication is switched off.");
    if (!i.grant) add("rights", "RIGHTS_UNKNOWN", "No grant is in force for this source.");
    else {
      if (i.grant.id !== i.boundGrantId) add("rights", "RIGHTS_VERSION_CHANGED", "The grant changed since this copy was prepared.");
      if (!i.grant.allowFullText) add("rights", "FULL_TEXT_NOT_PERMITTED", "The grant does not cover full text.");
      if (!i.grant.channels.includes("web")) add("rights", "RIGHTS_NO_WEB_CHANNEL", "The grant does not cover web publication.");
    }
  } else {
    if (!i.hasAuthor) add("author", "AUTHOR_REQUIRED", "A named author or desk owns each original byline.");
    if (!i.hasContribution && i.type !== "press_material")
      add("contribution", "CONTRIBUTION_REQUIRED", "Record the original contribution. A new headline or light rewrite is not enough.");
  }

  if (!i.editorialApprover) add("approvals.editorial", "EDITORIAL_APPROVAL_MISSING", "An editor must approve this exact version.");
  if (i.riskRoute !== "routine") {
    if (!i.medicalApprover) add("approvals.medical", "MEDICAL_APPROVAL_MISSING", "A credentialed medical reviewer must approve this exact version.");
    else {
      if (!i.medicalApproverCredentialed) add("approvals.medical", "REVIEWER_NOT_CREDENTIALED", "The medical reviewer has no verified credential record.");
      if (i.medicalApprover === i.editorialApprover) add("approvals.medical", "SAME_PERSON", "Editor and medical reviewer must be two distinct people.");
    }
  }
  return e;
}

/** Only independently written work with a recorded contribution gets an indexable local page (PUB-03). */
export function isIndexable(type: ArticlePublishInput["type"], hasContribution: boolean): boolean {
  return type !== "licensed_copy" && type !== "press_material" && hasContribution;
}
