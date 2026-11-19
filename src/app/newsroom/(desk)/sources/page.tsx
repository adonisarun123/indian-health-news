import Link from "next/link";
import { getDb } from "@/db/client";
import { listSourcesAdmin, sourceCensus } from "@/core/desk";
import { Badge, Flash, type SP, when } from "@/components/Desk";
import { longDate } from "@/lib/format";

export const metadata = { title: "Sources" };

export default async function Sources({ searchParams }: { searchParams: SP }) {
  const db = getDb();
  const rows = await listSourcesAdmin(db);
  const census = await sourceCensus(db);
  return (
    <>
      <h1>Source register</h1>
      <Flash searchParams={searchParams} />
      <p className="meta">
        Census on {longDate(new Date())}: {["proposed", "under_review", "enabled", "paused", "revoked"].map((s) => `${census[s] ?? 0} ${s.replace("_", " ")}`).join(" · ")}. This is the register as recorded, not a claim of nationwide completeness.
      </p>
      <p style={{ margin: "1rem 0" }}>
        <Link className="button primary" href="/newsroom/sources/new">
          Register a source
        </Link>
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Publisher</th>
              <th>State</th>
              <th>Rights in force</th>
              <th>Automatic</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ source: s, grant, automation }) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/newsroom/sources/${s.id}`}>{s.displayName}</Link>
                  <br />
                  <span className="meta">{s.slug}</span>
                </td>
                <td>
                  <Badge tone={s.status === "enabled" ? "good" : s.status === "revoked" ? "warn" : undefined}>{s.status.replace("_", " ")}</Badge>
                </td>
                <td>{grant ? `v${grant.version} ${grant.basis.replace("_", " ")}${grant.allowFullText ? ", full text" : ""}` : <Badge tone="warn">none</Badge>}</td>
                <td>{[automation.source_card && "cards", automation.licensed_copy && "copies"].filter(Boolean).join(", ") || "off"}</td>
                <td>{grant?.expiresAt ? when(grant.expiresAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="note">No sources registered yet. Nothing can be ingested until a source exists, has a grant and is enabled.</p>}
    </>
  );
}
