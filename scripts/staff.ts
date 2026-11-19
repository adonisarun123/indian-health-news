/**
 * Create the first administrator, or re-issue an invitation.
 *
 *   npm run staff -- invite --email you@example.com --name "Your Name" --roles administrator,managing_editor,editor
 *   npm run staff -- reinvite --email you@example.com
 *
 * Prints a one-time link. Open it to set a password and enrol an authenticator app.
 */
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { people } from "../src/db/schema";
import type { StaffRole } from "../src/core/articles";
import { inviteStaff, reinviteStaff } from "../src/core/auth";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");
const email = opt("email");
if (!email) throw new Error("--email is required");
const base = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const { db, pool } = createDb(url, 1);

let token: string;
if (args[0] === "reinvite") {
  const [p] = await db.select().from(people).where(eq(people.email, email.toLowerCase()));
  if (!p) throw new Error("No such account.");
  token = await reinviteStaff(db, null, p.id, new Date());
} else {
  const roles = (opt("roles") ?? "administrator").split(",") as StaffRole[];
  ({ token } = await inviteStaff(db, null, { email, displayName: opt("name") ?? email, roles }, new Date()));
}
console.log(`\nOne-time setup link (valid for 72 hours):\n${base}/newsroom/invite/${token}\n`);
await pool.end();
