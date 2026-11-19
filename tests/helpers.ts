import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "@/db/client";
import { type DemoSeed, seedDemo, seedReference } from "@/db/seed";
import { loadActor, type Actor } from "@/core/articles";
import { signRequest } from "@/core/crypto";
import { getReceipt, type HttpResult, receiveEvent } from "@/core/ingest/receive";
import type { Distributor, OutboxEvent } from "@/core/outbox";
import { runDueJobs, schedulerTick } from "@/worker/run";
import { ADMIN_URL, TEMPLATE, urlFor } from "./global-setup";

/** 19 November 2026, 9:06 am IST: the moment the scraper sees the bulletin in the SRS example. */
export const T0 = new Date("2026-11-19T09:06:00+05:30");
export const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

export interface Ctx {
  db: Db;
  seed: DemoSeed;
  delivered: { target: string; event: OutboxEvent }[];
  distributor: Distributor;
  actor(role: keyof DemoSeed["people"]): Promise<Actor>;
  close(): Promise<void>;
}

export async function createCtx(): Promise<Ctx> {
  const name = `ihn_t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database "${name}" template "${TEMPLATE}"`);
  await admin.end();

  const { db, pool } = createDb(urlFor(name), 10);
  await seedReference(db);
  const seed = await seedDemo(db, T0);
  const delivered: Ctx["delivered"] = [];
  return {
    db,
    seed,
    delivered,
    distributor: { deliver: async (target, event) => void delivered.push({ target, event }) },
    actor: (role) => loadActor(db, seed.people[role]),
    async close() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists "${name}" with (force)`);
      await a.end();
    },
  };
}

export type Producer = DemoSeed["producers"]["a"];

export function notice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    source_id: "state-bulletin-demo",
    external_id: "notice-204",
    revision: 1,
    event_type: "item.upsert",
    source_url: "https://health.example/notices/204",
    source_title: "District reporting calendar released",
    language: "en",
    source_published_at: "2026-11-19T09:00:00+05:30",
    observed_at: "2026-11-19T09:06:00+05:30",
    ...overrides,
  };
}

export function headersFor(p: Producer, eventId: string, body: Buffer, now: Date, tamper: Partial<{ signature: string; timestamp: string }> = {}) {
  const timestamp = tamper.timestamp ?? String(Math.floor(now.getTime() / 1000));
  return {
    producerKey: p.keyId,
    timestamp,
    signature: tamper.signature ?? signRequest(p.secret, timestamp, eventId, body),
    idempotencyKey: eventId,
  };
}

/** Submit an event as the scraper would. Returns the HTTP result and the exact bytes sent. */
export async function send(ctx: Ctx, p: Producer, event: Record<string, unknown>, now: Date): Promise<HttpResult & { raw: Buffer }> {
  const raw = Buffer.from(JSON.stringify(event), "utf8");
  const res = await receiveEvent(ctx.db, headersFor(p, String(event.event_id), raw, now), raw, now);
  return { ...res, raw };
}

export async function sendRaw(ctx: Ctx, p: Producer, eventId: string, raw: Buffer, now: Date): Promise<HttpResult> {
  return receiveEvent(ctx.db, headersFor(p, eventId, raw, now), raw, now);
}

export async function receipt(ctx: Ctx, p: Producer, eventId: string, now: Date): Promise<HttpResult> {
  const { idempotencyKey: _k, ...h } = headersFor(p, eventId, Buffer.alloc(0), now);
  return getReceipt(ctx.db, h, eventId, now);
}

/** Run the worker and one scheduler pass at a fixed time. */
export async function drain(ctx: Ctx, now: Date) {
  const jobs = await runDueJobs(ctx.db, "test-worker", now);
  const tick = await schedulerTick(ctx.db, ctx.distributor, now);
  return { jobs, ...tick };
}

export const ROUTINE_STORY = {
  type: "original_brief",
  headline: "What changed in the district reporting calendar",
  standfirst: "Our desk compares the new reporting dates with the previous district notice.",
  body: [
    { type: "heading", text: "What the notice changes" },
    { type: "paragraph", text: "The new notice revises the reporting calendar. The earlier circular provides the baseline for the dates compared in this report." },
  ],
  sectionSlug: "policy",
  termSlugs: [{ kind: "state", slug: "karnataka" }],
  contribution: "prior_notice_comparison",
  contributionNote: "Checked the new calendar against circular 173 and listed each changed date.",
  citations: [
    { url: "https://health.example/notices/204", label: "District reporting calendar released", publisherName: "State Health Bulletin", isPrimary: true },
    { url: "https://health.example/notices/173", label: "Previous district reporting circular", publisherName: "State Health Bulletin" },
  ],
} as const;

export const key = () => `test-${randomUUID()}`;
