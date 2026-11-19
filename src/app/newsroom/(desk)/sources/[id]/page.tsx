import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getSourceAdmin } from "@/core/desk";
import { sourceImpact } from "@/core/sources";
import { Badge, can, Field, Flash, type SP, when } from "@/components/Desk";
import { requireStaff } from "@/lib/session";
import { automationAction, grantAddAction, sourceCommandAction } from "../../../actions";

export const metadata = { title: "Source" };

export default async function Source({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const staff = await requireStaff();
  const db = getDb();
  const d = await getSourceAdmin(db, id);
  if (!d) notFound();
  const { source: s } = d;
  const impact = await sourceImpact(db, id);
  const boss = can(staff.roles, "managing_editor");
  const operator = boss || can(staff.roles, "source_operator");
  const Cmd = ({ action, label, tone }: { action: string; label: string; tone?: "danger" | "primary" }) => (
    <form action={sourceCommandAction.bind(null, s.id)} className="inline-form">
      <input type="hidden" name="action" value={action} />
      <div>
        <label>
          Reason
          <input type="text" name="reason" required />
        </label>
      </div>
      <button className={`button${tone ? ` ${tone}` : ""}`} type="submit">
        {label}
      </button>
    </form>
  );
  return (
    <>
      <p className="breadcrumb">
        <Link href="/newsroom/sources">Sources</Link>
      </p>
      <h1>{s.displayName}</h1>
      <Flash searchParams={searchParams} />
      <p>
        <Badge tone={s.status === "enabled" ? "good" : s.status === "revoked" ? "warn" : undefined}>{s.status.replace("_", " ")}</Badge> {s.legalName} · <span className="meta">{s.slug}</span>
      </p>
      <p className="meta">
        Hosts: {d.hosts.join(", ")} · default route {s.defaultRiskRoute} · policy version {s.policyVersion}
      </p>
      <p className="meta">
        Intake: {Object.entries(d.events).map(([k, v]) => `${v} ${k}`).join(" · ") || "no events yet"} · {d.deadJobs} failed jobs waiting for replay
      </p>

      {operator && s.status !== "revoked" && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Status</h2>
          <p className="meta">
            Public now: {impact.publicCards} source cards, {impact.publicCopies} partner copies, {impact.assets} media assets. A pause stops new intake and leaves these up. Revocation takes all of them down and cannot be undone.
          </p>
          {(s.status === "proposed" || s.status === "paused") && <Cmd action="trial" label="Start onboarding trial" />}
          {boss && s.status !== "enabled" && <Cmd action="enable" label="Enable" tone="primary" />}
          {(s.status === "enabled" || s.status === "under_review") && <Cmd action="pause" label="Pause intake" />}
          {d.deadJobs > 0 && <Cmd action="replay" label={`Replay ${d.deadJobs} failed jobs`} />}
          {boss && <Cmd action="revoke" label="Revoke source and take down its content" tone="danger" />}
        </div>
      )}

      <h2>Automatic publishing</h2>
      {(["source_card", "licensed_copy"] as const).map((format) => (
        <form key={format} action={automationAction.bind(null, s.id)} className="inline-form">
          <input type="hidden" name="format" value={format} />
          <input type="hidden" name="enabled" value={d.automation[format] ? "false" : "true"} />
          <div>
            {format === "source_card" ? "Link-only source cards" : "Licensed partner copies"}: <Badge tone={d.automation[format] ? "good" : undefined}>{d.automation[format] ? "on" : "off"}</Badge>
          </div>
          {boss && (
            <>
              <div>
                <label>
                  Reason
                  <input type="text" name="reason" required />
                </label>
              </div>
              <button className="button" type="submit">
                Turn {d.automation[format] ? "off" : "on"}
              </button>
            </>
          )}
        </form>
      ))}
      <p className="meta">A risk-flagged item is never automatic, whatever these switches say.</p>

      <h2>Rights register</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Basis</th>
              <th>Permits</th>
              <th>Channels</th>
              <th>Effective</th>
              <th>Expires</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {d.grants.map((g) => (
              <tr key={g.id}>
                <td>
                  v{g.version} {d.current?.id === g.id && <Badge tone="good">in force</Badge>} {g.revokedAt && <Badge tone="warn">revoked</Badge>}
                </td>
                <td>{g.basis.replace("_", " ")}</td>
                <td>{[g.allowHeadline && "headline", g.allowExcerpt && `excerpt (${g.excerptMaxChars})`, g.allowFullText && "full text", g.allowImages && "images"].filter(Boolean).join(", ") || "link only"}</td>
                <td>{g.channels.join(", ") || "—"}</td>
                <td>{when(g.effectiveAt)}</td>
                <td>{when(g.expiresAt)}</td>
                <td>{g.evidenceUri ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {boss && s.status !== "revoked" && (
        <>
          <h2>Record a new grant</h2>
          <p className="meta">Full text, images and feed redistribution each need their own allowance. The new version replaces the one in force.</p>
          <form action={grantAddAction.bind(null, s.id)} className="form">
            <Field label="Permission basis" name="basis">
              <select id="basis" name="basis" defaultValue="link_only">
                <option value="link_only">Link only (no reproduction beyond a permitted headline)</option>
                <option value="public_terms">Publisher's public terms</option>
                <option value="written_permission">Written permission</option>
                <option value="licence">Licence agreement</option>
                <option value="fair_dealing_reviewed">Fair dealing, reviewed by the adviser</option>
              </select>
            </Field>
            <Field label="Where the evidence is kept" name="evidenceUri" hint="A document reference or private link. Do not paste the agreement here.">
              <input id="evidenceUri" name="evidenceUri" type="text" required />
            </Field>
            <Field label="Publisher's terms URL" name="termsUrl">
              <input id="termsUrl" name="termsUrl" type="url" />
            </Field>
            <div className="checks">
              {[
                ["allowHeadline", "Headline"],
                ["allowExcerpt", "Excerpt"],
                ["allowFullText", "Full text"],
                ["allowImages", "Images"],
              ].map(([n, l]) => (
                <label key={n}>
                  <input type="checkbox" name={n} /> {l}
                </label>
              ))}
            </div>
            <Field label="Excerpt limit (characters)" name="excerptMaxChars">
              <input id="excerptMaxChars" name="excerptMaxChars" type="text" inputMode="numeric" defaultValue="0" />
            </Field>
            <div className="checks">
              {[
                ["channel_web", "Website"],
                ["channel_rss", "RSS feeds"],
                ["channel_social", "Social previews"],
              ].map(([n, l]) => (
                <label key={n}>
                  <input type="checkbox" name={n} defaultChecked={n === "channel_web"} /> {l}
                </label>
              ))}
            </div>
            <Field label="Required attribution wording" name="attributionText">
              <input id="attributionText" name="attributionText" type="text" />
            </Field>
            <Field label="Expires on" name="expiresAt" hint="Leave empty if the permission has no end date.">
              <input id="expiresAt" name="expiresAt" type="text" placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" />
            </Field>
            <Field label="Reason for this change" name="reason">
              <input id="reason" name="reason" type="text" required />
            </Field>
            <button className="button primary" type="submit">
              Record grant
            </button>
          </form>
        </>
      )}
    </>
  );
}
