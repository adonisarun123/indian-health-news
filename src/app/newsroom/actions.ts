"use server";

/**
 * Newsroom form actions. Each one re-reads the session, calls a core command
 * and redirects back with a result message. All permission and state rules
 * live in the core commands: nothing here decides who may do what.
 */
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { CommandError, createArticle, createLicensedCopy, patchArticle, performAction, renameSlug, setLead, type StaffRole, textToBlocks } from "@/core/articles";
import { completeEnrolment, inviteStaff, reinviteStaff, setPersonActive, setRole, signIn, signOut, type StaffSession, updateProfile } from "@/core/auth";
import { releaseCard } from "@/core/cards";
import { recordLinkCheck, resolveCase, submitCase } from "@/core/cases";
import { closeTask, getItem } from "@/core/desk";
import { decideClusterItem } from "@/core/ingest/process";
import { saveSettings, savePage, setFlag } from "@/core/settings";
import { addGrant, createSource, setAutomation, sourceAction, type SourceAction } from "@/core/sources";
import { parseCitations, parseMarkup } from "@/lib/markup";
import { pump } from "@/lib/pump";
import { clearSessionCookie, clientKey, requireStaff, SESSION_COOKIE, setSessionCookie } from "@/lib/session";
import { cookies } from "next/headers";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const flag = (f: FormData, k: string) => f.get(k) === "on" || f.get(k) === "true";
const withParam = (path: string, key: string, value: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

function describe(e: CommandError): string {
  const fields = (e.extra.fieldErrors ?? []).map((f) => f.message).join(" ");
  const stale = e.code === "STALE_VERSION" ? " Reload the page to see the latest version, then reapply your change." : "";
  return `${e.message}${fields ? ` ${fields}` : ""}${stale}`;
}

/** Run a command as the signed-in member of staff and redirect with the outcome. */
async function run(back: string, fn: (staff: StaffSession) => Promise<{ to?: string; ok?: string } | void>): Promise<never> {
  const staff = await requireStaff();
  let target: string;
  try {
    const r = (await fn(staff)) ?? {};
    target = withParam(r.to ?? back, "ok", r.ok ?? "Saved.");
    // Deliver any publication event this command produced as soon as the response has gone.
    pump();
  } catch (e) {
    if (!(e instanceof CommandError)) throw e;
    target = withParam(back, "error", describe(e));
  }
  redirect(target);
}

/* ── sign-in ── */

export async function loginAction(f: FormData): Promise<never> {
  const result = await signIn(getDb(), { email: str(f, "email"), password: String(f.get("password") ?? ""), code: str(f, "code"), userAgent: (await headers()).get("user-agent") }, new Date());
  if (!result.ok) redirect(withParam("/newsroom/login", "error", result.error));
  await setSessionCookie(result.token);
  redirect("/newsroom");
}

export async function logoutAction(): Promise<never> {
  await signOut(getDb(), (await cookies()).get(SESSION_COOKIE)?.value, new Date());
  await clearSessionCookie();
  redirect("/newsroom/login");
}

export async function enrolAction(token: string, f: FormData): Promise<never> {
  const password = String(f.get("password") ?? "");
  if (password !== String(f.get("confirm") ?? "")) redirect(withParam(`/newsroom/invite/${token}`, "error", "The two passwords do not match."));
  const result = await completeEnrolment(getDb(), token, password, str(f, "code"), new Date());
  if (!result.ok) redirect(withParam(`/newsroom/invite/${token}`, "error", result.error));
  redirect(withParam("/newsroom/login", "ok", "Account ready. Sign in with your password and a new code."));
}

/* ── stories ── */

function storyFields(f: FormData) {
  const state = str(f, "state");
  return {
    headline: str(f, "headline"),
    standfirst: str(f, "standfirst"),
    body: parseMarkup(String(f.get("body") ?? "")),
    sectionSlug: str(f, "section"),
    termSlugs: state ? [{ kind: "state" as const, slug: state }] : [],
    citations: parseCitations(String(f.get("citations") ?? "")),
    contribution: str(f, "contribution") || null,
    contributionNote: str(f, "contributionNote") || null,
    correctionNote: str(f, "correctionNote") || null,
    assistModel: str(f, "assistModel") || null,
  };
}

const istToIso = (local: string) => (local ? `${local.length === 16 ? `${local}:00` : local}+05:30` : null);

export async function storyCreateAction(f: FormData): Promise<never> {
  return run("/newsroom/stories/new", async (staff) => {
    const created = await createArticle(getDb(), staff, { type: str(f, "type"), ...storyFields(f), embargoUntil: istToIso(str(f, "embargoUntil")) }, new Date());
    return { to: `/newsroom/stories/${created.id}`, ok: "Draft created." };
  });
}

export async function storySaveAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/stories/${id}`, async (staff) => {
    // An empty embargo field leaves the current embargo alone. Clearing it is an explicit choice.
    const embargo = str(f, "embargoUntil") ? { embargoUntil: istToIso(str(f, "embargoUntil")) } : flag(f, "clearEmbargo") ? { embargoUntil: null } : {};
    await patchArticle(getDb(), staff, id, { expectedVersion: Number(str(f, "expectedVersion")), ...storyFields(f), ...embargo }, new Date());
    return { ok: "Saved as a new version. Earlier approvals no longer apply." };
  });
}

export async function storyCommandAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/stories/${id}`, async (staff) => {
    const action = str(f, "action");
    const removal = str(f, "removalStatus");
    await performAction(
      getDb(),
      staff,
      id,
      {
        action,
        expectedVersion: Number(str(f, "expectedVersion")),
        idempotencyKey: str(f, "idempotencyKey") || randomUUID(),
        ...(str(f, "reason") ? { reason: str(f, "reason") } : {}),
        ...(str(f, "evidence") ? { evidence: str(f, "evidence") } : {}),
        ...(str(f, "publicNote") ? { publicNote: str(f, "publicNote") } : {}),
        ...(action === "schedule" && str(f, "scheduledAt") ? { scheduledAt: istToIso(str(f, "scheduledAt"))! } : {}),
        ...(action === "remove" ? { removalStatus: removal === "451" ? 451 : 410 } : {}),
        ...(action === "classify" ? { riskRoute: str(f, "riskRoute") } : {}),
      },
      new Date(),
    );
    return { ok: `Done: ${action}.` };
  });
}

export async function storyMoveAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/stories/${id}`, async (staff) => {
    await renameSlug(getDb(), staff, id, { expectedVersion: Number(str(f, "expectedVersion")), slug: str(f, "slug"), reason: str(f, "reason") }, new Date());
    return { ok: "Address changed. The old address redirects." };
  });
}

export async function storyLeadAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/stories/${id}`, async (staff) => {
    const rank = str(f, "rank");
    await setLead(getDb(), staff, id, { rank: rank ? Number(rank) : null, until: istToIso(str(f, "until")) ? new Date(istToIso(str(f, "until"))!) : null, reason: str(f, "reason") || "Lead placement" });
    return { ok: rank ? "Lead placement set." : "Lead placement cleared." };
  });
}

/* ── queue ── */

export async function cardReleaseAction(itemId: string, f: FormData): Promise<never> {
  return run(`/newsroom/items/${itemId}`, async (staff) => {
    const reason = str(f, "reason");
    if (!reason) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.");
    const r = await getDb().transaction((tx) => releaseCard(tx, staff, itemId, reason, new Date()));
    if (!r.ok) throw new CommandError(422, "RELEASE_BLOCKED", `This item cannot be released as a card: ${r.reasons.join(", ")}.`);
    return { ok: "Source card published." };
  });
}

export async function partnerCopyAction(itemId: string, f: FormData): Promise<never> {
  return run(`/newsroom/items/${itemId}`, async (staff) => {
    const item = await getItem(getDb(), itemId);
    const current = item?.revisions[0];
    if (!current?.bodyText) throw new CommandError(422, "NO_BODY", "This item has no licensed full text to republish.");
    const copy = await createLicensedCopy(getDb(), staff, { sourceRevisionId: current.id, body: textToBlocks(current.bodyText), sectionSlug: str(f, "section") }, new Date());
    return { to: `/newsroom/stories/${copy.id}`, ok: "Partner copy prepared. Approve and publish it from here." };
  });
}

export async function taskCloseAction(taskId: string, f: FormData): Promise<never> {
  return run("/newsroom", async () => {
    await closeTask(getDb(), taskId, str(f, "status") === "dismissed" ? "dismissed" : "done", new Date());
    return { ok: "Task closed." };
  });
}

export async function clusterDecideAction(itemId: string, f: FormData): Promise<never> {
  return run(`/newsroom/items/${itemId}`, async (staff) => {
    if (!staff.roles.some((r) => r === "editor" || r === "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only an editor can merge or split a cluster.");
    if (!str(f, "reason")) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.");
    await decideClusterItem(getDb(), staff, { clusterId: str(f, "clusterId"), itemId: str(f, "otherItemId"), decision: str(f, "decision") === "rejected" ? "rejected" : "confirmed", reason: str(f, "reason") }, new Date());
    return { ok: "Cluster decision recorded." };
  });
}

/* ── sources ── */

export async function sourceCreateAction(f: FormData): Promise<never> {
  return run("/newsroom/sources/new", async (staff) => {
    const id = await createSource(
      getDb(),
      staff,
      { slug: str(f, "slug"), legalName: str(f, "legalName"), displayName: str(f, "displayName"), homepageUrl: str(f, "homepageUrl"), family: str(f, "family") as never, language: str(f, "language") || "en", hosts: str(f, "hosts").split(/[\s,]+/), jurisdictionTermId: str(f, "jurisdiction") || null, contact: str(f, "contact"), defaultRiskRoute: (str(f, "defaultRiskRoute") || "routine") as never, defaultSectionSlug: str(f, "defaultSection") || null, neutralLabel: str(f, "neutralLabel") || null },
      new Date(),
    );
    return { to: `/newsroom/sources/${id}`, ok: "Source registered as proposed. Record a grant before enabling it." };
  });
}

export async function sourceCommandAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/sources/${id}`, async (staff) => {
    const r = await sourceAction(getDb(), staff, id, { action: str(f, "action") as SourceAction, reason: str(f, "reason") }, new Date());
    const a = r.affected;
    return { ok: `Source is now ${r.status}. Cards removed: ${a.publicCards}. Copies suppressed: ${a.publicCopies}. Assets withdrawn: ${a.assets}. Jobs replayed: ${a.jobsReplayed}.` };
  });
}

export async function grantAddAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/sources/${id}`, async (staff) => {
    const expires = str(f, "expiresAt");
    const version = await addGrant(
      getDb(),
      staff,
      id,
      { basis: str(f, "basis") as never, evidenceUri: str(f, "evidenceUri"), termsUrl: str(f, "termsUrl"), allowHeadline: flag(f, "allowHeadline"), allowExcerpt: flag(f, "allowExcerpt"), excerptMaxChars: Number(str(f, "excerptMaxChars") || 0), allowFullText: flag(f, "allowFullText"), allowImages: flag(f, "allowImages"), channels: ["web", "rss", "social"].filter((c) => flag(f, `channel_${c}`)), attributionText: str(f, "attributionText"), expiresAt: expires ? new Date(`${expires}T23:59:59+05:30`) : null, reason: str(f, "reason") },
      new Date(),
    );
    return { ok: `Grant version ${version} recorded.` };
  });
}

export async function automationAction(id: string, f: FormData): Promise<never> {
  return run(`/newsroom/sources/${id}`, async (staff) => {
    await setAutomation(getDb(), staff, id, str(f, "format") as "source_card" | "licensed_copy", str(f, "enabled") === "true", str(f, "reason"), new Date());
    return { ok: "Automation switch updated." };
  });
}

/* ── cases ── */

export async function caseResolveAction(id: string, f: FormData): Promise<never> {
  return run("/newsroom/cases", async (staff) => {
    await resolveCase(getDb(), staff, id, { status: str(f, "status") as "in_progress" | "resolved" | "rejected", decision: str(f, "decision"), response: str(f, "response") }, new Date());
    return { ok: "Case updated." };
  });
}

export async function linkCheckAction(f: FormData): Promise<never> {
  return run("/newsroom/cases", async (staff) => {
    await recordLinkCheck(getDb(), staff, { url: str(f, "url"), status: str(f, "status") as "broken" | "replaced" | "ok", replacementUrl: str(f, "replacementUrl") || undefined, note: str(f, "note") || "Verified" }, new Date());
    return { ok: "Link status recorded." };
  });
}

/* ── staff ── */

export async function staffInviteAction(f: FormData): Promise<never> {
  return run("/newsroom/staff", async (staff) => {
    const { token } = await inviteStaff(getDb(), staff, { email: str(f, "email"), displayName: str(f, "displayName"), roles: f.getAll("roles").map(String) as StaffRole[] }, new Date());
    return { to: withParam("/newsroom/staff", "invite", token), ok: "Invitation created. Send the link below to the new member of staff. It works once and expires in 72 hours." };
  });
}

export async function staffReinviteAction(personId: string): Promise<never> {
  return run("/newsroom/staff", async (staff) => {
    const token = await reinviteStaff(getDb(), staff, personId, new Date());
    return { to: withParam("/newsroom/staff", "invite", token), ok: "Credentials reset. Send the new link below. Existing sessions were ended." };
  });
}

export async function staffRoleAction(personId: string, f: FormData): Promise<never> {
  return run("/newsroom/staff", async (staff) => {
    await setRole(getDb(), staff, personId, str(f, "role") as StaffRole, str(f, "grant") === "true", str(f, "reason"), new Date());
    return { ok: "Role updated." };
  });
}

export async function staffActiveAction(personId: string, f: FormData): Promise<never> {
  return run("/newsroom/staff", async (staff) => {
    await setPersonActive(getDb(), staff, personId, str(f, "active") === "true", str(f, "reason"), new Date());
    return { ok: "Account updated." };
  });
}

export async function profileAction(personId: string, f: FormData): Promise<never> {
  return run("/newsroom/staff", async (staff) => {
    await updateProfile(getDb(), staff, personId, { bio: str(f, "bio"), credentials: str(f, "credentials"), conflicts: str(f, "conflicts"), hasPublicProfile: flag(f, "hasPublicProfile") });
    return { ok: "Profile saved." };
  });
}

/* ── settings ── */

export async function settingsSaveAction(f: FormData): Promise<never> {
  return run("/newsroom/settings", async (staff) => {
    await saveSettings(getDb(), staff, Object.fromEntries([...f.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)])), new Date());
    return { ok: "Publisher details saved. Policy pages now use them." };
  });
}

export async function flagAction(f: FormData): Promise<never> {
  return run("/newsroom/settings", async (staff) => {
    await setFlag(getDb(), staff, str(f, "key"), str(f, "enabled") === "true", str(f, "reason"), new Date());
    return { ok: "Control updated." };
  });
}

export async function pageSaveAction(slug: string, f: FormData): Promise<never> {
  return run(`/newsroom/settings/pages/${slug}`, async (staff) => {
    const version = await savePage(getDb(), staff, { slug, title: str(f, "title"), description: str(f, "description"), body: parseMarkup(String(f.get("body") ?? "")), reviewedBy: str(f, "reviewedBy") || null, changeNote: str(f, "changeNote") }, new Date());
    return { ok: `Version ${version} is now live.` };
  });
}

/* ── public: reader report ── */

export async function reportAction(f: FormData): Promise<never> {
  // A filled honeypot field means a bot. Answer as if it worked and record nothing.
  if (str(f, "website")) redirect("/corrections?case=received#report");
  const result = await submitCase(getDb(), { reason: str(f, "reason"), description: String(f.get("description") ?? ""), contact: str(f, "contact"), articleSlug: str(f, "story") || undefined, sourceUrl: str(f, "sourceUrl") || undefined, clientKey: await clientKey() }, new Date());
  if (!result.ok) redirect(`${withParam("/corrections", "error", result.error)}#report`);
  redirect(`/corrections?case=${result.caseNumber}#report`);
}
