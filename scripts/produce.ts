/**
 * Fixture producer: stands in for the scraper until one exists.
 *
 *   npm run produce -- fixtures/events/notice-204-r1.json
 *   npm run produce -- fixtures/events/*.json --base http://localhost:3000
 *
 * Signs each file exactly as API-01 specifies, posts it, then polls the receipt.
 * A fresh event_id is generated unless the file sets one and --keep-id is given.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { signRequest } from "../src/core/crypto";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = flag("--base") ?? process.env.INGEST_BASE_URL ?? "http://localhost:3000";
const key = flag("--key") ?? process.env.PRODUCER_KEY;
const secret = flag("--secret") ?? process.env.PRODUCER_SECRET;
const keepId = args.includes("--keep-id");
const files = args.filter((a, i) => !a.startsWith("--") && !["--base", "--key", "--secret"].includes(args[i - 1] ?? ""));

if (!key || !secret) throw new Error("Set PRODUCER_KEY and PRODUCER_SECRET (printed by `npm run db:seed -- --demo`).");
if (files.length === 0) throw new Error("Give at least one fixture file.");

const sign = (eventId: string, body: Buffer) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { "X-Producer-Key": key, "X-Timestamp": timestamp, "X-Signature": signRequest(secret, timestamp, eventId, body) };
};

for (const file of files) {
  const event = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!keepId || !event.event_id) event.event_id = randomUUID();
  event.observed_at ??= new Date().toISOString();
  const eventId = String(event.event_id);
  const body = Buffer.from(JSON.stringify(event), "utf8");

  const res = await fetch(`${base}/api/v1/ingest/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": eventId, ...sign(eventId, body) },
    body,
  });
  const receipt = (await res.json()) as { status?: string; status_url?: string; code?: string; message?: string };
  console.log(`${file}\n  POST ${res.status}`, JSON.stringify(receipt));
  if (!res.ok || !receipt.status_url) continue;

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${base}${receipt.status_url}`, { headers: sign(eventId, Buffer.alloc(0)) });
    const status = (await poll.json()) as { status?: string; reason_code?: string };
    if (status.status && !["accepted", "processing"].includes(status.status)) {
      console.log(`  receipt: ${status.status}${status.reason_code ? ` (${status.reason_code})` : ""}`);
      break;
    }
    if (i === 9) console.log("  still queued. Is the worker running? (npm run worker)");
  }
}
