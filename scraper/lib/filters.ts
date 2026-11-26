/** URL clean-up, health relevance and excerpt trimming. */

/** Parameters that only track the click. Platform normalisation strips utm_* and a few others; these go first. */
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|_gl|yclid|ito|cmpid|ncid|at_medium|at_campaign|at_custom\d+|ns_mchannel|ns_source|ns_campaign|ns_linkname|ns_fee|ref_src|rssfeed)$/i;
/** Parameters that are tracking only when their value names the feed, such as src=rss. */
const FEED_TAGGED = /^(src|ref|from|source|cmp|medium|campaign|via|publisher)$/i;
const FEED_VALUE = /rss|feed|newsstand|xml|syndication/i;

/** Absolute https URL without fragment or tracking, or null when it cannot be one. */
export function cleanUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || u.username || u.password) return null;
  u.hash = "";
  const kept = [...u.searchParams].filter(([k, v]) => !TRACKING.test(k) && !(FEED_TAGGED.test(k) && FEED_VALUE.test(v)));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

export function pathAllowed(url: string, include?: string[], exclude?: string[]): boolean {
  const path = new URL(url).pathname;
  const under = (p: string) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path.startsWith(`${p}-`);
  if (exclude?.some(under)) return false;
  return !include?.length || include.some(under);
}

const HEALTH_PATH = /\/(health|healthcare|health-news|health-and-fitness|health-fitness|fitness|wellness|medicine|medical|diseases?|science\/health)(\/|-|$)/i;
/**
 * Words that mark a headline as health news. Tuned on the 26 November dry run of the
 * general feeds: bare "drugs" (narcotics seizures), "outbreak" (of militancy), "pregnant"
 * (crime and celebrity stories), "healthy" and the cricketer Ayush Badoni all let
 * non-health stories through, so each now needs a health context.
 */
const HEALTH_WORDS = new RegExp(
  "\\b(" +
    [
      "health(care)?", "hospitals?", "doctors?", "nurs(e|es|ing)", "medic(al|ine|ines|ation|ations)", "pharma\\w*", "vaccin\\w*",
      "drug (regulator|controller|prices?|pricing|approvals?|trials?|safety|recalls?|resistance|shortages?|samples?)", "(generic|essential|cancer|diabetes|weight-loss) drugs?",
      "virus(es)?", "infections?", "diseases?", "cancers?", "tumou?rs?", "diabet\\w*", "cardiac", "heart (attack|disease|failure|health)",
      "strokes?", "kidneys?", "liver", "lungs?", "mental health", "depression", "anxiety", "obesity", "nutrition\\w*", "malnutrition", "anaemi\\w*", "anemi\\w*",
      "pregnancy", "pregnancies", "maternal", "neonatal", "newborn (care|health|deaths?|screening)", "infant mortality", "tuberculosis", "malaria", "dengue",
      "chikungunya", "nipah", "covid\\w*", "coronavirus", "influenza", "flu", "measles", "polio", "mpox", "cholera", "epidemic\\w*", "pandemic\\w*",
      "surg(ery|eries|eon|eons|ical)", "patients?", "clinics?", "clinical", "(gene|cell|radiation|hormone|cancer) therap(y|ies)", "chemotherapy", "immunotherapy",
      "physiotherapy", "treatments?", "diagnos\\w+", "antibiotic\\w*", "antimicrobial", "superbugs?", "ayushman", "ministry of ayush", "sanitation",
      "organ donation", "transplants?", "blood (pressure|sugar|bank|test)", "cholesterol", "dementia", "alzheimer\\w*", "autism", "air pollution",
    ].join("|") +
    ")\\b",
  "i",
);
/** Case-sensitive, so "who" the word is not WHO the agency. */
const HEALTH_ACRONYMS = /\b(WHO|ICMR|AIIMS|NMC|CDSCO|FSSAI|AYUSH|NEET-PG|MBBS|TB|HIV|AIDS|ICU|OPD|PMJAY|PM-JAY|ABDM|NHA|NHM|CGHS|ESIC|IMA|AMR)\b/;
/** "Health" in a sense that is not about people's health. */
const OTHER_HEALTH = /\b(fiscal|financial|economic|economy'?s|business|market|credit|soil|portfolio|corporate|balance[- ]sheet|banks?'?|banking) health\b/gi;

export function isHealthRelated(title: string, url: string): boolean {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    /* title alone decides */
  }
  const t = title.replace(OTHER_HEALTH, " ");
  return HEALTH_PATH.test(path) || HEALTH_WORDS.test(t) || HEALTH_ACRONYMS.test(t);
}

/** The feed teaser as a short plain-text excerpt, or undefined when it adds nothing to the title. */
export function excerptOf(summary: string | undefined, title: string, max = 300): string | undefined {
  if (!summary) return undefined;
  const s = summary
    .replace(/\s*The post .{1,400}? appeared first on .{1,160}$/i, "")
    .replace(/\s*(\[(…|\.\.\.)\]|Continue reading.*|Read more.*|Read full story.*)$/i, "")
    .trim();
  if (!s || s.toLowerCase() === title.toLowerCase()) return undefined;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** A display name from an RSS author field. Bare e-mail addresses are dropped. */
export function authorOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const named = /\(([^)]+)\)\s*$/.exec(raw)?.[1];
  const name = (raw.includes("@") ? named : raw)?.trim();
  return name ? name.slice(0, 300) : undefined;
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}
