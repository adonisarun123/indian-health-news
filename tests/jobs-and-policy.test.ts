/** Queue recovery (ING-04) and the pure publishing rules (PUB-01). */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestEvents, jobs } from "@/db/schema";
import { backoffMs, claim, enqueue, LEASE_MS, replayDead } from "@/core/jobs";
import { currentGrant, decideSourceCard, type CardInput, type GrantView } from "@/core/policy";
import { assessRisk, languageMismatch } from "@/core/risk";
import { checkSourceUrl, normalizeUrl } from "@/core/urls";
import { runDueJobs } from "@/worker/run";
import { at, createCtx, type Ctx, notice, receipt, send, T0 } from "./helpers";

describe("ING-04 — leases, backoff, dead letters and replay", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("reclaims a job after a worker crash once the lease expires", async () => {
    await enqueue(ctx.db, { queue: "q1", kind: "noop", key: "crash-1", payload: {}, runAt: T0 });
    const first = await claim(ctx.db, "crashed-worker", T0);
    expect(first?.key).toBe("crash-1");
    expect(await claim(ctx.db, "other", new Date(T0.getTime() + LEASE_MS - 1))).toBeNull();
    const second = await claim(ctx.db, "other", new Date(T0.getTime() + LEASE_MS));
    expect(second).toMatchObject({ key: "crash-1", attempts: 2, leaseOwner: "other" });
    await ctx.db.delete(jobs);
  });

  it("isolates a failing source, dead-letters after five attempts and replays without a duplicate", async () => {
    const good = notice();
    const bad = notice({ source_id: "kerala-bulletin-demo", external_id: "kl-1", source_url: "https://kerala-health.example/notices/1", source_title: "Meeting notice for district officers" });
    await send(ctx, ctx.seed.producers.a, bad, T0);
    await send(ctx, ctx.seed.producers.a, good, T0);

    let broken = true;
    const { handlers } = await import("@/worker/run");
    const flaky = {
      ...handlers,
      "ingest.process": async (...args: Parameters<(typeof handlers)[string]>) => {
        const [event] = await ctx.db.select().from(ingestEvents).where(eq(ingestEvents.id, (args[1].payload as { ingestEventId: string }).ingestEventId));
        if (broken && event!.externalId === "kl-1") throw new Error("parser drift: unexpected markup");
        return handlers["ingest.process"]!(...args);
      },
    };

    // The good source completes on the first pass while the bad one is retried.
    let now = T0;
    await runDueJobs(ctx.db, "w", now, { handlers: flaky, random: () => 0 });
    expect((await receipt(ctx, ctx.seed.producers.a, String(good.event_id), now)).body).toMatchObject({ status: "applied" });
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 20 * 60_000);
      await runDueJobs(ctx.db, "w", now, { handlers: flaky, random: () => 0 });
    }
    const [dead] = await ctx.db.select().from(jobs).where(eq(jobs.status, "dead"));
    expect(dead).toMatchObject({ attempts: 5, lastError: "parser drift: unexpected markup" });
    expect((await receipt(ctx, ctx.seed.producers.a, String(bad.event_id), now)).body).toMatchObject({ status: "failed", reason_code: "PROCESSING_FAILED", retryable: true });

    // Adapter fixed. Replay uses the same business key, so nothing is duplicated.
    broken = false;
    await ctx.db.update(ingestEvents).set({ status: "accepted", reasonCode: null }).where(eq(ingestEvents.id, (dead!.payload as { ingestEventId: string }).ingestEventId));
    expect(await replayDead(ctx.db, dead!.id, now)).toBe(true);
    await runDueJobs(ctx.db, "w", now, { handlers: flaky });
    expect((await receipt(ctx, ctx.seed.producers.a, String(bad.event_id), now)).body).toMatchObject({ status: "applied", reason_code: "CARD_PUBLISHED" });
    expect(await ctx.db.select().from(jobs)).toHaveLength(2);
  });

  it("backs off exponentially with jitter and a ceiling", () => {
    expect(backoffMs(1, () => 0)).toBe(2500);
    expect(backoffMs(1, () => 1)).toBe(5000);
    expect(backoffMs(3, () => 1)).toBe(20000);
    expect(backoffMs(30, () => 1)).toBe(15 * 60_000);
  });
});

describe("PUB-01 — the most restrictive rule wins", () => {
  const grant: GrantView = { id: "g", version: 1, basis: "link_only", allowHeadline: true, allowExcerpt: false, excerptMaxChars: 0, allowFullText: false, allowImages: false, channels: ["web"], effectiveAt: at(-60), expiresAt: null, revokedAt: null };
  const base: CardInput = { sourceStatus: "enabled", grant, riskRoute: "routine", riskFlags: [], flags: { autoPublish: true, sourceCards: true }, automationEnabled: true, embargoUntil: null, sourcePublishedAt: at(-6), languageMismatch: false, suppressed: false, now: T0 };

  it("publishes only when every rule passes", () => {
    expect(decideSourceCard(base)).toEqual({ outcome: "publish", reasons: [] });
    expect(decideSourceCard({ ...base, embargoUntil: at(30) }).reasons).toEqual(["EMBARGO_ACTIVE"]);
    expect(decideSourceCard({ ...base, embargoUntil: at(-1) }).outcome).toBe("publish");
    expect(decideSourceCard({ ...base, riskFlags: ["vaccine_guidance"], riskRoute: "clinical" }).reasons).toEqual(["RISK_REVIEW_REQUIRED"]);
    expect(decideSourceCard({ ...base, grant: null }).reasons).toEqual(["RIGHTS_UNKNOWN"]);
    expect(decideSourceCard({ ...base, sourcePublishedAt: null }).reasons).toEqual(["AMBIGUOUS_DATE"]);
    expect(decideSourceCard({ ...base, sourcePublishedAt: at(60) }).reasons).toEqual(["AMBIGUOUS_DATE"]);
    expect(decideSourceCard({ ...base, sourceStatus: "under_review" }).reasons).toEqual(["SOURCE_NOT_ENABLED"]);
    expect(decideSourceCard({ ...base, automationEnabled: false })).toEqual({ outcome: "await_editor", reasons: ["SOURCE_AUTOMATION_OFF"] });
    // A hold always beats a mere automation switch.
    expect(decideSourceCard({ ...base, automationEnabled: false, riskFlags: ["drug_safety"] }).outcome).toBe("hold");
  });

  it("never falls back to an older grant after expiry or revocation", () => {
    const v1 = { ...grant, id: "v1", version: 1 };
    const v2 = { ...grant, id: "v2", version: 2, expiresAt: at(-1) };
    expect(currentGrant([v1, v2], T0)).toBeNull();
    expect(currentGrant([v1, { ...v2, expiresAt: null, revokedAt: at(-1) }], T0)).toBeNull();
    expect(currentGrant([v1, { ...v2, expiresAt: at(10) }], T0)?.id).toBe("v2");
    expect(currentGrant([v1, { ...v2, effectiveAt: at(10), expiresAt: null }], T0)?.id).toBe("v1");
    expect(currentGrant([{ ...v1, basis: "unknown" }], T0)).toBeNull();
  });

  it("flags clinical and sensitive wording and leaves administrative notices alone", () => {
    expect(assessRisk("District reporting calendar released")).toEqual({ route: "routine", flags: [] });
    expect(assessRisk("Consultation window opens for district plans").route).toBe("routine");
    expect(assessRisk("Drug safety alert: batch recall for a paediatric syrup").route).toBe("clinical");
    expect(assessRisk("Nipah cases reported in two districts").flags).toEqual(expect.arrayContaining(["outbreak_figures", "named_disease"]));
    expect(assessRisk("Hospital denies negligence after patient, 34, dies").route).toBe("sensitive");
    expect(assessRisk("Meeting notice", "clinical")).toEqual({ route: "clinical", flags: ["source_default_clinical"] });
    expect(languageMismatch("en", "ജില്ലാ റിപ്പോർട്ടിംഗ് കലണ്ടർ")).toBe(true);
    expect(languageMismatch("ml", "ജില്ലാ റിപ്പോർട്ടിംഗ് കലണ്ടർ")).toBe(false);
  });

  it("normalizes URLs for matching and enforces the host allowlist", () => {
    expect(normalizeUrl("https://Health.Example/notices/204/?utm_source=x&id=7&fbclid=abc#top")).toBe("https://health.example/notices/204?id=7");
    const allowed = [{ host: "health.example", pathPrefix: "/notices" }];
    expect(checkSourceUrl("https://health.example/notices/204", allowed).ok).toBe(true);
    expect(checkSourceUrl("https://health.example/noticeboard", allowed).ok).toBe(false);
    expect(checkSourceUrl("https://health.example.evil.test/notices/1", allowed).ok).toBe(false);
    expect(checkSourceUrl("https://user:pw@health.example/notices/1", allowed).ok).toBe(false);
    expect(checkSourceUrl("https://health.example:8443/notices/1", allowed).ok).toBe(false);
  });
});
