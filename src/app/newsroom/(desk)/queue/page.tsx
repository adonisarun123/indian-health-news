import Link from "next/link";
import { getDb } from "@/db/client";
import { getFlags } from "@/core/audit";
import { listQueue, listTasks } from "@/core/desk";
import { Badge, Flash, type SP, when } from "@/components/Desk";
import { taskCloseAction } from "../../actions";

export const metadata = { title: "Queue" };

const NEXT: Record<string, string> = {
  RIGHTS_UNKNOWN: "Record a grant for the source, or leave unpublished.",
  RISK_REVIEW_REQUIRED: "Write a report and send it for editor and medical review.",
  SOURCE_NOT_ENABLED: "Finish the source's onboarding test and enable it.",
  AMBIGUOUS_DATE: "Check the publication date at the source.",
  LANGUAGE_MISMATCH: "Check the language of the item.",
  EMBARGO_ACTIVE: "Wait for the embargo to lift.",
  URL_ALIAS_CONFLICT: "Two items share one address. Check for a duplicate.",
  SUPPRESSED: "The item was withdrawn or suppressed.",
  SOURCE_AUTOMATION_OFF: "Release the card, or write a report.",
  AUTO_PUBLISH_STOPPED: "Automatic publishing is stopped. Release by hand if appropriate.",
};

export default async function Queue({ searchParams }: { searchParams: SP }) {
  const db = getDb();
  const [items, tasks, flags] = [await listQueue(db), await listTasks(db), await getFlags(db)];
  return (
    <>
      <h1>Queue</h1>
      <Flash searchParams={searchParams} />
      {!flags.auto_publish && (
        <p className="flash error" role="alert">
          Automatic publishing is stopped. Incoming items are recorded and wait here. <Link href="/newsroom/settings">Controls</Link>
        </p>
      )}
      <h2>Source items waiting ({items.length})</h2>
      {items.length === 0 ? (
        <p className="note">Nothing is waiting.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Publisher</th>
                <th>Why it is waiting</th>
                <th>Next action</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/newsroom/items/${i.id}`}>{i.title ?? i.external_id}</Link>
                    <br />
                    <span className="meta">rev {i.revision}</span> {i.risk_route !== "routine" && <Badge tone="warn">{i.risk_route}</Badge>} {i.has_body && <Badge>full text</Badge>}
                  </td>
                  <td>{i.publisher}</td>
                  <td>{i.reasons.length ? i.reasons.map((r) => <Badge key={r} tone="warn">{r}</Badge>) : <Badge>not released</Badge>}</td>
                  <td>{NEXT[i.reasons[0] ?? "SOURCE_AUTOMATION_OFF"] ?? "Open the item."}</td>
                  <td>{when(i.observed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Open tasks ({tasks.length})</h2>
      {tasks.length === 0 ? (
        <p className="note">No open tasks.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Detail</th>
                <th>Opened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const href = t.subjectType === "article" ? `/newsroom/stories/${t.subjectId}` : t.subjectType === "source_item" ? `/newsroom/items/${t.subjectId}` : t.subjectType === "source" ? `/newsroom/sources/${t.subjectId}` : t.subjectType === "case" ? "/newsroom/cases" : null;
                return (
                  <tr key={t.id}>
                    <td>
                      <Badge tone={t.kind.startsWith("urgent") ? "warn" : undefined}>{t.kind.replaceAll("_", " ")}</Badge>
                    </td>
                    <td>{href ? <Link href={href}>{t.detail}</Link> : t.detail}</td>
                    <td>{when(t.createdAt)}</td>
                    <td>
                      <form action={taskCloseAction.bind(null, t.id)}>
                        <input type="hidden" name="status" value="done" />
                        <button className="button" type="submit">
                          Mark done
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
