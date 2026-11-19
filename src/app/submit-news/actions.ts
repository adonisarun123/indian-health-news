"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { submitNews } from "@/core/submissions";
import { clientKey } from "@/lib/session";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function submitNewsAction(f: FormData): Promise<never> {
  // A filled honeypot field means a bot. Answer as if it worked and record nothing.
  if (str(f, "website")) redirect("/submit-news?ref=received#form");
  const result = await submitNews(
    getDb(),
    { kind: str(f, "kind"), name: str(f, "name"), organisation: str(f, "organisation"), email: str(f, "email"), phone: str(f, "phone"), headline: str(f, "headline"), details: String(f.get("details") ?? ""), link: str(f, "link"), confirmed: f.get("confirmed") === "yes", clientKey: await clientKey() },
    new Date(),
  );
  if (!result.ok) redirect(`/submit-news?error=${encodeURIComponent(result.error)}#form`);
  redirect(`/submit-news?ref=${result.reference}#form`);
}
