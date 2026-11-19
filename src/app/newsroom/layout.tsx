import type { Metadata } from "next";
import type { ReactNode } from "react";

// Private area: never indexed, never cached (SEC-02).
export const metadata: Metadata = { title: { default: "Newsroom", template: "%s | Newsroom" }, robots: { index: false, follow: false } };

export default function NewsroomRoot({ children }: { children: ReactNode }) {
  return <div className="desk">{children}</div>;
}
