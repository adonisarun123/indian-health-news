import Link from "next/link";
import type { ReactNode } from "react";
import { requireStaff } from "@/lib/session";
import { logoutAction } from "../actions";

export default async function DeskLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  const admin = staff.roles.includes("administrator") || staff.roles.includes("auditor");
  return (
    <>
      <nav className="desk-nav" aria-label="Newsroom">
        <Link href="/newsroom">Dashboard</Link>
        <Link href="/newsroom/queue">Queue</Link>
        <Link href="/newsroom/stories">Stories</Link>
        <Link href="/newsroom/sources">Sources</Link>
        <Link href="/newsroom/cases">Cases</Link>
        <Link href="/newsroom/settings">Settings</Link>
        <Link href="/newsroom/staff">Staff</Link>
        {admin && <Link href="/newsroom/audit">Audit</Link>}
        <span className="who">
          {staff.displayName} · {staff.roles.join(", ").replaceAll("_", " ") || "no roles"}
        </span>
        <form action={logoutAction}>
          <button className="button" type="submit">
            Sign out
          </button>
        </form>
      </nav>
      {children}
    </>
  );
}
