import { describe, expect, it } from "vitest";
import { signRequest } from "../../src/core/crypto";
import { IngestClient, type Transport, type WireResponse } from "../lib/client";
import type { Candidate } from "../lib/event";
import { buildEvent } from "../lib/event";
import { pollReceipts, runOnce, sendDue } from "../lib/run";
import { Store } from "../lib/store";
import { clockAt, deps, fakeWeb, item, rss, source, xml } from "./helpers";

const KEY = "producer-test";
const SECRET = "c2VjcmV0LWZvci10ZXN0cw";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  sourceId: "example-news",
  externalId: "a1",
  sourceUrl: "https://example.in/health/a1",
  title: "Clinic opens in Hubballi",
  publishedAt: "2026-11-25T10:00:00.000Z",
  adapterVersion: "rss@1.0.0",
  ...over,
});

function stage(store: Store, c: Candidate, now: Date) {
  return store.stage(c, now, (rev, id) => {
    const b = buildEvent(c, rev, id, now);
    return b.ok ? b.body : null;
  });
}

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake intake: checks every signature, then answers with `reply`. */
function intake(reply: (req: Seen & { event?: Record<string, unknown> }, n: number) => WireResponse) {
  const seen: Seen[] = [];
  const transport: Transport = {
    async send(method, path, headers, body) {
      const raw = body ?? Buffer.alloc(0);
      const eventId = method === "POST" ? headers["Idempotency-Key"]! : path.split("/").pop()!;
      expect(headers["X-Signature"]).toBe(signRequest(SECRET, headers["X-Timestamp"]!, eventId, raw));
      const req = { method, path, headers, body: raw.toString("utf8") };
      seen.push(req);
      return reply({ ...req, event: method === "POST" ? (JSON.parse(req.body) as Record<string, unknown>) : undefined }, seen.length);
    },
  };
  return { transport, seen };
}

const accepted = (req: { event?: Record<string, unknown> }): WireResponse => ({ status: 202, body: { event_id: req.event?.event_id, status: "accepted", status_url: "/x" } });

function setup(reply: Parameters<typeof intake>[0], start = "2026-11-26T06:00:00Z") {
  const clock = clockAt(start);
  const store = new Store(":memory:");
  const fake = intake(reply);
  const d = deps(fakeWeb({}).http, clock, { store, client: new IngestClient({ key: KEY, secret: SECRET, transport: fake.transport, clock: clock.now }) });
  return { clock, store, d, seen: fake.seen };
}

describe("outbox revisions", () => {
  it("issues revision 1, then a new revision only when content changes, and drops an unsent older one", () => {
    const store = new Store(":memory:");
    const now = new Date("2026-11-26T06:00:00Z");
    expect(stage(store, cand(), now)).toBe("new");
    expect(stage(store, cand(), now)).toBe("unchanged");
    expect(stage(store, cand({ title: "Clinic opens in Hubballi on Monday" }), now)).toBe("revised");
    const rows = store.db.prepare("select revision, state from outbox order by revision").all();
    expect(rows).toEqual([
      { revision: 1, state: "dropped" },
      { revision: 2, state: "pending" },
    ]);
  });

  it("does not store an item whose event fails the contract", () => {
    const store = new Store(":memory:");
    expect(stage(store, cand({ sourceUrl: "http://example.in/x" }), new Date())).toBe("invalid");
    expect(store.db.prepare("select count(*) as n from items").get()).toEqual({ n: 0 });
  });
});

describe("sending", () => {
  it("signs, sends in order and records receipts", async () => {
    const { store, d, seen, clock } = setup(accepted);
    stage(store, cand(), clock.now());
    stage(store, cand({ externalId: "a2", sourceUrl: "https://example.in/health/a2" }), clock.now());
    const r = await sendDue(d);
    expect(r).toMatchObject({ sent: 2, retried: 0, parked: 0 });
    expect(seen.map((s) => (JSON.parse(s.body) as { external_id: string }).external_id)).toEqual(["a1", "a2"]);
    expect(seen[0]!.headers).toMatchObject({ "X-Producer-Key": KEY, "Content-Type": "application/json" });
  });

  it("retries a failed send later with byte-identical content and the same event ID", async () => {
    const { store, d, seen, clock } = setup((req, n) => (n === 1 ? { status: 503, body: { code: "UNAVAILABLE" } } : accepted(req)));
    stage(store, cand(), clock.now());
    expect(await sendDue(d)).toMatchObject({ sent: 0, retried: 1 });
    expect(await sendDue(d)).toMatchObject({ sent: 0 }); // not due yet
    clock.advance(2 * 60_000);
    expect(await sendDue(d)).toMatchObject({ sent: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).toBe(seen[0]!.body);
    expect(seen[1]!.headers["Idempotency-Key"]).toBe(seen[0]!.headers["Idempotency-Key"]);
  });

  it("re-signs once with a fresh timestamp on TIMESTAMP_SKEW", async () => {
    const { store, d, seen, clock } = setup((req, n) => (n === 1 ? { status: 401, body: { code: "TIMESTAMP_SKEW" } } : accepted(req)));
    stage(store, cand(), clock.now());
    expect(await sendDue(d)).toMatchObject({ sent: 1 });
    expect(seen).toHaveLength(2);
  });

  it("stops on 429 and waits for Retry-After without counting an attempt", async () => {
    const { store, d, clock } = setup(() => ({ status: 429, body: { code: "RATE_LIMITED" }, retryAfter: "30" }));
    stage(store, cand(), clock.now());
    stage(store, cand({ externalId: "a2", sourceUrl: "https://example.in/health/a2" }), clock.now());
    const r = await sendDue(d);
    expect(r.stopped).toMatch(/rate limit/);
    const row = store.db.prepare("select attempts, next_attempt_at, state from outbox order by rowid limit 1").get();
    expect(row).toEqual({ attempts: 0, next_attempt_at: "2026-11-26T06:00:30.000Z", state: "pending" });
  });

  it("re-issues the same content as the next revision on REVISION_CONFLICT", async () => {
    const { store, d, seen, clock } = setup((req) => ((req.event?.revision as number) === 1 ? { status: 409, body: { code: "REVISION_CONFLICT" } } : accepted(req)));
    stage(store, cand(), clock.now());
    expect(await sendDue(d)).toMatchObject({ sent: 1, reissued: 1 });
    const [first, second] = seen.map((s) => JSON.parse(s.body) as Record<string, unknown>);
    expect(second).toEqual({ ...first, revision: 2, event_id: second!.event_id });
    expect(second!.event_id).not.toBe(first!.event_id);
  });

  it("holds a refused source's events in the outbox and carries on with other sources", async () => {
    const { store, d, clock } = setup((req) => (req.event?.source_id === "unregistered" ? { status: 403, body: { code: "SOURCE_NOT_AUTHORIZED", message: "This producer is not assigned to that source." } } : accepted(req)));
    stage(store, cand({ sourceId: "unregistered" }), clock.now());
    stage(store, cand({ sourceId: "unregistered", externalId: "a2", sourceUrl: "https://example.in/health/a2" }), clock.now());
    stage(store, cand({ externalId: "a3", sourceUrl: "https://example.in/health/a3" }), clock.now());
    const r = await sendDue(d);
    expect(r).toMatchObject({ sent: 1, refusedSources: ["unregistered"] });
    expect(store.db.prepare("select count(*) as n from outbox where source_id = 'unregistered' and state = 'pending'").get()).toEqual({ n: 2 });
    expect(store.recentAlerts().map((a) => a.kind)).toEqual(["source_refused"]);
  });

  it("parks an event intake rejects as invalid and raises an alert", async () => {
    const { store, d, clock } = setup(() => ({ status: 422, body: { code: "URL_NOT_ALLOWED", message: "A URL is outside the approved hosts for this source.", field_errors: [{ field: "source_url", message: "host or path is not approved for this source" }] } }));
    stage(store, cand(), clock.now());
    expect(await sendDue(d)).toMatchObject({ parked: 1 });
    expect(store.db.prepare("select state, http_status from outbox").get()).toEqual({ state: "parked", http_status: 422 });
    expect(store.recentAlerts()[0]).toMatchObject({ kind: "url_not_allowed", source_id: "example-news" });
  });

  it("stops the run when intake rejects the producer's credentials", async () => {
    const { store, d, clock } = setup(() => ({ status: 401, body: { code: "SIGNATURE_INVALID", message: "Signature check failed." } }));
    stage(store, cand(), clock.now());
    const r = await sendDue(d);
    expect(r.stopped).toBe("SIGNATURE_INVALID: Signature check failed.");
    expect(store.db.prepare("select state from outbox").get()).toEqual({ state: "pending" });
    expect(store.recentAlerts()[0]!.kind).toBe("intake_auth");
  });

  it("polls receipts until they settle", async () => {
    const { store, d, clock } = setup((req) => (req.method === "POST" ? accepted(req) : { status: 200, body: { status: "held", reason_code: "RIGHTS_UNKNOWN" } }));
    stage(store, cand(), clock.now());
    await sendDue(d);
    expect(await pollReceipts(d)).toEqual({}); // checked less than a minute ago
    clock.advance(61_000);
    expect(await pollReceipts(d)).toEqual({ held: 1 });
    expect(store.db.prepare("select receipt_status, reason_code from outbox").get()).toEqual({ receipt_status: "held", reason_code: "RIGHTS_UNKNOWN" });
  });
});

describe("source health (AT-08: source 429 and parser drift)", () => {
  const FEED = "https://example.in/health/feed.xml";

  it("backs off a source that answers 429, honouring Retry-After, and alerts once", async () => {
    let status = 429;
    const web = fakeWeb({ [FEED]: () => (status === 429 ? new Response("", { status: 429, headers: { "Retry-After": "600" } }) : xml(rss([item({ title: "Clinic opens", link: "https://example.in/health/c1", guid: "c1" })]))) });
    const clock = clockAt("2026-11-26T06:00:00Z");
    const store = new Store(":memory:");
    const d = deps(web.http, clock, { store });
    const src = source();

    expect((await runOnce(d, [src])).runs[0]!.outcome).toBe("rate_limited");
    expect(store.feed(src.slug)).toMatchObject({ failures: 1, backoff_until: "2026-11-26T06:10:00.000Z" });

    status = 200;
    clock.advance(5 * 60_000);
    expect((await runOnce(d, [src])).runs[0]!.outcome).toBe("backoff");
    clock.advance(16 * 60_000);
    expect((await runOnce(d, [src])).runs[0]).toMatchObject({ outcome: "ok", staged: { new: 1 } });
    expect(store.feed(src.slug)).toMatchObject({ failures: 0, backoff_until: null });
    expect(web.calls.filter((c) => c.url === FEED)).toHaveLength(2);
    expect(store.recentAlerts().map((a) => a.kind)).toEqual(["rate_limited"]);
  });

  it("alerts on parser drift and on a stale feed, and skips a source that is not due", async () => {
    let body = "<html><body>New site design</body></html>";
    const web = fakeWeb({ [FEED]: () => xml(body) });
    const clock = clockAt("2026-11-26T06:00:00Z");
    const store = new Store(":memory:");
    const d = deps(web.http, clock, { store });
    const src = source({ maxAgeDays: 60 });

    expect((await runOnce(d, [src])).runs[0]!.outcome).toBe("drift");
    body = rss([item({ title: "Clinic opens", link: "https://example.in/health/c1", guid: "c1", date: "Mon, 02 Nov 2026 10:00:00 +0530" })]);
    clock.advance(60 * 60_000);
    expect((await runOnce(d, [src], { force: true })).runs[0]!.outcome).toBe("ok");
    expect((await runOnce(d, [src])).runs[0]!.outcome).toBe("not_due");
    expect(store.recentAlerts().map((a) => a.kind).sort()).toEqual(["drift", "stale_feed"]);
  });
});
