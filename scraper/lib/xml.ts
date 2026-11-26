/**
 * Just enough XML for RSS, Atom, RDF and Google News sitemaps. Publishers ship
 * malformed XML often enough that a strict parser would drop whole feeds, so
 * this reads element by element and tolerates the rest. CDATA is set aside
 * before anything else, so markup inside it is never read as feed structure.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  deg: "°", euro: "€", pound: "£", times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", micro: "µ",
  shy: "", zwnj: "", zwj: "", eacute: "é", egrave: "è", aacute: "á", agrave: "à", oacute: "ó", iacute: "í", uacute: "ú",
  uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", ntilde: "ñ", szlig: "ß",
};
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;
const HAS_ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/i;
const CDATA_MARK = /\u0000(\d+)\u0000/g;

export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export interface Doc {
  /** The document with comments removed and each CDATA section replaced by a marker. */
  body: string;
  cdata: string[];
}

export function load(xml: string): Doc {
  const cdata: string[] = [];
  const body = xml
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => `\u0000${cdata.push(c) - 1}\u0000`)
    .replace(/<!--[\s\S]*?-->/g, "");
  return { body, cdata };
}

export interface Element {
  attrs: Record<string, string>;
  /** Raw inner markup, CDATA still as markers. Empty for a self-closing element. */
  inner: string;
}

function parseAttrs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (s ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

/** Every <tag>…</tag> or <tag/> in `src`, in order. `tag` may carry a prefix, such as news:title. */
export function elements(src: string, tag: string): Element[] {
  const t = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${t}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${t}\\s*>)`, "gi");
  return [...src.matchAll(re)].map((m) => ({ attrs: parseAttrs(m[1]), inner: m[2] ?? "" }));
}

/** Plain text of raw inner markup: CDATA restored, entities decoded, tags removed, whitespace collapsed. */
export function text(doc: Doc, raw: string | undefined): string {
  if (!raw) return "";
  let s = raw.replace(CDATA_MARK, (_m, i: string) => doc.cdata[Number(i)] ?? "");
  s = decodeEntities(s);
  s = s
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "");
  // Some feeds encode twice (&amp;#8217;). One more pass settles them.
  if (HAS_ENTITY.test(s)) s = decodeEntities(s);
  return s.replace(/[\s\u00a0\u200b\u2028\u2029]+/g, " ").trim();
}

/** Text of the first child element among `tags` that has any. */
export function firstText(doc: Doc, src: string, tags: string[]): string {
  for (const tag of tags) {
    for (const el of elements(src, tag)) {
      const t = text(doc, el.inner);
      if (t) return t;
    }
  }
  return "";
}
