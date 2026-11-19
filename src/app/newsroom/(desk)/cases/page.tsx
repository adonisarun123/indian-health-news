import { getDb } from "@/db/client";
import { CASE_REASONS, listCases } from "@/core/cases";
import { SUBMISSION_REASON } from "@/core/submissions";
import { Badge, can, Flash, type SP, when } from "@/components/Desk";
import { requireStaff } from "@/lib/session";
import { caseResolveAction, linkCheckAction } from "../../actions";

const REASON_LABELS: Record<string, string> = { ...CASE_REASONS, [SUBMISSION_REASON]: "News submission" };

export const metadata = { title: "Cases" };

export default async function Cases({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff();
  if (!can(staff.roles, "editor", "managing_editor")) {
    return (
      <>
        <h1>Reader cases</h1>
        <p className="note">Reader cases hold private contact details. Only editors can open them.</p>
      </>
    );
  }
  const rows = await listCases(getDb(), staff);
  return (
    <>
      <h1>Reader cases and news submissions</h1>
      <Flash searchParams={searchParams} />
      <p className="meta">Contact details are private. Do not copy them into stories, tasks or messages.</p>
      {rows.length === 0 && <p className="note">No reports or submissions yet.</p>}
      {rows.map((c) => (
        <div className="panel" key={c.id}>
          <p>
            <strong>{c.caseNumber}</strong> <Badge tone={c.isUrgent ? "warn" : undefined}>{REASON_LABELS[c.reason] ?? c.reason}</Badge> <Badge tone={c.status === "resolved" ? "good" : undefined}>{c.status.replace("_", " ")}</Badge> <span className="meta">{when(c.createdAt)}</span>
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{c.description}</p>
          <p className="meta">Contact: {c.reporterContact ?? "none given"}</p>
          {c.decision && (
            <p className="meta">
              Decision: {c.decision}
              {c.response && <> · Reply: {c.response}</>}
            </p>
          )}
          {c.status !== "resolved" && c.status !== "rejected" && (
            <form action={caseResolveAction.bind(null, c.id)} className="inline-form">
              <div>
                <label>
                  Decision and basis
                  <input type="text" name="decision" required />
                </label>
              </div>
              <div>
                <label>
                  Reply sent to the reader
                  <input type="text" name="response" />
                </label>
              </div>
              <div>
                <label>
                  Outcome
                  <select name="status" defaultValue="resolved">
                    <option value="in_progress">Still working on it</option>
                    <option value="resolved">Resolved</option>
                    <option value="rejected">No action needed</option>
                  </select>
                </label>
              </div>
              <button className="button" type="submit">
                Save
              </button>
            </form>
          )}
        </div>
      ))}
      <h2>Record a source link check</h2>
      <form action={linkCheckAction} className="inline-form">
        <div>
          <label>
            Cited address
            <input type="text" name="url" placeholder="https://" required />
          </label>
        </div>
        <div>
          <label>
            Result
            <select name="status" defaultValue="ok">
              <option value="ok">Works</option>
              <option value="broken">Broken</option>
              <option value="replaced">Moved: verified replacement</option>
            </select>
          </label>
        </div>
        <div>
          <label>
            Replacement address
            <input type="text" name="replacementUrl" placeholder="https://" />
          </label>
        </div>
        <div>
          <label>
            Note
            <input type="text" name="note" />
          </label>
        </div>
        <button className="button" type="submit">
          Record
        </button>
      </form>
    </>
  );
}
