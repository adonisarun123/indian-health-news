/** Newsroom dashboard: the counts on the landing page agree with the queue, the feed and the registers. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attention, DASHBOARD_DAYS, getDashboard } from "@/core/dashboard";
import { submitCase } from "@/core/cases";
import { listQueue } from "@/core/desk";
import { listPublicFeed } from "@/core/public";
import { setFlag } from "@/core/settings";
import { at, createCtx, type Ctx, drain, notice, send, T0 } from "./helpers";

describe("newsroom dashboard (ED-01, ADM-04)", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("starts empty, with a full run of days ending today in IST", async () => {
    const d = await getDashboard(ctx.db, T0);
    expect(d.days).toHaveLength(DASHBOARD_DAYS);
    expect(d.days.at(-1)!.day).toBe("2026-11-19");
    expect(d.days[0]!.day).toBe("2026-11-06");
    expect(d.live).toEqual({ reports: 0, cards: 0 });
    expect(d.waiting).toEqual({ total: 0, reasons: [] });
    expect(d.tasks.total).toBe(0);
    expect(d.sources.byStatus).toEqual({ enabled: 4 });
    // The demo source with an unknown grant is enabled, so it is flagged.
    expect(d.sources.notices.filter((n) => n.kind === "missing").map((n) => n.publisher)).toEqual(["Unlicensed Health Desk"]);
  });

  it("uses the IST day, not the UTC day, either side of midnight", async () => {
    // 19 Nov 23:30 UTC is already 20 Nov in India.
    const d = await getDashboard(ctx.db, new Date("2026-11-19T23:30:00Z"));
    expect(d.days.at(-1)!.day).toBe("2026-11-20");
  });

  it("counts a published card and a held item the same way the feed and the queue do", async () => {
    await send(ctx, ctx.seed.producers.a, notice(), T0);
    await send(ctx, ctx.seed.producers.a, notice({ source_id: "unknown-grant-demo", external_id: "post-88", source_url: "https://unlicensed.example/posts/88", source_title: "Hospital board meeting schedule announced" }), T0);
    await drain(ctx, T0);

    const d = await getDashboard(ctx.db, at(1));
    expect(d.live).toEqual({ reports: 0, cards: (await listPublicFeed(ctx.db, at(1))).length });
    expect(d.live.cards).toBe(1);
    expect(d.days.at(-1)).toEqual({ day: "2026-11-19", reports: 0, cards: 1 });
    expect(d.days.slice(0, -1).every((x) => x.reports + x.cards === 0)).toBe(true);
    expect(d.waiting.total).toBe((await listQueue(ctx.db)).length);
    expect(d.waiting).toEqual({ total: 1, reasons: [{ reason: "RIGHTS_UNKNOWN", n: 1 }] });
    expect(d.tasks.byKind).toEqual([{ kind: "held_item", n: 1 }]);
    expect(d.pipeline.events24h).toEqual({ applied: 1, held: 1 });
    expect(d.pipeline.lastEventAt).not.toBeNull();
    expect(d.pipeline).toMatchObject({ failedEvents: 0, deadJobs: 0 });
  });

  it("puts urgent cases and a stopped publishing switch at the top of the attention list", async () => {
    await submitCase(ctx.db, { reason: "clinical_safety", description: "The dose in the second paragraph looks unsafe.", clientKey: "d1" }, at(2));
    await submitCase(ctx.db, { reason: "factual_error", description: "The second window date is wrong.", clientKey: "d1" }, at(2));
    let d = await getDashboard(ctx.db, at(3));
    expect(d.cases).toMatchObject({ open: 2, inProgress: 0, urgent: 1 });
    expect(d.tasks.urgent).toBe(1);
    let list = attention(d);
    expect(list[0]).toMatchObject({ tone: "warn", href: "/newsroom/cases" });
    expect(list.map((a) => a.text)).toContain("1 source item waiting in the queue.");
    expect(list.map((a) => a.text)).toContain("1 enabled source with no rights grant in force.");

    await setFlag(ctx.db, await ctx.actor("editor"), "auto_publish", false, "Suspected adapter fault", at(4));
    d = await getDashboard(ctx.db, at(5));
    list = attention(d);
    expect(d.autoPublish).toBe(false);
    expect(list[0]).toMatchObject({ tone: "warn", href: "/newsroom/settings" });
    // Every link on the list goes to a newsroom page.
    expect(list.every((a) => a.href.startsWith("/newsroom"))).toBe(true);
  });
});
