import Link from "next/link";
import { getDb } from "@/db/client";
import { getFlags } from "@/core/audit";
import { FLAG_LABELS, getPage, getSettings, PAGE_SLUGS, PUBLISHER_FIELDS } from "@/core/settings";
import { Badge, can, Field, Flash, type SP, when } from "@/components/Desk";
import { requireStaff } from "@/lib/session";
import { flagAction, settingsSaveAction } from "../../actions";

export const metadata = { title: "Settings" };

export default async function Settings({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff();
  const db = getDb();
  const [values, flags] = [await getSettings(db), await getFlags(db)];
  const configure = can(staff.roles, "administrator", "managing_editor");
  const pages = [];
  for (const slug of PAGE_SLUGS) pages.push(await getPage(db, slug));
  return (
    <>
      <h1>Settings</h1>
      <Flash searchParams={searchParams} />

      <h2>Rollout controls</h2>
      <p className="meta">Any editor can stop automatic publishing. Intake keeps running and items wait in the queue.</p>
      {Object.entries(FLAG_LABELS).map(([key, label]) => (
        <form key={key} action={flagAction} className="inline-form">
          <input type="hidden" name="key" value={key} />
          <input type="hidden" name="enabled" value={flags[key] ? "false" : "true"} />
          <div>
            <Badge tone={flags[key] ? "good" : "warn"}>{flags[key] ? "on" : "off"}</Badge> {label}
          </div>
          <div>
            <label>
              Reason
              <input type="text" name="reason" required />
            </label>
          </div>
          <button className={`button${flags[key] ? " danger" : ""}`} type="submit">
            Turn {flags[key] ? "off" : "on"}
          </button>
        </form>
      ))}

      <h2>Policy pages</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Page</th>
              <th>Version</th>
              <th>Reviewed by</th>
              <th>Missing publisher details</th>
            </tr>
          </thead>
          <tbody>
            {pages.map(
              (p) =>
                p && (
                  <tr key={p.slug}>
                    <td>
                      <Link href={`/newsroom/settings/pages/${p.slug}`}>{p.title}</Link>
                    </td>
                    <td>
                      v{p.version} · {when(p.effectiveAt)}
                    </td>
                    <td>{p.reviewedBy ?? <Badge tone="warn">not reviewed</Badge>}</td>
                    <td>{p.missing.length ? p.missing.join(", ") : <Badge tone="good">complete</Badge>}</td>
                  </tr>
                ),
            )}
          </tbody>
        </table>
      </div>
      <p className="meta">A policy page becomes indexable only when it has no missing details and a reviewer is recorded.</p>

      <h2>Publisher details</h2>
      <p className="meta">These appear on the policy pages. Leave a field empty until you have the real value: readers see “to be confirmed”.</p>
      <form action={settingsSaveAction} className="form">
        {PUBLISHER_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} name={f.key} hint={f.hint}>
            <input id={f.key} name={f.key} type="text" defaultValue={values[f.key] ?? ""} maxLength={2000} disabled={!configure} />
          </Field>
        ))}
        {configure && (
          <button className="button primary" type="submit">
            Save publisher details
          </button>
        )}
      </form>
    </>
  );
}
