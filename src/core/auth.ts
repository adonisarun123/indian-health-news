/**
 * Staff sign-in (SEC-02, ADM-01): individual accounts, hashed passwords, a
 * mandatory TOTP second factor and server-side sessions that expire and can be
 * revoked at once. No third-party identity service is involved.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { memberships, people, rateWindows, staffCredentials, staffInvites, staffSessions } from "@/db/schema";
import { type Actor, CommandError, loadActor, type StaffRole } from "./articles";
import { audit } from "./audit";
import { decryptSecret, encryptSecret, sha256Hex } from "./crypto";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export const SESSION_HOURS = 12;
export const INVITE_HOURS = 72;
export const MIN_PASSWORD = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [algo, n, salt, hash] = (stored ?? "").split("$");
  if (algo !== "scrypt" || !n || !salt || !hash) {
    // Spend comparable time so a missing account is not distinguishable by timing.
    await scrypt(password, Buffer.alloc(16), 32, SCRYPT);
    return false;
  }
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(actual, expected);
}

/* ── TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ── */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) ?? []).map((c) => B32[Number.parseInt(c.padEnd(5, "0"), 2)]).join("");
}

export function base32Decode(s: string): Buffer {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32");
    bits += v.toString(2).padStart(5, "0");
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

export const stepOf = (now: Date) => Math.floor(now.getTime() / 30_000);

/** Returns the matching time step, allowing one step of clock drift either way, or null. */
export function matchTotp(secretB32: string, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const d of [0, -1, 1]) {
    const step = stepOf(now) + d;
    if (timingSafeEqual(Buffer.from(totpAt(secretB32, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, email: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ── rate limiting ── */

/** Count one hit. Returns true when the bucket is over its limit for the window. */
export async function overLimit(db: DbOrTx, bucket: string, limit: number, windowMinutes: number, now: Date): Promise<boolean> {
  const ms = windowMinutes * 60_000;
  const windowStart = new Date(Math.floor(now.getTime() / ms) * ms);
  const [row] = await db
    .insert(rateWindows)
    .values({ bucket, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateWindows.bucket, rateWindows.windowStart], set: { count: sql`${rateWindows.count} + 1` } })
    .returning({ count: rateWindows.count });
  return (row?.count ?? 0) > limit;
}

/* ── invitations ── */

const ADMIN_ONLY = "Only an administrator can manage staff accounts.";
const isAdmin = (a: Actor) => a.roles.includes("administrator");

export interface InviteInput {
  email: string;
  displayName: string;
  roles: StaffRole[];
}

function slugOf(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "staff";
}

async function issueInvite(tx: DbOrTx, personId: string, createdBy: string | null, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await tx.insert(staffInvites).values({ personId, tokenHash: sha256Hex(token), expiresAt: new Date(now.getTime() + INVITE_HOURS * 3600_000), createdBy, createdAt: now });
  return token;
}

/**
 * Create an account and return a one-time invitation token. `actor` is null
 * only for the bootstrap script that creates the first administrator.
 */
export async function inviteStaff(db: Db, actor: Actor | null, input: InviteInput, now: Date): Promise<{ personId: string; token: string }> {
  if (actor && !isAdmin(actor)) throw new CommandError(403, "FORBIDDEN", ADMIN_ONLY);
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !input.displayName.trim() || input.roles.length === 0) {
    throw new CommandError(422, "VALIDATION_FAILED", "Email, name and at least one role are required.");
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(people).where(eq(people.email, email));
    if (existing) throw new CommandError(409, "EMAIL_IN_USE", "An account with this email already exists.");
    let slug = slugOf(input.displayName);
    for (let n = 2; (await tx.select({ id: people.id }).from(people).where(eq(people.slug, slug))).length > 0; n++) slug = `${slugOf(input.displayName)}-${n}`;
    const [person] = await tx.insert(people).values({ slug, displayName: input.displayName.trim(), email, status: "invited" }).returning();
    for (const role of new Set(input.roles)) await tx.insert(memberships).values({ personId: person!.id, role, grantedBy: actor?.personId ?? null, grantedAt: now });
    await tx.insert(staffCredentials).values({ personId: person!.id });
    const token = await issueInvite(tx, person!.id, actor?.personId ?? null, now);
    await audit(tx, { actorType: actor ? "staff" : "system", actorId: actor?.personId, action: "staff.invite", subjectType: "person", subjectId: person!.id, diff: { roles: input.roles } });
    return { personId: person!.id, token };
  });
}

/** Re-issue an invitation, for a lost link or a credential reset. Existing sessions are revoked. */
export async function reinviteStaff(db: Db, actor: Actor | null, personId: string, now: Date): Promise<string> {
  if (actor && !isAdmin(actor)) throw new CommandError(403, "FORBIDDEN", ADMIN_ONLY);
  return db.transaction(async (tx) => {
    await tx.insert(staffCredentials).values({ personId }).onConflictDoNothing();
    await tx.update(staffCredentials).set({ passwordHash: null, totpSecretEnc: null, totpConfirmedAt: null, failedAttempts: 0, lockedUntil: null, updatedAt: now }).where(eq(staffCredentials.personId, personId));
    await tx.update(staffSessions).set({ revokedAt: now }).where(and(eq(staffSessions.personId, personId), isNull(staffSessions.revokedAt)));
    await tx.update(staffInvites).set({ usedAt: now }).where(and(eq(staffInvites.personId, personId), isNull(staffInvites.usedAt)));
    await tx.update(people).set({ status: "invited" }).where(eq(people.id, personId));
    await audit(tx, { actorType: actor ? "staff" : "system", actorId: actor?.personId, action: "staff.reinvite", subjectType: "person", subjectId: personId });
    return issueInvite(tx, personId, actor?.personId ?? null, now);
  });
}

async function liveInvite(db: DbOrTx, token: string, now: Date) {
  const [row] = await db
    .select({ invite: staffInvites, person: people })
    .from(staffInvites)
    .innerJoin(people, eq(people.id, staffInvites.personId))
    .where(eq(staffInvites.tokenHash, sha256Hex(token)));
  if (!row || row.invite.usedAt || row.invite.expiresAt <= now || row.person.status === "disabled") return null;
  return row;
}

/** First step of enrolment: show the account and a fresh authenticator secret. */
export async function beginEnrolment(db: Db, token: string, now: Date): Promise<{ email: string; displayName: string; secret: string } | null> {
  const row = await liveInvite(db, token, now);
  if (!row) return null;
  const [cred] = await db.select().from(staffCredentials).where(eq(staffCredentials.personId, row.person.id));
  let secret = cred?.totpSecretEnc && !cred.totpConfirmedAt ? decryptSecret(cred.totpSecretEnc) : null;
  if (!secret) {
    secret = base32Encode(randomBytes(20));
    await db.insert(staffCredentials).values({ personId: row.person.id, totpSecretEnc: encryptSecret(secret) }).onConflictDoUpdate({ target: staffCredentials.personId, set: { totpSecretEnc: encryptSecret(secret), totpConfirmedAt: null, updatedAt: now } });
  }
  return { email: row.person.email, displayName: row.person.displayName, secret };
}

/** Second step: set the password and prove the authenticator works. */
export async function completeEnrolment(db: Db, token: string, password: string, code: string, now: Date): Promise<{ ok: true } | { ok: false; error: string }> {
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Use at least ${MIN_PASSWORD} characters.` };
  return db.transaction(async (tx) => {
    const row = await liveInvite(tx, token, now);
    if (!row) return { ok: false as const, error: "This invitation is no longer valid. Ask an administrator for a new one." };
    const [cred] = await tx.select().from(staffCredentials).where(eq(staffCredentials.personId, row.person.id)).for("update");
    if (!cred?.totpSecretEnc) return { ok: false as const, error: "Reload the page to get an authenticator code." };
    const step = matchTotp(decryptSecret(cred.totpSecretEnc), code.trim(), now);
    if (step === null) return { ok: false as const, error: "That authenticator code is not correct. Check the time on your phone and try again." };
    await tx.update(staffCredentials).set({ passwordHash: await hashPassword(password), totpConfirmedAt: now, lastTotpStep: step, failedAttempts: 0, lockedUntil: null, updatedAt: now }).where(eq(staffCredentials.personId, row.person.id));
    await tx.update(staffInvites).set({ usedAt: now }).where(eq(staffInvites.id, row.invite.id));
    await tx.update(people).set({ status: "active" }).where(eq(people.id, row.person.id));
    await audit(tx, { actorType: "staff", actorId: row.person.id, action: "staff.enrol", subjectType: "person", subjectId: row.person.id });
    return { ok: true as const };
  });
}

/* ── sessions ── */

export type LoginResult = { ok: true; token: string; expiresAt: Date } | { ok: false; error: string };
const GENERIC = "Email, password or code is not correct.";

export async function signIn(db: Db, input: { email: string; password: string; code: string; userAgent?: string | null }, now: Date): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  if (await overLimit(db, `login:${sha256Hex(email).slice(0, 24)}`, 10, 15, now)) return { ok: false, error: "Too many attempts. Wait fifteen minutes and try again." };
  const [row] = await db.select({ person: people, cred: staffCredentials }).from(people).leftJoin(staffCredentials, eq(staffCredentials.personId, people.id)).where(eq(people.email, email));
  const cred = row?.cred;
  const passwordOk = await verifyPassword(input.password, cred?.passwordHash ?? null);
  if (!row || !cred || row.person.status !== "active" || !cred.totpConfirmedAt || !cred.totpSecretEnc) return { ok: false, error: GENERIC };
  if (cred.lockedUntil && cred.lockedUntil > now) return { ok: false, error: "This account is locked after repeated failures. Try again later." };

  const step = passwordOk ? matchTotp(decryptSecret(cred.totpSecretEnc), input.code.trim(), now) : null;
  // A code is accepted once: an observed code cannot be replayed inside its window.
  if (!passwordOk || step === null || step <= cred.lastTotpStep) {
    const failures = cred.failedAttempts + 1;
    await db.update(staffCredentials).set({ failedAttempts: failures, lockedUntil: failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null, updatedAt: now }).where(eq(staffCredentials.personId, row.person.id));
    if (failures >= MAX_FAILURES) await audit(db, { actorType: "system", action: "staff.lockout", subjectType: "person", subjectId: row.person.id });
    return { ok: false, error: GENERIC };
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  await db.transaction(async (tx) => {
    await tx.update(staffCredentials).set({ failedAttempts: 0, lockedUntil: null, lastTotpStep: step, updatedAt: now }).where(eq(staffCredentials.personId, row.person.id));
    await tx.insert(staffSessions).values({ personId: row.person.id, tokenHash: sha256Hex(token), userAgent: input.userAgent?.slice(0, 300) ?? null, createdAt: now, expiresAt });
    await audit(tx, { actorType: "staff", actorId: row.person.id, action: "staff.sign_in", subjectType: "person", subjectId: row.person.id });
  });
  return { ok: true, token, expiresAt };
}

export interface StaffSession extends Actor {
  sessionId: string;
  displayName: string;
  email: string;
}

/** Resolve a session cookie. Checked against the database on every request, so revocation is immediate. */
export async function getSession(db: Db, token: string | undefined, now: Date): Promise<StaffSession | null> {
  if (!token) return null;
  const [row] = await db.select({ s: staffSessions, p: people }).from(staffSessions).innerJoin(people, eq(people.id, staffSessions.personId)).where(eq(staffSessions.tokenHash, sha256Hex(token)));
  if (!row || row.s.revokedAt || row.s.expiresAt <= now || row.p.status !== "active") return null;
  const actor = await loadActor(db, row.p.id);
  return { ...actor, sessionId: row.s.id, displayName: row.p.displayName, email: row.p.email };
}

export async function signOut(db: Db, token: string | undefined, now: Date): Promise<void> {
  if (token) await db.update(staffSessions).set({ revokedAt: now }).where(eq(staffSessions.tokenHash, sha256Hex(token)));
}

/* ── administration ── */

export async function setRole(db: Db, actor: Actor, personId: string, role: StaffRole, grant: boolean, reason: string, now: Date): Promise<void> {
  if (!isAdmin(actor)) throw new CommandError(403, "FORBIDDEN", ADMIN_ONLY);
  if (!reason) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.");
  if (!grant && role === "administrator" && personId === actor.personId) throw new CommandError(422, "VALIDATION_FAILED", "You cannot remove your own administrator role.");
  await db.transaction(async (tx) => {
    if (grant) await tx.insert(memberships).values({ personId, role, grantedBy: actor.personId, grantedAt: now }).onConflictDoNothing();
    else await tx.update(memberships).set({ revokedAt: now }).where(and(eq(memberships.personId, personId), eq(memberships.role, role), isNull(memberships.revokedAt)));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: grant ? "staff.grant_role" : "staff.revoke_role", subjectType: "person", subjectId: personId, reason, diff: { role } });
  });
}

/** Disable or re-enable an account. Disabling ends every session at once. */
export async function setPersonActive(db: Db, actor: Actor, personId: string, active: boolean, reason: string, now: Date): Promise<void> {
  if (!isAdmin(actor)) throw new CommandError(403, "FORBIDDEN", ADMIN_ONLY);
  if (!reason) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.");
  if (!active && personId === actor.personId) throw new CommandError(422, "VALIDATION_FAILED", "You cannot disable your own account.");
  await db.transaction(async (tx) => {
    await tx.update(people).set({ status: active ? "active" : "disabled" }).where(eq(people.id, personId));
    if (!active) await tx.update(staffSessions).set({ revokedAt: now }).where(and(eq(staffSessions.personId, personId), isNull(staffSessions.revokedAt)));
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: active ? "staff.enable" : "staff.disable", subjectType: "person", subjectId: personId, reason });
  });
}

export async function updateProfile(db: Db, actor: Actor, personId: string, input: { bio: string; credentials: string; conflicts: string; hasPublicProfile: boolean }): Promise<void> {
  if (!isAdmin(actor) && actor.personId !== personId) throw new CommandError(403, "FORBIDDEN", "You can edit only your own profile.");
  await db.update(people).set({ bio: input.bio || null, credentials: input.credentials || null, conflicts: input.conflicts || null, hasPublicProfile: input.hasPublicProfile }).where(eq(people.id, personId));
  await audit(db, { actorType: "staff", actorId: actor.personId, action: "staff.update_profile", subjectType: "person", subjectId: personId });
}
