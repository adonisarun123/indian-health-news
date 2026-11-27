/**
 * Producer credentials: the key a scraper signs its intake events with (API-01).
 * The secret is returned once, when it is created or rotated, and is stored only
 * encrypted with INGEST_SECRET_KEY. Every change is in the audit trail.
 */
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { producerSecrets, producerSources, producers, sources } from "@/db/schema";
import { type Actor, CommandError } from "./articles";
import { audit } from "./audit";
import { decryptSecret, encryptSecret, newProducerSecret } from "./crypto";

/** A new secret is valid from slightly before now, so a producer clock a little ahead of the server's still works. */
const CLOCK_ALLOWANCE_MS = 5 * 60_000;

export interface ProducerCredentials {
  producerId: string;
  keyId: string;
  secret: string;
}

function guard(actor: Actor, reason: string | undefined): string {
  if (!actor.roles.some((r) => r === "administrator" || r === "managing_editor")) throw new CommandError(403, "FORBIDDEN", "Only an administrator or managing editor can manage producer keys.");
  if (!reason?.trim()) throw new CommandError(422, "VALIDATION_FAILED", "A reason is required.", { fieldErrors: [{ field: "reason", code: "REQUIRED", message: "Record the reason for this action." }] });
  return reason.trim();
}

async function sourcesBySlug(tx: Tx, slugs: string[]) {
  const wanted = [...new Set(slugs)];
  const rows = wanted.length ? await tx.select({ id: sources.id, slug: sources.slug }).from(sources).where(inArray(sources.slug, wanted)) : [];
  const missing = wanted.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length) throw new CommandError(422, "SOURCE_UNKNOWN", `Not in the source register: ${missing.join(", ")}. Register them first.`);
  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function producerByKey(tx: Tx, keyId: string) {
  const [p] = await tx.select().from(producers).where(eq(producers.keyId, keyId)).for("update");
  if (!p) throw new CommandError(404, "NOT_FOUND", `No producer with key ID ${keyId}.`);
  return p;
}

/** Create a producer, issue its first secret and assign it to sources already in the register. */
export async function createProducer(db: Db, actor: Actor, input: { keyId: string; name: string; sourceSlugs: string[]; reason: string }, now: Date): Promise<ProducerCredentials> {
  const reason = guard(actor, input.reason);
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(input.keyId)) throw new CommandError(422, "VALIDATION_FAILED", "Key ID: lowercase letters, digits and hyphens, 3 to 63 characters.");
  if (!input.name.trim()) throw new CommandError(422, "VALIDATION_FAILED", "A producer name is required.");
  const secret = newProducerSecret();
  return db.transaction(async (tx) => {
    if ((await tx.select({ id: producers.id }).from(producers).where(eq(producers.keyId, input.keyId))).length) throw new CommandError(409, "KEY_TAKEN", "A producer with this key ID exists. Rotate its secret instead.");
    const linked = await sourcesBySlug(tx, input.sourceSlugs);
    const [p] = await tx.insert(producers).values({ keyId: input.keyId, name: input.name.trim(), createdAt: now }).returning();
    await tx.insert(producerSecrets).values({ producerId: p!.id, secretCiphertext: encryptSecret(secret), validFrom: new Date(now.getTime() - CLOCK_ALLOWANCE_MS), createdAt: now });
    for (const s of linked) await tx.insert(producerSources).values({ producerId: p!.id, sourceId: s.id });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "producer.create", subjectType: "producer", subjectId: p!.id, reason, diff: { keyId: input.keyId, sources: linked.map((s) => s.slug) } });
    return { producerId: p!.id, keyId: input.keyId, secret };
  });
}

/** Assign more sources to a producer. Sources it already has are left as they are. Returns how many were added. */
export async function assignSources(db: Db, actor: Actor, keyId: string, sourceSlugs: string[], reason: string, _now: Date): Promise<number> {
  const why = guard(actor, reason);
  return db.transaction(async (tx) => {
    const p = await producerByKey(tx, keyId);
    const linked = await sourcesBySlug(tx, sourceSlugs);
    const added = linked.length ? await tx.insert(producerSources).values(linked.map((s) => ({ producerId: p.id, sourceId: s.id }))).onConflictDoNothing().returning() : [];
    const slugs = linked.filter((s) => added.some((a) => a.sourceId === s.id)).map((s) => s.slug);
    if (slugs.length) await audit(tx, { actorType: "staff", actorId: actor.personId, action: "producer.assign", subjectType: "producer", subjectId: p.id, reason: why, diff: { sources: slugs } });
    return slugs.length;
  });
}

/**
 * Issue a new secret. Secrets already in force stay valid for `overlapHours`
 * (0 ends them now), so the producer can switch without dropping events.
 */
export async function rotateSecret(db: Db, actor: Actor, keyId: string, input: { overlapHours: number; reason: string }, now: Date): Promise<ProducerCredentials> {
  const reason = guard(actor, input.reason);
  if (!(input.overlapHours >= 0 && input.overlapHours <= 24 * 30)) throw new CommandError(422, "VALIDATION_FAILED", "Overlap must be between 0 and 720 hours.");
  const secret = newProducerSecret();
  const until = new Date(now.getTime() + input.overlapHours * 3_600_000);
  return db.transaction(async (tx) => {
    const p = await producerByKey(tx, keyId);
    const ended = await tx
      .update(producerSecrets)
      .set({ validUntil: until })
      .where(and(eq(producerSecrets.producerId, p.id), or(isNull(producerSecrets.validUntil), gt(producerSecrets.validUntil, until))))
      .returning({ id: producerSecrets.id });
    await tx.insert(producerSecrets).values({ producerId: p.id, secretCiphertext: encryptSecret(secret), validFrom: new Date(now.getTime() - CLOCK_ALLOWANCE_MS), createdAt: now });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: "producer.rotate", subjectType: "producer", subjectId: p.id, reason, diff: { previousSecretsEnd: until.toISOString(), previousSecrets: ended.length } });
    return { producerId: p.id, keyId, secret };
  });
}

export interface ProducerSummary {
  keyId: string;
  name: string;
  isActive: boolean;
  sources: string[];
  /** `readable` says whether this process's INGEST_SECRET_KEY can decrypt the secret, i.e. whether it matches the one the secret was stored with. */
  secrets: { validFrom: Date; validUntil: Date | null; readable: boolean }[];
}

/** Producers with their sources and secret validity. Secrets themselves are never returned. */
export async function listProducers(db: Db | Tx): Promise<ProducerSummary[]> {
  const ps = await db.select().from(producers).orderBy(asc(producers.keyId));
  const out: ProducerSummary[] = [];
  for (const p of ps) {
    const linked = await db.select({ slug: sources.slug }).from(producerSources).innerJoin(sources, eq(sources.id, producerSources.sourceId)).where(eq(producerSources.producerId, p.id)).orderBy(asc(sources.slug));
    const secrets = await db.select().from(producerSecrets).where(eq(producerSecrets.producerId, p.id)).orderBy(asc(producerSecrets.validFrom));
    out.push({
      keyId: p.keyId,
      name: p.name,
      isActive: p.isActive,
      sources: linked.map((s) => s.slug),
      secrets: secrets.map((s) => {
        let readable = true;
        try {
          decryptSecret(s.secretCiphertext);
        } catch {
          readable = false;
        }
        return { validFrom: s.validFrom, validUntil: s.validUntil, readable };
      }),
    });
  }
  return out;
}

/** Set `KEY=value` lines in the text of an env file: replace the first uncommented line for each key, or append one. */
export function setEnvLines(text: string, vars: Record<string, string>): string {
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const [k, v] of Object.entries(vars)) {
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be a single line`);
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  return `${lines.join("\n")}\n`;
}
