import type { ReactNode } from "react";
import { longDateTime } from "@/lib/format";

export type SP = Promise<Record<string, string | string[] | undefined>>;

export async function Flash({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const pick = (k: string) => (Array.isArray(sp[k]) ? sp[k]?.[0] : (sp[k] as string | undefined));
  const ok = pick("ok");
  const error = pick("error");
  return (
    <>
      {ok && (
        <p className="flash" role="status">
          {ok}
        </p>
      )}
      {error && (
        <p className="flash error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function Field({ label, name, hint, children }: { label: string; name: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={name}>
        {label}
        {hint && <span className="hint"> {hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "warn" | "good" }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

export const when = (d: Date | string | null | undefined) => (d ? longDateTime(new Date(d)) : "—");
export const can = (roles: string[], ...need: string[]) => roles.some((r) => need.includes(r));
