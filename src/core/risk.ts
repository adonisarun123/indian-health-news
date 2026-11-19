/**
 * Medical-risk routing (ED-01, PUB-01).
 *
 * This is a deliberately conservative keyword screen, not a classifier. Its
 * only job is to stop automatic publication. A false positive costs an editor
 * a click; a false negative puts an unreviewed clinical claim in public. Any
 * flag blocks automation on every format, including source cards.
 */

export type RiskRoute = "routine" | "clinical" | "sensitive";

interface Rule {
  flag: string;
  route: Exclude<RiskRoute, "routine">;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { flag: "drug_safety", route: "clinical", pattern: /\b(drug|medicine|medication|batch|lot)\b.*\b(alert|recall|recalled|spurious|substandard|adulterated|not of standard quality|nsq|ban|banned|withdraw\w*|adverse)\b|\b(recall|spurious|substandard|nsq|adverse (event|reaction)s?|side[- ]effects?|contraindicat\w+|pharmacovigilance)\b/i },
  { flag: "treatment_claim", route: "clinical", pattern: /\b(cure[sd]?|treats?|treatment|therapy|dosage|dose|efficacy|effective against|prevents?|remedy)\b/i },
  { flag: "outbreak_figures", route: "clinical", pattern: /\b(outbreak|epidemic|pandemic|cluster of cases|cases? (rise|rose|reported|confirmed|detected)|deaths?|died|fatalit\w+|mortality|positivity)\b/i },
  { flag: "vaccine_guidance", route: "clinical", pattern: /\b(vaccin\w+|immuni[sz]ation|booster|jab)\b/i },
  { flag: "screening_advice", route: "clinical", pattern: /\b(screening|should (get )?test(ed)?|advisory|health advisory|guidelines? for (patients|public|treatment))\b/i },
  { flag: "research_result", route: "clinical", pattern: /\b(study|trial|preprint|researchers? (find|found|show)|findings|meta-analysis|cohort|randomi[sz]ed)\b/i },
  { flag: "named_disease", route: "clinical", pattern: /\b(nipah|dengue|malaria|cholera|tuberculosis|\btb\b|covid|coronavirus|h5n1|h1n1|influenza|measles|polio|mpox|zika|chikungunya|encephalitis|rabies|hiv|cancer|diabetes)\b/i },
  { flag: "allegation", route: "sensitive", pattern: /\b(alleg\w+|negligence|malpractice|scam|fraud|arrest\w*|fir\b|probe|lawsuit|sued|accus\w+)\b/i },
  { flag: "identifiable_patient", route: "sensitive", pattern: /\b(patient|victim|minor|child|woman|man),? (aged |age )?\d{1,3}\b|\b\d{1,3}[- ]year[- ]old\b/i },
  { flag: "embargo", route: "sensitive", pattern: /\bembargo\w*\b/i },
  { flag: "disputed_count", route: "sensitive", pattern: /\b(disput\w+|contradict\w+|denies|denied|under-?report\w+|toll)\b/i },
];

export interface RiskAssessment {
  route: RiskRoute;
  flags: string[];
}

export function assessRisk(text: string, sourceDefault: RiskRoute = "routine"): RiskAssessment {
  const flags: string[] = [];
  let route: RiskRoute = sourceDefault;
  if (sourceDefault !== "routine") flags.push(`source_default_${sourceDefault}`);
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      flags.push(rule.flag);
      if (rule.route === "sensitive") route = "sensitive";
      else if (route === "routine") route = "clinical";
    }
  }
  return { route, flags };
}

/** Coarse script detection, used to catch a materially mismatched language (ING-01). */
export function detectScript(text: string): string {
  const counts: Record<string, number> = {};
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    let s: string | undefined;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) s = "latin";
    else if (cp >= 0x0900 && cp <= 0x097f) s = "devanagari";
    else if (cp >= 0x0980 && cp <= 0x09ff) s = "bengali";
    else if (cp >= 0x0a00 && cp <= 0x0a7f) s = "gurmukhi";
    else if (cp >= 0x0a80 && cp <= 0x0aff) s = "gujarati";
    else if (cp >= 0x0b00 && cp <= 0x0b7f) s = "odia";
    else if (cp >= 0x0b80 && cp <= 0x0bff) s = "tamil";
    else if (cp >= 0x0c00 && cp <= 0x0c7f) s = "telugu";
    else if (cp >= 0x0c80 && cp <= 0x0cff) s = "kannada";
    else if (cp >= 0x0d00 && cp <= 0x0d7f) s = "malayalam";
    else if (cp >= 0x0600 && cp <= 0x06ff) s = "arabic";
    if (s) counts[s] = (counts[s] ?? 0) + 1;
  }
  let best = "unknown";
  let max = 0;
  for (const [s, n] of Object.entries(counts)) if (n > max) [best, max] = [s, n];
  return best;
}

const LANGUAGE_SCRIPT: Record<string, string> = {
  en: "latin",
  hi: "devanagari",
  mr: "devanagari",
  bn: "bengali",
  pa: "gurmukhi",
  gu: "gujarati",
  or: "odia",
  ta: "tamil",
  te: "telugu",
  kn: "kannada",
  ml: "malayalam",
  ur: "arabic",
};

export function languageMismatch(declared: string, text: string): boolean {
  const expected = LANGUAGE_SCRIPT[declared.toLowerCase().split("-")[0] ?? ""];
  const actual = detectScript(text);
  return Boolean(expected) && actual !== "unknown" && actual !== expected;
}

/** Normalized title fingerprint for alias matching and cluster suggestions. */
export function titleTokens(title: string): string[] {
  const stop = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "by", "at", "from", "with", "is", "are"]);
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stop.has(t));
}

export function titleFingerprint(title: string): string {
  return [...new Set(titleTokens(title))].sort().join(" ");
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
