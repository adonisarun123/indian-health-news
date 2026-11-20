import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEntries, editorialTasks } from "@/db/schema";
import { listCases } from "@/core/cases";
import { SUBMISSION_REASON, submitNews } from "@/core/submissions";
import { createCtx, type Ctx, T0 } from "./helpers";

describe("news submissions from the public", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  const good = { kind: "press_release", name: "Asha Rao", organisation: "District Hospital Trust", email: "asha@trust.example", phone: "+91 80 5550 0100", headline: "New dialysis unit opens at the district hospital", details: "The trust opened a twelve-bed dialysis unit on Monday. It will run two shifts a day and is free for patients holding a state health card.", link: "https://trust.example/news/dialysis-unit", confirmed: true, clientKey: "s1" };
  const send = (extra: Record<string, unknown> = {}) => submitNews(ctx.db, { ...good, ...extra }, T0);

  it("validates, files a private case for editors, opens a task and rate-limits", async () => {
    for (const bad of [{ kind: "advert" }, { name: "" }, { email: "not-an-email" }, { headline: "Short" }, { details: "Too thin." }, { link: "http://insecure.example" }, { link: "javascript:alert(1)" }, { confirmed: false }]) {
      expect(await send(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    // Rejected input records nothing and does not count against the limit.
    expect(await ctx.db.select().from(editorialTasks)).toHaveLength(0);

    const r = await send();
    expect(r.ok && r.reference).toMatch(/^IHN-20261119-\d{6}$/);

    const tasks = await ctx.db.select().from(editorialTasks);
    expect(tasks.map((t) => t.kind)).toEqual(["news_submission"]);
    // Nothing the sender typed, and no contact detail, leaks into tasks or the audit trail.
    const leak = JSON.stringify([tasks, await ctx.db.select().from(auditEntries)]);
    for (const secret of ["asha@trust.example", "Asha Rao", "5550 0100", "dialysis"]) expect(leak).not.toContain(secret);

    const [row] = await listCases(ctx.db, await ctx.actor("editor"), "open");
    expect(row).toMatchObject({ reason: SUBMISSION_REASON, isUrgent: false, articleId: null });
    expect(row!.description).toContain("Headline: New dialysis unit opens at the district hospital");
    expect(row!.description).toContain("Link: https://trust.example/news/dialysis-unit");
    expect(row!.reporterContact).toBe("Asha Rao · District Hospital Trust · asha@trust.example · +91 80 5550 0100");

    for (let i = 0; i < 2; i++) expect((await send()).ok).toBe(true);
    expect(await send()).toMatchObject({ ok: false, rateLimited: true });
    expect((await send({ clientKey: "s2", organisation: "", phone: "", link: "" })).ok).toBe(true);
  });
});
