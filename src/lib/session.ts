import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getSession, SESSION_HOURS, type StaffSession } from "@/core/auth";
import { SITE_URL } from "./site";

export const SESSION_COOKIE = "ihn_session";
const secure = SITE_URL.startsWith("https://");

/** HttpOnly, SameSite=Lax, Secure in production. The token itself is random; only its hash is stored. */
export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_HOURS * 3600 });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function currentStaff(): Promise<StaffSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSession(getDb(), token, new Date());
}

/** Gate for every newsroom page and action. The session is re-read from the database each time. */
export async function requireStaff(): Promise<StaffSession> {
  const staff = await currentStaff();
  if (!staff) redirect("/newsroom/login");
  return staff;
}

/**
 * CSRF check for cookie-authenticated API mutations: the request must come
 * from this origin. Server Actions get the same check from the framework.
 */
export async function sameOrigin(): Promise<boolean> {
  const h = await headers();
  const origin = h.get("origin");
  if (!origin) return false;
  try {
    const host = h.get("x-forwarded-host") ?? h.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const { sha256Hex } = await import("@/core/crypto");
  // Hashed with a server secret and the date: usable for rate limiting, useless as an identifier.
  return sha256Hex(`${process.env.INGEST_SECRET_KEY ?? ""}:${new Date().toISOString().slice(0, 10)}:${ip}`).slice(0, 32);
}
