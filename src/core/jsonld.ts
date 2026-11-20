/**
 * JSON-LD graphs built from the published record (SD-01..SD-04).
 *
 * One graph per page, stable absolute @ids, nodes linked by @id, one logical
 * primary entity. Every value comes from the same data the visible page
 * renders, so the markup cannot drift from what a reader sees.
 */
export type Node = Record<string, unknown> & { "@type": string | string[]; "@id"?: string };

export interface Graph {
  "@context": "https://schema.org";
  "@graph": Node[];
}

export interface SiteIdentity {
  origin: string;
  name: string;
  legalName?: string;
}

const ref = (id: string) => ({ "@id": id });
const abs = (origin: string, path: string) => (path.startsWith("http") ? path : `${origin}${path}`);

/** ISO 8601 in IST with an explicit offset (SD-02). */
export function istIso(d: Date): string {
  return `${new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 19)}+05:30`;
}

export function orgNode(site: SiteIdentity): Node {
  return {
    "@type": "NewsMediaOrganization",
    "@id": `${site.origin}/#org`,
    name: site.name,
    ...(site.legalName ? { legalName: site.legalName } : {}),
    url: `${site.origin}/`,
    logo: { "@type": "ImageObject", url: `${site.origin}/logo.svg` },
    publishingPrinciples: `${site.origin}/editorial-policy`,
    correctionsPolicy: `${site.origin}/corrections`,
  };
}

export function breadcrumb(origin: string, trail: { name: string; path?: string }[]): Node {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, ...(t.path ? { item: abs(origin, t.path) } : {}) })),
  };
}

export function homeGraph(site: SiteIdentity): Graph {
  return {
    "@context": "https://schema.org",
    "@graph": [orgNode(site), { "@type": "WebSite", "@id": `${site.origin}/#website`, name: site.name, url: `${site.origin}/`, inLanguage: "en-IN", publisher: ref(`${site.origin}/#org`) }],
  };
}

export interface ArticleLd {
  slug: string;
  type: string;
  headline: string;
  section: { name: string; slug: string } | null;
  author: { name: string; slug: string; hasProfile: boolean } | null;
  publishedAt: Date;
  /** Set only by a genuine published correction. */
  modifiedAt: Date | null;
  citations: string[];
  reviewer: { name: string; slug: string; hasProfile: boolean } | null;
  /** A licensed copy or a verbatim official release: not our NewsArticle. */
  reproduced?: boolean;
}

/**
 * Original report: NewsArticle + WebPage + BreadcrumbList + author. A licensed
 * copy gets page semantics only: it never claims to be our NewsArticle.
 */
export function articleGraph(site: SiteIdentity, a: ArticleLd): Graph {
  const url = `${site.origin}/news/${a.slug}`;
  const pageId = `${url}#page`;
  const storyId = `${url}#story`;
  const org = orgNode(site);
  const nodes: Node[] = [org];
  const trail = [{ name: "Home", path: "/" }, ...(a.section ? [{ name: a.section.name, path: `/section/${a.section.slug}` }] : []), { name: a.headline }];
  const personNode = (p: { name: string; slug: string; hasProfile: boolean }): Node => ({ "@type": "Person", "@id": `${site.origin}/authors/${p.slug}#person`, name: p.name, ...(p.hasProfile ? { url: `${site.origin}/authors/${p.slug}` } : {}) });

  const page: Node = { "@type": "WebPage", "@id": pageId, url, inLanguage: "en-IN", isPartOf: ref(`${site.origin}/#website`), breadcrumb: breadcrumb(site.origin, trail) };
  if (a.reviewer) {
    nodes.push(personNode(a.reviewer));
    // reviewedBy belongs on the page, and only when the review is visible and recorded (SD table).
    page.reviewedBy = ref(`${site.origin}/authors/${a.reviewer.slug}#person`);
  }
  if (a.type === "licensed_copy" || a.reproduced) {
    nodes.push({ "@type": "WebSite", "@id": `${site.origin}/#website`, name: site.name, url: `${site.origin}/` }, page);
    return { "@context": "https://schema.org", "@graph": nodes };
  }

  let authorRef = ref(`${site.origin}/#org`);
  if (a.author) {
    if (!a.reviewer || a.reviewer.slug !== a.author.slug) nodes.push(personNode(a.author));
    authorRef = ref(`${site.origin}/authors/${a.author.slug}#person`);
  }
  page.mainEntity = ref(storyId);
  nodes.push({ "@type": "WebSite", "@id": `${site.origin}/#website`, name: site.name, url: `${site.origin}/` }, page, {
    "@type": "NewsArticle",
    "@id": storyId,
    url,
    headline: a.headline,
    mainEntityOfPage: ref(pageId),
    author: authorRef,
    publisher: ref(`${site.origin}/#org`),
    datePublished: istIso(a.publishedAt),
    ...(a.modifiedAt ? { dateModified: istIso(a.modifiedAt) } : {}),
    ...(a.section ? { articleSection: a.section.name } : {}),
    inLanguage: "en-IN",
    ...(a.citations.length ? { citation: a.citations } : {}),
  });
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** Section, state or topic hub. Listed cards do not make the hub a news article. */
export function hubGraph(site: SiteIdentity, hub: { name: string; path: string; kindLabel: string; items: { name: string; url: string }[] }): Graph {
  const url = `${site.origin}${hub.path}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      orgNode(site),
      {
        "@type": "CollectionPage",
        "@id": `${url}#page`,
        url,
        name: hub.name,
        inLanguage: "en-IN",
        publisher: ref(`${site.origin}/#org`),
        breadcrumb: breadcrumb(site.origin, [{ name: "Home", path: "/" }, { name: hub.name }]),
        mainEntity: { "@type": "ItemList", itemListElement: hub.items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, url: abs(site.origin, it.url) })) },
      },
    ],
  };
}

export function profileGraph(site: SiteIdentity, p: { name: string; slug: string; bio: string | null; jobTitle: string | null; credentials: string | null }): Graph {
  const url = `${site.origin}/authors/${p.slug}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      orgNode(site),
      { "@type": "ProfilePage", "@id": `${url}#page`, url, mainEntity: ref(`${url}#person`) },
      { "@type": "Person", "@id": `${url}#person`, name: p.name, url, ...(p.bio ? { description: p.bio } : {}), ...(p.jobTitle ? { jobTitle: p.jobTitle } : {}), ...(p.credentials ? { hasCredential: p.credentials } : {}), worksFor: ref(`${site.origin}/#org`) },
    ],
  };
}

export function simplePageGraph(site: SiteIdentity, page: { type: "AboutPage" | "ContactPage" | "WebPage"; name: string; path: string }): Graph {
  const url = `${site.origin}${page.path}`;
  return { "@context": "https://schema.org", "@graph": [orgNode(site), { "@type": page.type, "@id": `${url}#page`, url, name: page.name, inLanguage: "en-IN", about: ref(`${site.origin}/#org`), publisher: ref(`${site.origin}/#org`) }] };
}

/**
 * Serialize for an HTML script element (SD-04). Escaping "<" stops any string
 * value from closing the script element or opening a comment.
 */
export function serializeJsonLd(graph: Graph): string {
  const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");
  return JSON.stringify(graph)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATORS, (c) => (c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"));
}

/** Structural checks run in tests and CI: references resolve, URLs are absolute, one primary entity. */
export function validateGraph(graph: Graph): string[] {
  const problems: string[] = [];
  const ids = new Set(graph["@graph"].map((n) => n["@id"]).filter(Boolean));
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === "@id" && !ids.has(o["@id"] as string)) problems.push(`${path}: unresolved reference ${String(o["@id"])}`);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      return;
    }
    const key = path.split(".").pop() ?? "";
    if (typeof value === "string" && (key === "url" || key === "item" || key === "@id" || /^citation\[\d+\]$/.test(key)) && !/^https?:\/\//.test(value)) problems.push(`${path}: not an absolute URL (${value})`);
  };
  walk(graph["@graph"], "@graph");
  const primaries = graph["@graph"].filter((n) => "mainEntity" in n);
  if (primaries.length > 1) problems.push("more than one node declares a main entity");
  const seen = new Set<string>();
  for (const n of graph["@graph"]) {
    if (!n["@id"]) continue;
    if (seen.has(n["@id"])) problems.push(`duplicate node ${n["@id"]}`);
    seen.add(n["@id"]);
  }
  return problems;
}
