/**
 * Seed data. `seedReference` is real launch taxonomy. `seedDemo` is fictional
 * fixture data for development and tests only: never run it against production.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "./client";
import {
  desks,
  memberships,
  people,
  producers,
  producerSecrets,
  producerSources,
  reviewerCredentials,
  searchSynonyms,
  sourceAutomation,
  sourceGrants,
  sourceHosts,
  sources,
  termAliases,
  terms,
} from "./schema";
import { encryptSecret, newProducerSecret } from "@/core/crypto";
import { seedPolicyPages } from "./seed-pages";

const SECTIONS: [string, string][] = [
  ["public-health", "Public Health"],
  ["policy", "Policy and Regulation"],
  ["research", "Research"],
  ["medicines-devices", "Medicines and Devices"],
  ["healthcare-delivery", "Healthcare Delivery"],
];

/** 28 states and 8 union territories. */
const STATES: [string, string, string[]?][] = [
  ["andhra-pradesh", "Andhra Pradesh"],
  ["arunachal-pradesh", "Arunachal Pradesh"],
  ["assam", "Assam"],
  ["bihar", "Bihar"],
  ["chhattisgarh", "Chhattisgarh", ["Chattisgarh"]],
  ["goa", "Goa"],
  ["gujarat", "Gujarat"],
  ["haryana", "Haryana"],
  ["himachal-pradesh", "Himachal Pradesh"],
  ["jharkhand", "Jharkhand"],
  ["karnataka", "Karnataka"],
  ["kerala", "Kerala"],
  ["madhya-pradesh", "Madhya Pradesh"],
  ["maharashtra", "Maharashtra"],
  ["manipur", "Manipur"],
  ["meghalaya", "Meghalaya"],
  ["mizoram", "Mizoram"],
  ["nagaland", "Nagaland"],
  ["odisha", "Odisha", ["Orissa"]],
  ["punjab", "Punjab"],
  ["rajasthan", "Rajasthan"],
  ["sikkim", "Sikkim"],
  ["tamil-nadu", "Tamil Nadu", ["Tamilnadu"]],
  ["telangana", "Telangana"],
  ["tripura", "Tripura"],
  ["uttar-pradesh", "Uttar Pradesh"],
  ["uttarakhand", "Uttarakhand", ["Uttaranchal"]],
  ["west-bengal", "West Bengal"],
  ["andaman-and-nicobar-islands", "Andaman and Nicobar Islands"],
  ["chandigarh", "Chandigarh"],
  ["dadra-and-nagar-haveli-and-daman-and-diu", "Dadra and Nagar Haveli and Daman and Diu"],
  ["delhi", "Delhi", ["New Delhi", "NCT of Delhi"]],
  ["jammu-and-kashmir", "Jammu and Kashmir", ["J&K"]],
  ["ladakh", "Ladakh"],
  ["lakshadweep", "Lakshadweep"],
  ["puducherry", "Puducherry", ["Pondicherry"]],
];

/** Renamed places and common spellings. Search treats each pair as the same word. */
const SYNONYMS: [string, string][] = [
  ["bengaluru", "bangalore"],
  ["mumbai", "bombay"],
  ["kolkata", "calcutta"],
  ["chennai", "madras"],
  ["thiruvananthapuram", "trivandrum"],
  ["kochi", "cochin"],
  ["pune", "poona"],
  ["varanasi", "benares"],
  ["mysuru", "mysore"],
  ["mangaluru", "mangalore"],
  ["gurugram", "gurgaon"],
  ["prayagraj", "allahabad"],
  ["vadodara", "baroda"],
  ["puducherry", "pondicherry"],
  ["odisha", "orissa"],
  ["tb", "tuberculosis"],
  ["covid", "coronavirus"],
];

export async function seedReference(db: Db): Promise<void> {
  await seedPolicyPages(db, new Date());
  for (const [term, synonym] of SYNONYMS) await db.insert(searchSynonyms).values({ term, synonym }).onConflictDoNothing();
  for (const [slug, name] of SECTIONS) {
    await db.insert(terms).values({ kind: "section", slug, name }).onConflictDoNothing();
  }
  for (const [slug, name, aliases] of STATES) {
    await db.insert(terms).values({ kind: "state", slug, name }).onConflictDoNothing();
    if (aliases?.length) {
      const [term] = await db.select().from(terms).where(and(eq(terms.kind, "state"), eq(terms.slug, slug)));
      for (const alias of aliases) await db.insert(termAliases).values({ termId: term!.id, alias }).onConflictDoNothing();
    }
  }
}

export interface DemoSeed {
  people: Record<"reporter" | "editor" | "editor2" | "managingEditor" | "reviewer" | "admin", string>;
  sources: Record<"bulletin" | "bulletinKerala" | "unknownGrant" | "partner", string>;
  grants: { partner: string; bulletin: string };
  producers: Record<"a" | "b", { id: string; keyId: string; secret: string }>;
}

/** Fictional newsroom, three demo sources and two independent producer identities. */
export async function seedDemo(db: Db, now: Date): Promise<DemoSeed> {
  const person = async (slug: string, displayName: string, roles: (typeof memberships.$inferInsert)["role"][]) => {
    const [p] = await db.insert(people).values({ slug, displayName, email: `${slug}@newsroom.example`, status: "active", hasPublicProfile: true }).returning();
    for (const role of roles) await db.insert(memberships).values({ personId: p!.id, role });
    return p!.id;
  };
  await db.insert(desks).values({ slug: "health-desk", name: "Health Desk" }).onConflictDoNothing();
  const ppl = {
    reporter: await person("mira", "Mira Rao", ["reporter"]),
    editor: await person("demo-editor", "Demo Editor", ["editor"]),
    editor2: await person("demo-editor-two", "Second Demo Editor", ["editor"]),
    managingEditor: await person("demo-managing-editor", "Demo Managing Editor", ["managing_editor"]),
    reviewer: await person("demo-reviewer", "Demo Medical Reviewer", ["medical_reviewer"]),
    admin: await person("demo-admin", "Demo Administrator", ["administrator"]),
  };
  await db.insert(reviewerCredentials).values({ personId: ppl.reviewer, specialty: "Community medicine", evidenceUri: "private://credentials/demo-reviewer", verifiedBy: ppl.admin, verifiedAt: new Date(now.getTime() - 86_400_000) });

  const state = async (slug: string) => (await db.select().from(terms).where(and(eq(terms.kind, "state"), eq(terms.slug, slug))))[0]!.id;
  const source = async (v: typeof sources.$inferInsert, host: string) => {
    const [s] = await db.insert(sources).values(v).returning();
    await db.insert(sourceHosts).values({ sourceId: s!.id, host });
    return s!.id;
  };

  const bulletin = await source(
    { slug: "state-bulletin-demo", legalName: "State Health Bulletin (demo)", displayName: "State Health Bulletin", homepageUrl: "https://health.example/", family: "state_local", jurisdictionTermId: await state("karnataka"), status: "enabled", adapter: "fixture", ownerPersonId: ppl.managingEditor },
    "health.example",
  );
  const bulletinKerala = await source(
    { slug: "kerala-bulletin-demo", legalName: "Kerala Health Bulletin (demo)", displayName: "Kerala Health Bulletin", homepageUrl: "https://kerala-health.example/", family: "state_local", jurisdictionTermId: await state("kerala"), status: "enabled", adapter: "fixture" },
    "kerala-health.example",
  );
  const unknownGrant = await source(
    { slug: "unknown-grant-demo", legalName: "Unlicensed Health Desk (demo)", displayName: "Unlicensed Health Desk", homepageUrl: "https://unlicensed.example/", family: "independent_commercial", status: "enabled", adapter: "fixture" },
    "unlicensed.example",
  );
  const partner = await source(
    { slug: "partner-demo", legalName: "Partner Health Wire (demo)", displayName: "Partner Health Wire", homepageUrl: "https://partner.example/", family: "independent_commercial", status: "enabled", adapter: "fixture" },
    "partner.example",
  );

  const linkOnly = { basis: "link_only" as const, allowHeadline: true, channels: ["web", "rss"], effectiveAt: new Date(now.getTime() - 86_400_000), evidenceUri: "private://grants/demo-link-only" };
  const [gBulletin] = await db.insert(sourceGrants).values({ sourceId: bulletin, version: 1, ...linkOnly }).returning();
  await db.insert(sourceGrants).values({ sourceId: bulletinKerala, version: 1, ...linkOnly });
  await db.insert(sourceGrants).values({ sourceId: unknownGrant, version: 1, basis: "unknown" });
  // The partner allows text and headline, and disallows images.
  const [gPartner] = await db
    .insert(sourceGrants)
    .values({ sourceId: partner, version: 1, basis: "licence", allowHeadline: true, allowExcerpt: true, excerptMaxChars: 300, allowFullText: true, allowImages: false, channels: ["web"], attributionText: "Republished with permission from Partner Health Wire", effectiveAt: new Date(now.getTime() - 86_400_000), expiresAt: new Date(now.getTime() + 30 * 86_400_000), evidenceUri: "private://grants/demo-partner" })
    .returning();
  for (const s of [bulletin, bulletinKerala, unknownGrant, partner]) {
    await db.insert(sourceAutomation).values({ sourceId: s, format: "source_card", enabled: true });
  }

  const producer = async (keyId: string, name: string, sourceIds: string[]) => {
    const secret = newProducerSecret();
    const [p] = await db.insert(producers).values({ keyId, name }).returning();
    await db.insert(producerSecrets).values({ producerId: p!.id, secretCiphertext: encryptSecret(secret), validFrom: new Date(now.getTime() - 86_400_000) });
    for (const sourceId of sourceIds) await db.insert(producerSources).values({ producerId: p!.id, sourceId });
    return { id: p!.id, keyId, secret };
  };

  return {
    people: ppl,
    sources: { bulletin, bulletinKerala, unknownGrant, partner },
    grants: { partner: gPartner!.id, bulletin: gBulletin!.id },
    producers: {
      a: await producer("demo-producer-a", "Demo producer A", [bulletin, bulletinKerala, unknownGrant]),
      b: await producer("demo-producer-b", "Demo producer B", [partner]),
    },
  };
}

/**
 * Rebuild the demo handles from a database that already holds the demo seed,
 * so demo content can be added later. Producer secrets come from the caller
 * because they are stored encrypted.
 */
export async function loadDemoSeed(db: Db, secrets: { a: string; b: string }): Promise<DemoSeed> {
  const personId = async (slug: string) => {
    const [p] = await db.select().from(people).where(eq(people.slug, slug));
    if (!p) throw new Error(`Demo person ${slug} not found. Run the demo seed first.`);
    return p.id;
  };
  const sourceId = async (slug: string) => {
    const [s] = await db.select().from(sources).where(eq(sources.slug, slug));
    if (!s) throw new Error(`Demo source ${slug} not found. Run the demo seed first.`);
    return s.id;
  };
  const grantId = async (source: string) => (await db.select().from(sourceGrants).where(eq(sourceGrants.sourceId, source)))[0]!.id;
  const producer = async (keyId: string, secret: string) => {
    const [p] = await db.select().from(producers).where(eq(producers.keyId, keyId));
    if (!p) throw new Error(`Demo producer ${keyId} not found. Run the demo seed first.`);
    return { id: p.id, keyId, secret };
  };
  const src = { bulletin: await sourceId("state-bulletin-demo"), bulletinKerala: await sourceId("kerala-bulletin-demo"), unknownGrant: await sourceId("unknown-grant-demo"), partner: await sourceId("partner-demo") };
  return {
    people: { reporter: await personId("mira"), editor: await personId("demo-editor"), editor2: await personId("demo-editor-two"), managingEditor: await personId("demo-managing-editor"), reviewer: await personId("demo-reviewer"), admin: await personId("demo-admin") },
    sources: src,
    grants: { partner: await grantId(src.partner), bulletin: await grantId(src.bulletin) },
    producers: { a: await producer("demo-producer-a", secrets.a), b: await producer("demo-producer-b", secrets.b) },
  };
}
