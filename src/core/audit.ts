import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { auditEntries, editorialTasks, featureFlags, outbox, suppressions } from "@/db/schema";

export interface AuditInput {
  actorType: "staff" | "producer" | "system";
  actorId?: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  reason?: string | null;
  diff?: Record<string, unknown> | null;
}

export async function audit(db: DbOrTx, entry: AuditInput): Promise<void> {
  await db.insert(auditEntries).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    reason: entry.reason ?? null,
    diff: entry.diff ?? null,
  });
}

export async function openTask(
  db: DbOrTx,
  task: { kind: string; subjectType: string; subjectId: string; detail: string; dueAt?: Date },
): Promise<void> {
  await db.insert(editorialTasks).values(task);
}

export type SuppressionSubject = "article" | "source_item" | "asset" | "source";

export async function activeSuppression(db: DbOrTx, subjectType: SuppressionSubject, subjectId: string) {
  const rows = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.subjectType, subjectType), eq(suppressions.subjectId, subjectId), isNull(suppressions.liftedAt)));
  // The most restrictive decision governs the public response.
  const rank = { removal_451: 5, removal_410: 4, retraction: 3, rights_revocation: 2, rights_expiry: 2, source_withdrawal: 2, risk_hold: 1 };
  return rows.sort((a, b) => rank[b.kind] - rank[a.kind])[0] ?? null;
}

export async function getFlags(db: DbOrTx): Promise<Record<string, boolean>> {
  const rows = await db.select().from(featureFlags);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

/**
 * Append a publication event. `aggregateVersion` is monotonic per aggregate;
 * the unique index turns a concurrent double-write into a hard error.
 */
export async function emit(
  db: DbOrTx,
  event: { eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> },
): Promise<string> {
  // Callers hold a row lock on the aggregate, so max()+1 is race-free here.
  const prior = await db
    .select({ v: outbox.aggregateVersion })
    .from(outbox)
    .where(and(eq(outbox.aggregateType, event.aggregateType), eq(outbox.aggregateId, event.aggregateId)));
  const next = prior.reduce((m, r) => Math.max(m, r.v), 0) + 1;
  const [row] = await db
    .insert(outbox)
    .values({ ...event, aggregateVersion: next })
    .returning({ id: outbox.id });
  return row!.id;
}
