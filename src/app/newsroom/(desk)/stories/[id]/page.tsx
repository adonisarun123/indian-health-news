import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { CommandError, getDraft } from "@/core/articles";
import { listStateTerms } from "@/core/desk";
import { listSections } from "@/core/reader";
import { Badge, can, Field, Flash, type SP, when } from "@/components/Desk";
import { StoryFields } from "@/components/StoryForm";
import { citationsToText, toMarkup } from "@/lib/markup";
import { requireStaff } from "@/lib/session";
import { storyCommandAction, storyLeadAction, storyMoveAction, storySaveAction } from "../../../actions";

export const metadata = { title: "Story" };

export default async function Story({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const staff = await requireStaff();
  const db = getDb();
  let d;
  try {
    d = await getDraft(db, staff, id);
  } catch (e) {
    if (e instanceof CommandError) notFound();
    throw e;
  }
  const { article: a, content: c } = d;
  const isPublic = Boolean(a.publicVersionId);
  const pending = a.draftVersionId !== a.publicVersionId;
  const partner = a.type === "licensed_copy";
  const closed = a.status === "removed" || a.status === "retracted";
  const editor = can(staff.roles, "editor", "managing_editor");
  const boss = can(staff.roles, "managing_editor");
  const reviewer = can(staff.roles, "medical_reviewer");
  const key = () => randomUUID();

  const Command = ({ action, label, tone, children }: { action: string; label: string; tone?: "primary" | "danger"; children?: React.ReactNode }) => (
    <form action={storyCommandAction.bind(null, a.id)} className="inline-form">
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="expectedVersion" value={a.lockVersion} />
      <input type="hidden" name="idempotencyKey" value={key()} />
      {children}
      <button className={`button${tone ? ` ${tone}` : ""}`} type="submit">
        {label}
      </button>
    </form>
  );
  const Reason = ({ label = "Reason" }: { label?: string }) => (
    <div>
      <label>
        {label}
        <input type="text" name="reason" required />
      </label>
    </div>
  );

  return (
    <>
      <p className="breadcrumb">
        <Link href="/newsroom/stories">Stories</Link>
      </p>
      <h1>{c.headline}</h1>
      <Flash searchParams={searchParams} />
      <p>
        <Badge tone={a.status === "published" ? "good" : closed ? "warn" : undefined}>{a.status.replace("_", " ")}</Badge> <Badge tone={a.riskRoute !== "routine" ? "warn" : undefined}>{a.riskRoute} route</Badge> {partner && <Badge>partner copy</Badge>}{" "}
        <Badge>draft v{d.draftVersion}</Badge> {d.publicVersion && <Badge tone="good">public v{d.publicVersion}</Badge>}
      </p>
      <p className="meta">
        Address: /news/{a.slug} · first published {when(a.firstPublishedAt)} · last correction {when(a.modifiedAt)}
        {a.scheduledAt && <> · scheduled for {when(a.scheduledAt)}</>}
        {a.embargoUntil && <> · embargo until {when(a.embargoUntil)}</>}
      </p>
      <p style={{ margin: "0.75rem 0" }}>
        <Link className="button" href={`/newsroom/stories/${a.id}/preview`}>
          Preview draft
        </Link>{" "}
        {isPublic && !closed && (
          <Link className="button" href={`/news/${a.slug}`}>
            View public page
          </Link>
        )}
      </p>

      {!closed && pending && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Before this version can be released</h2>
          {d.blockers.length === 0 ? (
            <p>
              <Badge tone="good">Ready</Badge> Every requirement is met for draft v{d.draftVersion}.
            </p>
          ) : (
            <ul>
              {d.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          )}
          <p className="meta">
            Editor sign-off: {d.signoff.editorial ? "recorded" : "missing"} · Medical sign-off: {a.riskRoute === "routine" ? "not required" : d.signoff.medical ? "recorded" : "missing"}
            {d.signoff.returned && " · this version was returned and needs an edit"}
          </p>
        </div>
      )}

      {!closed && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Actions</h2>
          {pending && (a.status === "draft" || isPublic) && <Command action="submit" label="Submit for review" tone="primary" />}
          {pending && editor && <Command action="approve-editorial" label="Approve as editor" />}
          {pending && reviewer && a.riskRoute !== "routine" && (
            <Command action="approve-medical" label="Approve as medical reviewer">
              <div>
                <label>
                  Evidence checked
                  <input type="text" name="evidence" required />
                </label>
              </div>
            </Command>
          )}
          {pending && (editor || reviewer) && a.status !== "draft" && (
            <Command action="return" label="Return to author">
              <Reason />
            </Command>
          )}
          {editor && !isPublic && <Command action="publish" label="Publish now" tone="primary" />}
          {editor && !isPublic && a.status === "approved" && (
            <Command action="schedule" label="Schedule">
              <div>
                <label>
                  Release time (IST)
                  <input type="datetime-local" name="scheduledAt" required />
                </label>
              </div>
            </Command>
          )}
          {editor && isPublic && pending && <Command action="correct" label="Release correction" tone="primary" />}
          {boss && (
            <Command action="classify" label="Reclassify risk">
              <div>
                <label>
                  Risk route
                  <select name="riskRoute" defaultValue={a.riskRoute}>
                    <option value="routine">Routine</option>
                    <option value="clinical">Clinical or high impact</option>
                    <option value="sensitive">Conflicting or sensitive</option>
                  </select>
                </label>
              </div>
              <Reason />
            </Command>
          )}
          {boss && isPublic && (
            <>
              <Command action="retract" label="Retract" tone="danger">
                <Reason label="Internal reason" />
                <div>
                  <label>
                    Public note
                    <input type="text" name="publicNote" />
                  </label>
                </div>
              </Command>
              <Command action="remove" label="Remove" tone="danger">
                <Reason label="Internal reason" />
                <div>
                  <label>
                    Response
                    <select name="removalStatus" defaultValue="410">
                      <option value="410">410 — permanently removed</option>
                      <option value="451">451 — legal restriction</option>
                    </select>
                  </label>
                </div>
              </Command>
            </>
          )}
          {!editor && !reviewer && <p className="meta">Approval and publishing need an editor or medical reviewer role.</p>}
        </div>
      )}

      {!closed && !partner && (
        <>
          <h2>Edit</h2>
          <p className="meta">Saving creates a new version. Any sign-off on the previous version stops applying.</p>
          <form action={storySaveAction.bind(null, a.id)} className="form">
            <input type="hidden" name="expectedVersion" value={a.lockVersion} />
            <StoryFields
              v={{ headline: c.headline, standfirst: c.standfirst, body: toMarkup(c.body), section: c.sectionSlug, state: c.termSlugs.find((t) => t.kind === "state")?.slug, citations: citationsToText(c.citations), contribution: c.contribution, contributionNote: c.contributionNote, correctionNote: c.correctionNote, assistModel: c.assistModel }}
              sections={await listSections(db)}
              states={await listStateTerms(db)}
              isNew={false}
              isPublic={isPublic}
            />
            {a.embargoUntil && (
              <div className="checks">
                <label>
                  <input type="checkbox" name="clearEmbargo" /> Clear the embargo
                </label>
              </div>
            )}
            <button className="button primary" type="submit">
              Save new version
            </button>
          </form>
        </>
      )}
      {partner && <p className="note">A partner copy reproduces the source and cannot be edited here.</p>}

      {editor && !closed && (
        <>
          <h2>Address and homepage</h2>
          <form action={storyMoveAction.bind(null, a.id)} className="inline-form">
            <input type="hidden" name="expectedVersion" value={a.lockVersion} />
            <div>
              <label>
                New address slug
                <input type="text" name="slug" defaultValue={a.slug} required />
              </label>
            </div>
            <Reason />
            <button className="button" type="submit">
              Move
            </button>
          </form>
          <form action={storyLeadAction.bind(null, a.id)} className="inline-form">
            <div>
              <label>
                Lead rank (empty clears; higher wins)
                <input type="text" name="rank" inputMode="numeric" defaultValue={a.leadRank ?? ""} />
              </label>
            </div>
            <Reason />
            <button className="button" type="submit">
              Set lead placement
            </button>
          </form>
        </>
      )}

      <h2>Review log</h2>
      {d.approvals.length === 0 ? (
        <p className="meta">No decisions recorded.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Decision</th>
                <th>Version</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {d.approvals.map((ap) => (
                <tr key={ap.id}>
                  <td>{when(ap.createdAt)}</td>
                  <td>
                    {ap.kind} {ap.decision}
                  </td>
                  <td>v{d.versions.find((v) => v.id === ap.versionId)?.version}</td>
                  <td>{[ap.specialty, ap.evidence, ap.reason].filter(Boolean).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="meta" style={{ marginTop: "1rem" }}>
        {d.versions.length} versions kept. Versions and sign-offs cannot be altered.
      </p>
    </>
  );
}
