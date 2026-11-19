import { getDb } from "@/db/client";
import { listAudit } from "@/core/desk";
import { can, when } from "@/components/Desk";
import { requireStaff } from "@/lib/session";

export const metadata = { title: "Audit" };

export default async function Audit() {
  const staff = await requireStaff();
  if (!can(staff.roles, "administrator", "auditor", "managing_editor")) {
    return (
      <>
        <h1>Audit trail</h1>
        <p className="note">The audit trail is open to administrators, auditors and managing editors.</p>
      </>
    );
  }
  const rows = await listAudit(getDb());
  return (
    <>
      <h1>Audit trail</h1>
      <p className="meta">Latest {rows.length} entries. The trail is append-only: entries cannot be changed or deleted.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Actor</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{when(r.createdAt)}</td>
                <td>{r.action}</td>
                <td>
                  {r.subjectType} <span className="meta">{r.subjectId.slice(0, 8)}</span>
                </td>
                <td>
                  {r.actorType} <span className="meta">{r.actorId?.slice(0, 8) ?? ""}</span>
                </td>
                <td>{r.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
