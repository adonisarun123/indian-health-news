import { timingSafeEqual } from "node:crypto";

/** Bearer check for internal endpoints. Fails closed when no secret is configured. */
export function internalAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || secret.length < 16 || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}
