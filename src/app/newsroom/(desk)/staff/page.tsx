import { getDb } from "@/db/client";
import { listStaff } from "@/core/desk";
import { Badge, can, Field, Flash, type SP } from "@/components/Desk";
import { requireStaff } from "@/lib/session";
import { absolute } from "@/lib/site";
import { profileAction, staffActiveAction, staffInviteAction, staffReinviteAction, staffRoleAction } from "../../actions";

export const metadata = { title: "Staff" };

const ROLES = ["reporter", "editor", "managing_editor", "medical_reviewer", "source_operator", "administrator", "auditor"] as const;

export default async function Staff({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const admin = can(staff.roles, "administrator");
  const people = await listStaff(getDb());
  const invite = typeof sp.invite === "string" ? sp.invite : null;
  const me = people.find((p) => p.id === staff.personId)!;
  return (
    <>
      <h1>Staff</h1>
      <Flash searchParams={searchParams} />
      {invite && admin && (
        <div className="panel">
          <strong>Invitation link</strong>
          <p className="secret">{absolute(`/newsroom/invite/${invite}`)}</p>
          <p className="meta">Send it privately. It works once and expires in 72 hours. It is not shown again.</p>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Roles</th>
              {admin && <th>Manage</th>}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.displayName}
                  <br />
                  <span className="meta">{p.email}</span>
                </td>
                <td>
                  <Badge tone={p.status === "active" ? "good" : p.status === "disabled" ? "warn" : undefined}>{p.status}</Badge>
                </td>
                <td>{p.roles.map((r) => r.replace("_", " ")).join(", ") || "none"}</td>
                {admin && (
                  <td>
                    <form action={staffRoleAction.bind(null, p.id)} className="inline-form">
                      <div>
                        <label>
                          Role
                          <select name="role">
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r.replace("_", " ")}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div>
                        <label>
                          Reason
                          <input type="text" name="reason" required />
                        </label>
                      </div>
                      <button className="button" name="grant" value="true" type="submit">
                        Grant
                      </button>
                      <button className="button" name="grant" value="false" type="submit">
                        Revoke
                      </button>
                    </form>
                    <form action={staffActiveAction.bind(null, p.id)} className="inline-form">
                      <input type="hidden" name="active" value={p.status === "disabled" ? "true" : "false"} />
                      <div>
                        <label>
                          Reason
                          <input type="text" name="reason" required />
                        </label>
                      </div>
                      <button className={`button${p.status === "disabled" ? "" : " danger"}`} type="submit">
                        {p.status === "disabled" ? "Re-enable" : "Disable and end sessions"}
                      </button>
                    </form>
                    <form action={staffReinviteAction.bind(null, p.id)}>
                      <button className="button" type="submit">
                        Reset password and authenticator
                      </button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {admin && (
        <>
          <h2>Invite a member of staff</h2>
          <form action={staffInviteAction} className="form">
            <Field label="Name" name="displayName">
              <input id="displayName" name="displayName" type="text" required />
            </Field>
            <Field label="Email" name="email">
              <input id="email" name="email" type="email" required />
            </Field>
            <div className="checks">
              {ROLES.map((r) => (
                <label key={r}>
                  <input type="checkbox" name="roles" value={r} /> {r.replace("_", " ")}
                </label>
              ))}
            </div>
            <p className="hint">Editorial approval and clinical sign-off are separate roles. An administrator cannot publish without an editor role.</p>
            <button className="button primary" type="submit">
              Create invitation
            </button>
          </form>
        </>
      )}

      <h2>Your public profile</h2>
      <form action={profileAction.bind(null, me.id)} className="form">
        <Field label="Biography" name="bio" hint="Shown on your author page.">
          <textarea id="bio" name="bio" defaultValue={me.bio ?? ""} />
        </Field>
        <Field label="Relevant credentials" name="credentials">
          <input id="credentials" name="credentials" type="text" defaultValue={me.credentials ?? ""} />
        </Field>
        <Field label="Declared interests" name="conflicts" hint="Leave empty if you have none to declare.">
          <input id="conflicts" name="conflicts" type="text" defaultValue={me.conflicts ?? ""} />
        </Field>
        <div className="checks">
          <label>
            <input type="checkbox" name="hasPublicProfile" defaultChecked={me.hasPublicProfile} /> Publish my author page
          </label>
        </div>
        <button className="button" type="submit">
          Save profile
        </button>
      </form>
    </>
  );
}
