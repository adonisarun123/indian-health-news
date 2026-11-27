/**
 * The platform side of the scraper: registering the manifest's sources and
 * issuing, assigning and rotating its producer key, checked through the real intake.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/core/articles";
import { assignSources, createProducer, listProducers, type ProducerCredentials, rotateSecret, setEnvLines } from "@/core/producers";
import { registerSources } from "@/core/sources";
import { auditEntries, sourceGrants, sourceHosts, sources } from "@/db/schema";
import { loadManifest, pickSources, registerEntryOf } from "../scraper/lib/manifest";
import { at, type Ctx, createCtx, notice, send, T0 } from "./helpers";

const manifest = loadManifest("scraper/sources.json");
const entries = (slugs: string[]) => pickSources(manifest, slugs).map(registerEntryOf);

describe("scraper setup", () => {
  let ctx: Ctx;
  let me: Actor;
  let editor: Actor;
  let creds: ProducerCredentials;
  let n = 0;
  const submit = (c: ProducerCredentials, sourceId: string, url: string, when: Date) =>
    send(ctx, { id: c.producerId, keyId: c.keyId, secret: c.secret }, notice({ source_id: sourceId, external_id: `item-${++n}`, source_url: url }), when);
  const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

  beforeAll(async () => {
    ctx = await createCtx();
    me = await ctx.actor("managingEditor");
    editor = await ctx.actor("editor");
  });
  afterAll(async () => ctx.close());

  it("registers manifest sources once, on trial with an unknown grant, and reports what already exists", async () => {
    const first = await registerSources(ctx.db, me, entries(["who", "cdc", "the-hindu"]), T0, { trialReason: "Scraper trial." });
    expect(first.map((r) => [r.slug, r.outcome, r.status])).toEqual([
      ["the-hindu", "registered", "under_review"],
      ["who", "registered", "under_review"],
      ["cdc", "registered", "under_review"],
    ]);
    const [cdc] = await ctx.db.select().from(sources).where(eq(sources.slug, "cdc"));
    expect(cdc).toMatchObject({ family: "national_authority", defaultSectionSlug: "public-health", status: "under_review" });
    const hosts = await ctx.db.select({ host: sourceHosts.host, prefix: sourceHosts.pathPrefix }).from(sourceHosts).where(eq(sourceHosts.sourceId, cdc!.id));
    expect(hosts.map((h) => h.host).sort()).toEqual(["tools.cdc.gov", "www.cdc.gov"]);
    const [grant] = await ctx.db.select().from(sourceGrants).where(eq(sourceGrants.sourceId, cdc!.id));
    expect(grant).toMatchObject({ basis: "unknown", version: 1 });

    const again = await registerSources(ctx.db, me, entries(["who", "cdc"]), T0, { trialReason: "Scraper trial." });
    expect(again.map((r) => r.outcome)).toEqual(["exists", "exists"]);
    const moved = await registerSources(ctx.db, me, [{ ...entries(["who"])[0]!, hosts: ["who.int"] }], T0);
    expect(moved[0]).toMatchObject({ outcome: "hosts_differ", detail: "register has www.who.int; input has who.int" });

    const refused = await registerSources(ctx.db, editor, entries(["stat"]), T0, { trialReason: "Scraper trial." });
    expect(refused[0]).toMatchObject({ slug: "stat", outcome: "failed" });
    expect(refused[0]!.detail).toContain("FORBIDDEN");
    const kept = await registerSources(ctx.db, me, entries(["stat"]), T0);
    expect(kept[0]).toMatchObject({ outcome: "registered", status: "proposed" });
  });

  it("issues a key the intake accepts, only for the sources assigned to it", async () => {
    await expect(createProducer(ctx.db, editor, { keyId: "ihn-scraper", name: "Scraper", sourceSlugs: ["who"], reason: "Setup." }, T0)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createProducer(ctx.db, me, { keyId: "ihn-scraper", name: "Scraper", sourceSlugs: ["who", "not-registered"], reason: "Setup." }, T0)).rejects.toMatchObject({ code: "SOURCE_UNKNOWN" });
    await expect(createProducer(ctx.db, me, { keyId: "ihn-scraper", name: "Scraper", sourceSlugs: ["who"], reason: " " }, T0)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    creds = await createProducer(ctx.db, me, { keyId: "ihn-scraper", name: "India Health News scraper", sourceSlugs: ["who", "cdc"], reason: "Setup." }, T0);
    expect(creds.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(createProducer(ctx.db, me, { keyId: "ihn-scraper", name: "Again", sourceSlugs: ["who"], reason: "Setup." }, T0)).rejects.toMatchObject({ code: "KEY_TAKEN" });

    expect((await submit(creds, "who", "https://www.who.int/news/item/26-11-2026-a", at(1))).status).toBe(202);
    expect((await submit(creds, "cdc", "https://www.cdc.gov/media/releases/2026/a.html", at(1))).status).toBe(202);
    const notMine = await submit(creds, "the-hindu", "https://www.thehindu.com/sci-tech/health/a.ece", at(1));
    expect([notMine.status, code(notMine)]).toEqual([403, "SOURCE_NOT_AUTHORIZED"]);

    expect(await assignSources(ctx.db, me, "ihn-scraper", ["who", "the-hindu"], "Add The Hindu.", at(2))).toBe(1);
    expect((await submit(creds, "the-hindu", "https://www.thehindu.com/sci-tech/health/a.ece", at(3))).status).toBe(202);

    const trail = await ctx.db.select({ action: auditEntries.action, diff: auditEntries.diff }).from(auditEntries).where(and(eq(auditEntries.subjectType, "producer"), eq(auditEntries.subjectId, creds.producerId)));
    expect(trail).toEqual([
      { action: "producer.create", diff: { keyId: "ihn-scraper", sources: ["cdc", "who"] } },
      { action: "producer.assign", diff: { sources: ["the-hindu"] } },
    ]);
  });

  it("rotates the secret with an overlap, after which only the new one signs", async () => {
    await expect(rotateSecret(ctx.db, me, "ihn-scraper", { overlapHours: -1, reason: "Rotate." }, at(10))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(rotateSecret(ctx.db, me, "no-such-key", { overlapHours: 1, reason: "Rotate." }, at(10))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const next = await rotateSecret(ctx.db, me, "ihn-scraper", { overlapHours: 1, reason: "Rotate." }, at(10));
    expect(next.secret).not.toBe(creds.secret);

    expect((await submit(creds, "who", "https://www.who.int/news/item/b", at(20))).status).toBe(202);
    expect((await submit(next, "who", "https://www.who.int/news/item/c", at(20))).status).toBe(202);
    const old = await submit(creds, "who", "https://www.who.int/news/item/d", at(80));
    expect([old.status, code(old)]).toEqual([401, "SIGNATURE_INVALID"]);
    expect((await submit(next, "who", "https://www.who.int/news/item/e", at(80))).status).toBe(202);

    const [p] = await listProducers(ctx.db).then((l) => l.filter((x) => x.keyId === "ihn-scraper"));
    expect(p!.sources).toEqual(["cdc", "the-hindu", "who"]);
    expect(p!.secrets.map((s) => [s.validUntil?.toISOString() ?? null, s.readable])).toEqual([
      [at(70).toISOString(), true],
      [null, true],
    ]);
  });

  it("writes the credentials into an env file without disturbing other lines", () => {
    expect(setEnvLines("A=1\r\nPRODUCER_KEY=old\r\n# PRODUCER_SECRET=example\r\n", { PRODUCER_KEY: "ihn-scraper", PRODUCER_SECRET: "s3cret" })).toBe(
      "A=1\nPRODUCER_KEY=ihn-scraper\n# PRODUCER_SECRET=example\nPRODUCER_SECRET=s3cret\n",
    );
    expect(setEnvLines("", { A: "1" })).toBe("A=1\n");
    expect(() => setEnvLines("", { A: "1\n2" })).toThrow("single line");
  });
});
