import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getItem } from "@/core/desk";
import { listSections } from "@/core/reader";
import { Badge, can, Flash, type SP, when } from "@/components/Desk";
import { requireStaff } from "@/lib/session";
import { cardReleaseAction, clusterDecideAction, partnerCopyAction } from "../../../actions";

export const metadata = { title: "Source item" };

/** Side-by-side view of one source item: what the source says, what changed, likely matches, next actions (ED-01). */
export default async function Item({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const staff = await requireStaff();
  const db = getDb();
  const data = await getItem(db, id);
  if (!data) notFound();
  const { item, source, revisions, grant, matches } = data;
  const cur = revisions[0]!;
  const prev = revisions[1];
  const editor = can(staff.roles, "editor", "managing_editor");
  const changed = prev ? (["title", "submittedUrl", "excerpt", "documentUrl"] as const).filter((k) => prev[k] !== cur[k]) : [];
  return (
    <>
      <p className="breadcrumb">
        <Link href="/newsroom">Queue</Link>
      </p>
      <h1>{cur.title ?? item.externalId}</h1>
      <Flash searchParams={searchParams} />
      <p>
        <Link href={`/newsroom/sources/${source.id}`}>{source.displayName}</Link> · revision {cur.revision} · <Badge tone={cur.riskRoute !== "routine" ? "warn" : undefined}>{cur.riskRoute}</Badge> {item.status === "withdrawn" && <Badge tone="warn">withdrawn by source</Badge>}
      </p>
      <div className="panel">
        <p>
          <a className="ext" href={cur.submittedUrl} rel="noopener external">
            Open at the source
          </a>
        </p>
        <p className="meta">
          Source date {when(cur.sourcePublishedAt)} · seen {when(cur.observedAt)} · language {cur.language ?? "?"}
          {cur.sourceAuthor && <> · author {cur.sourceAuthor}</>}
        </p>
        {cur.holdReasons.length > 0 && (
          <p>
            Waiting because: {cur.holdReasons.map((r) => <Badge key={r} tone="warn">{r}</Badge>)}
          </p>
        )}
        {cur.riskFlags.length > 0 && <p className="meta">Risk screen matched: {cur.riskFlags.join(", ")}</p>}
        {cur.withdrawReason && <p>Withdrawal reason: {cur.withdrawReason}</p>}
        <p className="meta">
          Rights in force: {grant ? `grant v${grant.version}, ${grant.basis.replace("_", " ")}; headline ${grant.allowHeadline ? "yes" : "no"}, excerpt ${grant.allowExcerpt ? "yes" : "no"}, full text ${grant.allowFullText ? "yes" : "no"}, images ${grant.allowImages ? "yes" : "no"}` : "none. Nothing from this source may be published."}
        </p>
        {grant?.allowExcerpt && cur.excerpt && <blockquote>{cur.excerpt.slice(0, grant.excerptMaxChars || 300)}</blockquote>}
        {cur.bodyText && <p className="meta">Licensed full text held: {cur.bodyText.length.toLocaleString("en-IN")} characters.</p>}
      </div>

      {prev && (
        <>
          <h2>Changes since revision {prev.revision}</h2>
          {changed.length === 0 ? (
            <p className="meta">No change to title, address, excerpt or document.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Before</th>
                    <th>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.map((k) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{prev[k] ?? "—"}</td>
                      <td>{cur[k] ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h2>Possible matches from other publishers</h2>
      {matches.length === 0 ? (
        <p className="meta">No suggestions.</p>
      ) : (
        matches.map((m) => (
          <form key={m.item_id} action={clusterDecideAction.bind(null, item.id)} className="inline-form">
            <input type="hidden" name="clusterId" value={m.cluster_id} />
            <input type="hidden" name="otherItemId" value={m.item_id} />
            <div>
              <Link href={`/newsroom/items/${m.item_id}`}>{m.title}</Link> · {m.publisher} · similarity {m.confidence} · <Badge>{m.decision}</Badge>
            </div>
            {editor && (
              <>
                <div>
                  <label>
                    Reason
                    <input type="text" name="reason" required />
                  </label>
                </div>
                <button className="button" name="decision" value="confirmed" type="submit">
                  Same story
                </button>
                <button className="button" name="decision" value="rejected" type="submit">
                  Different story
                </button>
              </>
            )}
          </form>
        ))
      )}

      {item.status === "active" && (
        <>
          <h2>Next actions</h2>
          <p>
            <Link className="button primary" href={`/newsroom/stories/new?item=${item.id}`}>
              Write a report citing this
            </Link>
          </p>
          {editor && (
            <form action={cardReleaseAction.bind(null, item.id)} className="inline-form">
              <div>
                <label>
                  Reason for releasing a link-only source card
                  <input type="text" name="reason" required />
                </label>
              </div>
              <button className="button" type="submit">
                Release source card
              </button>
            </form>
          )}
          {editor && cur.bodyText && grant?.allowFullText && (
            <form action={partnerCopyAction.bind(null, item.id)} className="inline-form">
              <div>
                <label>
                  Section for the partner copy
                  <select name="section" defaultValue={source.defaultSectionSlug ?? ""} required>
                    {(await listSections(db)).map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button className="button" type="submit">
                Prepare labelled partner copy
              </button>
            </form>
          )}
          <p className="meta">A risk-flagged item cannot be released as a card. It needs a report with editor and medical sign-off.</p>
        </>
      )}
    </>
  );
}
