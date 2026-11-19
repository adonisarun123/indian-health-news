import Link from "next/link";
import { getDb } from "@/db/client";
import { listStories } from "@/core/desk";
import { Badge, can, Flash, type SP, when } from "@/components/Desk";
import { requireStaff } from "@/lib/session";

export const metadata = { title: "Stories" };

export default async function Stories({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  // A reporter sees only their own work. Everyone else on the desk sees all drafts.
  const own = !can(staff.roles, "editor", "managing_editor", "medical_reviewer", "auditor", "administrator");
  const rows = await listStories(getDb(), { status, createdBy: own ? staff.personId : undefined });
  return (
    <>
      <h1>Stories</h1>
      <Flash searchParams={searchParams} />
      <p style={{ marginBottom: "1rem" }}>
        <Link className="button primary" href="/newsroom/stories/new">
          New story
        </Link>
      </p>
      <ul className="chips">
        {[undefined, "draft", "in_review", "approved", "scheduled", "published", "retracted"].map((s) => (
          <li key={s ?? "all"}>
            <Link href={s ? `/newsroom/stories?status=${s}` : "/newsroom/stories"} aria-current={status === s ? "page" : undefined}>
              {s ? s.replace("_", " ") : "All"}
            </Link>
          </li>
        ))}
      </ul>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Headline</th>
              <th>Status</th>
              <th>Route</th>
              <th>Author</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/newsroom/stories/${r.id}`}>{r.headline}</Link>
                  {r.type === "licensed_copy" && <> <Badge>partner copy</Badge></>}
                </td>
                <td>
                  <Badge tone={r.status === "published" ? "good" : undefined}>{r.status.replace("_", " ")}</Badge>
                  {r.isPublic && r.pending && <> <Badge tone="warn">unpublished revision</Badge></>}
                </td>
                <td>{r.riskRoute !== "routine" ? <Badge tone="warn">{r.riskRoute}</Badge> : "routine"}</td>
                <td>{r.author ?? "—"}</td>
                <td>{when(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="note">No stories here yet.</p>}
    </>
  );
}
