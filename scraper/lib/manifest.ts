/**
 * The source manifest (scraper/sources.json). It doubles as the registration
 * sheet for the source register: slug, names, family and approved hosts must
 * match what the managing editor records, or intake answers 403 or 422.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const IMPLEMENTED_ADAPTERS = ["rss", "news_sitemap"] as const;

const hostRule = z.strictObject({
  host: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a lowercase host name"),
  pathPrefix: z.string().startsWith("/").default("/"),
});

const source = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,118}$/, "must be a lowercase slug"),
  displayName: z.string().min(1),
  legalName: z.string().min(1),
  homepageUrl: z.url({ protocol: /^https$/ }),
  family: z.enum(["national_authority", "state_local", "research_professional", "independent_commercial"]),
  defaultSectionSlug: z.enum(["public-health", "policy", "research", "medicines-devices", "healthcare-delivery"]).optional(),
  wave: z.union([z.literal(1), z.literal(2)]),
  enabled: z.boolean(),
  adapter: z.enum(["rss", "news_sitemap", "listing", "crossref"]),
  feedUrl: z.url({ protocol: /^https$/ }).optional(),
  hosts: z.array(hostRule).min(1),
  /** `health` keeps only items whose title or URL reads as health news. */
  filter: z.enum(["none", "health"]).default("none"),
  includePaths: z.array(z.string().startsWith("/")).optional(),
  excludePaths: z.array(z.string().startsWith("/")).optional(),
  /** Items older than this are not sent. Defaults to SCRAPER_MAX_AGE_DAYS. */
  maxAgeDays: z.number().int().positive().optional(),
  /** Alert when the newest item is older than this. */
  staleDays: z.number().int().positive().default(7),
  pollMinutes: z.number().int().min(5).optional(),
  /** IANA zone or fixed offset for feed dates that carry no zone, such as America/New_York. */
  dateZone: z.string().optional(),
  /** Item links redirect: send the Location target as resolved_url. */
  resolveRedirects: z.boolean().default(false),
  /**
   * Why a source is off: the publisher's terms need written permission, or its firewall
   * refuses declared bots and it must allowlist IndiaHealthNewsBot. Neither is worked around.
   */
  requires: z.enum(["written_permission", "bot_allowlisting"]).optional(),
  note: z.string().optional(),
});

export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    probedOn: z.string(),
    note: z.string().optional(),
    sources: z.array(source),
    notCarried: z.array(z.strictObject({ name: z.string(), url: z.url(), reason: z.string() })),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.sources.forEach((s, i) => {
      if (seen.has(s.slug)) ctx.addIssue({ code: "custom", path: ["sources", i, "slug"], message: `duplicate slug ${s.slug}` });
      seen.add(s.slug);
      if (!s.enabled) return;
      if (!(IMPLEMENTED_ADAPTERS as readonly string[]).includes(s.adapter)) ctx.addIssue({ code: "custom", path: ["sources", i, "enabled"], message: `adapter ${s.adapter} is not built yet` });
      if (!s.feedUrl) ctx.addIssue({ code: "custom", path: ["sources", i, "feedUrl"], message: "an enabled source needs a feed URL" });
      if (s.requires) ctx.addIssue({ code: "custom", path: ["sources", i, "enabled"], message: `stays off until ${s.requires} is on record` });
    });
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type Source = Manifest["sources"][number];

export function loadManifest(path: string): Manifest {
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid manifest ${path}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/**
 * Enabled sources, optionally narrowed to the given slugs. A disabled source is
 * never fetched, not even in a dry run: some are off because their terms forbid it.
 */
export function pickSources(m: Manifest, only?: string[]): Source[] {
  if (!only?.length) return m.sources.filter((s) => s.enabled);
  const unknown = only.filter((s) => !m.sources.some((x) => x.slug === s));
  if (unknown.length) throw new Error(`Unknown source: ${unknown.join(", ")}`);
  const off = m.sources.filter((s) => only.includes(s.slug) && !s.enabled).map((s) => s.slug);
  if (off.length) throw new Error(`Source is off in the manifest and is not fetched: ${off.join(", ")}`);
  return m.sources.filter((s) => only.includes(s.slug));
}

/**
 * The source register entry for a manifest source, as `npm run scraper-setup -- sources`
 * records it. The register keeps host names; path rules stay in the scraper.
 */
export function registerEntryOf(s: Source) {
  return {
    slug: s.slug,
    legalName: s.legalName,
    displayName: s.displayName,
    homepageUrl: s.homepageUrl,
    family: s.family,
    language: "en",
    hosts: [...new Set(s.hosts.map((h) => h.host))],
    defaultSectionSlug: s.defaultSectionSlug ?? null,
  };
}

export const pollMinutesOf = (s: Source) => s.pollMinutes ?? (s.adapter === "news_sitemap" ? 30 : 15);
