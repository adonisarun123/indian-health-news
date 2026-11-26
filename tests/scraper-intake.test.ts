/**
 * The scraper against the real intake: its events go through receiveEvent,
 * the worker and getReceipt exactly as they would over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getReceipt, receiveEvent } from "@/core/ingest/receive";
import { IngestClient, type Transport } from "../scraper/lib/client";
import { manifestSchema, type Source } from "../scraper/lib/manifest";
import { pollReceipts, runOnce } from "../scraper/lib/run";
import { Store } from "../scraper/lib/store";
import { fakeWeb, item, rss, xml } from "../scraper/test/helpers";
import { type Ctx, createCtx, drain, T0 } from "./helpers";

const FEED = "https://health.example/feed.xml";

function scraperSource(over: Record<string, unknown> = {}): Source {
  return manifestSchema.parse({
    version: 1,
    probedOn: "2026-11-19",
    notCarried: [],
    sources: [
      {
        slug: "state-bulletin-demo",
        displayName: "State Health Bulletin",
        legalName: "State Health Bulletin (demo)",
        homepageUrl: "https://health.example/",
        family: "state_local",
        wave: 1,
        enabled: true,
        adapter: "rss",
        feedUrl: FEED,
        hosts: [{ host: "health.example", pathPrefix: "/" }],
        ...over,
      },
    ],
  }).sources[0]!;
}

describe("scraper to intake", () => {
  let ctx: Ctx;
  let t = T0.getTime();
  const now = () => new Date(t);
  const advance = (minutes: number) => {
    t += minutes * 60_000;
  };
  let feed = "";
  const web = fakeWeb({ [FEED]: () => xml(feed) });

  beforeAll(async () => {
    ctx = await createCtx();
  });
  afterAll(async () => ctx.close());

  /** The platform's intake handlers behind the scraper's transport interface. */
  const transport = (): Transport => ({
    async send(method, path, headers, body) {
      const h = { producerKey: headers["X-Producer-Key"] ?? null, timestamp: headers["X-Timestamp"] ?? null, signature: headers["X-Signature"] ?? null, idempotencyKey: headers["Idempotency-Key"] ?? null };
      const r = method === "POST" ? await receiveEvent(ctx.db, h, body!, now()) : await getReceipt(ctx.db, h, path.split("/").pop()!, now());
      return { status: r.status, body: r.body, retryAfter: r.headers?.["Retry-After"] ?? null };
    },
  });

  const scraper = (store: Store) => ({
    http: web.http,
    config: { maxAgeDays: 7, sendPerMinute: 6000, hostConcurrency: 1 },
    now,
    log: () => undefined,
    sleep: async () => undefined,
    notify: async () => undefined,
    store,
    client: new IngestClient({ key: ctx.seed.producers.a.keyId, secret: ctx.seed.producers.a.secret, transport: transport(), clock: now }),
  });

  const notice = (title: string) => rss([item({ title, link: "https://health.example/notices/204?utm_source=rss", guid: "notice-204", date: "Thu, 19 Nov 2026 09:00:00 +0530" })]);

  const settle = async (d: ReturnType<typeof scraper>) => {
    advance(2);
    await drain(ctx, now());
    return pollReceipts(d);
  };

  it("publishes a link-only card, then a revision when the headline changes", async () => {
    const store = new Store(":memory:");
    const d = scraper(store);
    feed = notice("District reporting calendar released");
    const first = await runOnce(d, [scraperSource()], { send: true });
    expect(first.runs[0]).toMatchObject({ outcome: "ok", staged: { new: 1 } });
    expect(first.send).toMatchObject({ sent: 1, parked: 0 });
    expect(await settle(d)).toEqual({ applied: 1 });
    expect(store.db.prepare("select revision, reason_code from outbox where state = 'sent'").get()).toEqual({ revision: 1, reason_code: "CARD_PUBLISHED" });

    feed = notice("District reporting calendar released (revised dates)");
    advance(16);
    const second = await runOnce(d, [scraperSource()], { send: true });
    expect(second.runs[0]).toMatchObject({ staged: { revised: 1 } });
    expect(await settle(d)).toEqual({ applied: 1 });
    store.close();
  });

  it("recovers from a lost scraper database by re-issuing past the platform's revisions", async () => {
    const fresh = new Store(":memory:");
    const d = scraper(fresh);
    feed = notice("District reporting calendar released (final dates)");
    advance(16);
    const run = await runOnce(d, [scraperSource()], { send: true });
    // Revisions 1 and 2 already exist upstream with other content: intake answers 409 twice.
    expect(run.send).toMatchObject({ sent: 1, reissued: 2, parked: 0 });
    expect(await settle(d)).toEqual({ applied: 1 });
    expect(fresh.db.prepare("select revision from outbox where state = 'sent'").get()).toEqual({ revision: 3 });
    fresh.close();
  });

  it("parks an event whose host the source register does not approve, and alerts", async () => {
    const store = new Store(":memory:");
    const d = scraper(store);
    feed = rss([item({ title: "Ward timetable published", link: "https://mirror.health.example/notices/9", guid: "notice-9", date: "Thu, 19 Nov 2026 09:00:00 +0530" })]);
    advance(16);
    const src = scraperSource({ hosts: [{ host: "health.example", pathPrefix: "/" }, { host: "mirror.health.example", pathPrefix: "/" }] });
    const run = await runOnce(d, [src], { send: true });
    expect(run.send).toMatchObject({ sent: 0, parked: 1 });
    expect(store.recentAlerts()[0]).toMatchObject({ kind: "url_not_allowed", source_id: "state-bulletin-demo" });
    store.close();
  });

  it("keeps events for a source the platform has not registered or assigned", async () => {
    const store = new Store(":memory:");
    const d = scraper(store);
    feed = notice("District reporting calendar released");
    advance(16);
    const run = await runOnce(d, [scraperSource({ slug: "the-hindu" })], { send: true });
    expect(run.send).toMatchObject({ sent: 0, refusedSources: ["the-hindu"] });
    expect(store.db.prepare("select state, last_error from outbox").get()).toEqual({ state: "pending", last_error: "SOURCE_NOT_AUTHORIZED: This producer is not assigned to that source." });
    store.close();
  });
});
