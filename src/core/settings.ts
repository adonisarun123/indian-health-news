/**
 * Publisher settings, rollout flags and versioned policy pages (GOV-01, GOV-02).
 * Facts about the publisher live in settings and are merged into page text at
 * render time, so one correction to a contact reaches every page.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { featureFlags, settings, sitePages } from "@/db/schema";
import { type Actor, type Block, CommandError } from "./articles";
import { audit } from "./audit";

export const PUBLISHER_FIELDS = [
  { key: "legal_name", label: "Legal publisher name", hint: "The registered entity that publishes the site." },
  { key: "registered_address", label: "Registered address", hint: "" },
  { key: "ownership_funding", label: "Ownership and funding", hint: "Who owns the publisher and how the newsroom is funded." },
  { key: "contact_email", label: "Newsroom email", hint: "" },
  { key: "contact_phone", label: "Newsroom phone", hint: "Optional." },
  { key: "rights_contact", label: "Rights and licensing contact", hint: "Email for publishers and rights holders." },
  { key: "grievance_officer_name", label: "Grievance officer name", hint: "" },
  { key: "grievance_officer_contact", label: "Grievance officer contact", hint: "Email and, if applicable, postal address." },
  { key: "grievance_ack", label: "Complaint acknowledgement time", hint: "For example: 24 hours." },
  { key: "grievance_resolve", label: "Complaint resolution time", hint: "For example: 15 days." },
  { key: "privacy_contact", label: "Privacy request contact", hint: "" },
  { key: "case_retention", label: "Retention of reader report contact details", hint: "For example: 12 months after the case is closed." },
  { key: "governing_law", label: "Governing law and courts", hint: "For example: the laws of India and the courts at Bengaluru." },
  { key: "advertising_policy", label: "Advertising and sponsorship policy", hint: "One or two sentences, or 'The site carries no advertising.'" },
] as const;

export type PublisherKey = (typeof PUBLISHER_FIELDS)[number]["key"];
const OPTIONAL = new Set<string>(["contact_phone"]);

export async function getSettings(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const canConfigure = (a: Actor) => a.roles.some((r) => r === "administrator" || r === "managing_editor");

export async function saveSettings(db: Db, actor: Actor, values: Record<string, string>, now: Date): Promise<void> {
  if (!canConfigure(actor)) throw new CommandError(403, "FORBIDDEN", "Only an administrator or managing editor can change publisher settings.");
  const allowed = new Set<string>(PUBLISHER_FIELDS.map((f) => f.key));
  await db.transaction(async (tx) => {
    const before = Object.fromEntries((await tx.select().from(settings)).map((r) => [r.key, r.value]));
    const changed: string[] = [];
    for (const [key, raw] of Object.entries(values)) {
      if (!allowed.has(key)) continue;
      const value = raw.trim().slice(0, 2000);
      if ((before[key] ?? "") === value) continue;
      changed.push(key);
      if (value) await tx.insert(settings).values({ key, value, updatedBy: actor.personId, updatedAt: now }).onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actor.personId, updatedAt: now } });
      else await tx.delete(settings).where(eq(settings.key, key));
    }
    if (changed.length) await audit(tx, { actorType: "staff", actorId: actor.personId, action: "settings.update", subjectType: "settings", subjectId: "publisher", diff: { changed } });
  });
}

export const FLAG_LABELS: Record<string, string> = {
  auto_publish: "Automatic publishing (all sources). Turning this off stops every automatic post and keeps items for review.",
  source_cards: "Source cards",
  licensed_feeds: "Licensed partner republication",
  indexing: "Search engine indexing",
};

/** The duty switch (SEC-05, rollout controls). Every change needs a reason and is audited. */
export async function setFlag(db: Db, actor: Actor, key: string, enabled: boolean, reason: string, now: Date): Promise<void> {
  if (!canConfigure(actor) && !(key === "auto_publish" && !enabled && actor.roles.includes("editor"))) {
    throw new CommandError(403, "FORBIDDEN", "Only an administrator or managing editor can change rollout controls. Any editor can stop automatic publishing.");
  }
  if (!(key in FLAG_LABELS)) throw new CommandError(404, "NOT_FOUND", "No such control.");
  if (!reason) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.");
  await db.transaction(async (tx) => {
    await tx.insert(featureFlags).values({ key, enabled, updatedBy: actor.personId, updatedAt: now }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled, updatedBy: actor.personId, updatedAt: now } });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "flag.set", subjectType: "feature_flag", subjectId: key, reason, diff: { enabled } });
  });
}

/* ── policy pages ── */

export const PAGE_SLUGS = ["about", "editorial-policy", "contact", "complaints", "privacy", "terms"] as const;
export type PageSlug = (typeof PAGE_SLUGS)[number];

export interface RenderedPage {
  slug: string;
  version: number;
  title: string;
  description: string;
  body: Block[];
  effectiveAt: Date;
  reviewedBy: string | null;
  /** Publisher facts this page needs that have not been supplied. */
  missing: string[];
  history: { version: number; effectiveAt: Date; changeNote: string | null }[];
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

function fill(text: string, values: Record<string, string>, missing: Set<string>): string {
  return text.replace(PLACEHOLDER, (_m, key: string) => {
    if (values[key]) return values[key];
    if (!OPTIONAL.has(key)) missing.add(key);
    return "[to be confirmed]";
  });
}

export async function getPage(db: Db, slug: string): Promise<RenderedPage | null> {
  const versions = await db.select().from(sitePages).where(eq(sitePages.slug, slug)).orderBy(desc(sitePages.version));
  const current = versions[0];
  if (!current) return null;
  const values = await getSettings(db);
  const missing = new Set<string>();
  const body = (current.body as Block[]).map((b) => (b.type === "list" ? { ...b, items: b.items.map((i) => fill(i, values, missing)) } : { ...b, text: fill(b.text, values, missing) }));
  const labels = new Map<string, string>(PUBLISHER_FIELDS.map((f) => [f.key, f.label]));
  return {
    slug,
    version: current.version,
    title: current.title,
    description: current.description,
    body,
    effectiveAt: current.effectiveAt,
    reviewedBy: current.reviewedBy,
    missing: [...missing].map((k) => labels.get(k) ?? k),
    history: versions.map((v) => ({ version: v.version, effectiveAt: v.effectiveAt, changeNote: v.changeNote })),
  };
}

export async function getPageSource(db: Db, slug: string) {
  const [row] = await db.select().from(sitePages).where(eq(sitePages.slug, slug)).orderBy(desc(sitePages.version)).limit(1);
  return row ?? null;
}

/** Save a new immutable version of a policy page. Earlier versions stay on record. */
export async function savePage(db: Db, actor: Actor | null, input: { slug: string; title: string; description: string; body: Block[]; reviewedBy?: string | null; changeNote: string }, now: Date): Promise<number> {
  if (actor && !canConfigure(actor)) throw new CommandError(403, "FORBIDDEN", "Only an administrator or managing editor can change policy pages.");
  if (!(PAGE_SLUGS as readonly string[]).includes(input.slug)) throw new CommandError(404, "NOT_FOUND", "No such page.");
  if (!input.title.trim() || input.body.length === 0 || !input.changeNote.trim()) throw new CommandError(422, "VALIDATION_FAILED", "Title, body and a change note are required.");
  return db.transaction(async (tx) => {
    const [last] = await tx.select({ v: sitePages.version }).from(sitePages).where(eq(sitePages.slug, input.slug)).orderBy(desc(sitePages.version)).limit(1);
    const version = (last?.v ?? 0) + 1;
    await tx.insert(sitePages).values({ slug: input.slug, version, title: input.title.trim(), description: input.description.trim(), body: input.body, reviewedBy: input.reviewedBy?.trim() || null, changeNote: input.changeNote.trim(), createdBy: actor?.personId ?? null, effectiveAt: now });
    await audit(tx, { actorType: actor ? "staff" : "system", actorId: actor?.personId, action: "page.save", subjectType: "site_page", subjectId: input.slug, reason: input.changeNote, diff: { version } });
    return version;
  });
}

export async function pageExists(db: Db, slug: string): Promise<boolean> {
  return (await db.select({ id: sitePages.id }).from(sitePages).where(and(eq(sitePages.slug, slug))).limit(1)).length > 0;
}
