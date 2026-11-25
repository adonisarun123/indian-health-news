/**
 * Republish Press Information Bureau releases word for word (see docs/DECISIONS.md,
 * "Verbatim PIB health releases").
 *
 *   npm run pib -- fetch --ministry 31 --months 2026-01..2026-06 --out scripts/pib/health-2026-h1.json
 *   npm run pib -- fetch --ministry 31 --months 2026-11 --after-prid 2338316 --out scripts/pib/health-new.json
 *   npm run pib -- fetch --ministry 31 --prids 2237403,2237404 --out scripts/pib/extra.json
 *   npm run pib -- daily --as you@example.com --override-risk     (everything new this month, every ministry we carry)
 *   npm run pib -- publish scripts/pib/health-new.json --as you@example.com [--override-risk]
 *
 * `fetch` reads PIB's English listing for one ministry (31 Health and Family Welfare,
 * 80 Ayush, 41 Chemicals and Fertilizers, Department of Pharmaceuticals releases only), downloads each release, converts it to our blocks and writes a file an
 * editor can read before anything is published. Releases already on the site are left out.
 *
 * `publish` puts each prepared release through the same commands the newsroom uses:
 * create, (reclassify), submit, approve, publish. Without --override-risk a release the
 * risk screen holds stays a draft. With it, the managing editor named by --as reclassifies
 * it as routine with a recorded reason, which skips medical review: a publisher decision.
 *
 * Run it from a machine that can reach pib.gov.in. It makes about one request a second.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { articles, people } from "../src/db/schema";
import { type Block, CommandError, createArticle, loadActor, performAction, slugify } from "../src/core/articles";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LISTING = "https://www.pib.gov.in/allRel.aspx?reg=3&lang=1";
const canonicalOf = (prid: string) => `https://pib.gov.in/PressReleasePage.aspx?PRID=${prid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Office housekeeping and previews, left out by decision. */
const LEAVE_OUT = /special campaign|swachh|\bpledge\b|vigilance awareness|rashtriya ekta|run for unity|hindi pakhwada|hindi diwas|hindi advisory|rajbhasha|finance committee|curtain raiser|photo release|media advisory|media invit/i;
/** Announcements of an event that its own release covers afterwards. */
const PREVIEW = /\b(set to (become|launch)|to (launch|release|inaugurate|preside|convene|observe|host|begin|organi[sz]e|unveil|be celebrated|be observed)\b)/i;
const leftOut = (title: string) => LEAVE_OUT.test(title) || (PREVIEW.test(title) && !/^(steps|measures) taken\b/i.test(title) && !/\b(launches|launched|inaugurates|inaugurated|releases|released|concludes|held)\b/i.test(title));
const ISSUERS: Record<string, string> = { "31": "Ministry of Health and Family Welfare", "80": "Ministry of Ayush", "41": "Department of Pharmaceuticals" };
/** Ministry 41 is Chemicals and Fertilizers; only releases its Department of Pharmaceuticals issues are carried. */

/* ───────────── text ───────────── */

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", deg: "°", times: "×", frac12: "½", frac14: "¼", frac34: "¾", copy: "©", reg: "®", trade: "™", shy: "", zwnj: "", zwj: "", eacute: "é", pound: "£", euro: "€", micro: "µ", plusmn: "±", le: "≤", ge: "≥", rarr: "→" };
export function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const clean = (s: string) => s.replace(/[ ​-‍﻿­]/g, " ").replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
const strip = (html: string) => clean(decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))).replace(/\n+/g, "\n");

type Raw = { kind: "p"; text: string; bold: boolean } | { kind: "li"; text: string; ordered: boolean } | { kind: "row"; text: string };

/** PIB release markup to plain pieces. No markup survives (SEC-01). */
function pieces(html: string): Raw[] {
  const out: Raw[] = [];
  let buf = "";
  let total = 0;
  let bold = 0;
  let boldDepth = 0;
  let headingDepth = 0;
  let inLi = 0;
  let cells: string[] | null = null;
  let skip: string | null = null;
  let skipDepth = 0;
  const lists: boolean[] = [];
  const reset = () => { buf = ""; total = 0; bold = 0; };
  const flush = () => {
    if (cells || inLi) { buf += " "; return; }
    const text = clean(buf);
    const isBold = headingDepth > 0 || (total > 0 && bold / total > 0.9);
    reset();
    for (const line of text.split(/\n+/)) if (line.trim()) out.push({ kind: "p", text: line.trim(), bold: isBold });
  };
  const flushLi = () => {
    const text = clean(buf).replace(/\n+/g, " ");
    reset();
    if (text) out.push({ kind: "li", text, ordered: lists[lists.length - 1] ?? false });
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)|</g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [, close, rawTag, attrs, text] = m;
    if (text !== undefined) {
      if (skip) continue;
      const t = decode(text);
      const n = t.replace(/\s/g, "").length;
      total += n;
      if (boldDepth > 0) bold += n;
      buf += t.replace(/\n/g, " ");
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (skip) {
      if (tag === skip) skipDepth += close ? -1 : 1;
      if (skipDepth === 0) skip = null;
      continue;
    }
    if (!close && (["script", "style", "noscript", "iframe", "svg", "button", "figcaption"].includes(tag) || (tag === "blockquote" && /twitter|instagram|facebook/i.test(attrs ?? "")))) {
      if (!/\/\s*$/.test(attrs ?? "")) { skip = tag; skipDepth = 1; }
      continue;
    }
    switch (tag) {
      case "b": case "strong": boldDepth = Math.max(0, boldDepth + (close ? -1 : 1)); break;
      case "br": buf += "\n"; break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        flush(); headingDepth = Math.max(0, headingDepth + (close ? -1 : 1)); break;
      case "ul": case "ol":
        if (inLi) flushLi(); else flush();
        if (close) lists.pop(); else lists.push(tag === "ol");
        break;
      case "li":
        if (close) { flushLi(); inLi = Math.max(0, inLi - 1); }
        else { if (inLi) flushLi(); else flush(); inLi++; }
        break;
      case "table": if (!close) flush(); else { cells = null; reset(); } break;
      case "tr":
        if (close) { if (cells) { const row = cells.filter(Boolean).join(" – "); if (row) out.push({ kind: "row", text: row }); } cells = null; reset(); }
        else { flush(); cells = []; reset(); }
        break;
      case "td": case "th":
        if (close && cells) { cells.push(clean(buf).replace(/\n+/g, " ")); reset(); }
        break;
      case "p": case "div": case "section": case "article": case "blockquote": case "center": case "hr":
        flush(); break;
    }
  }
  inLi = 0; cells = null;
  flush();
  return out;
}

const splitLong = (text: string, max: number): string[] => (text.length <= max ? [text] : (text.match(new RegExp(`[\\s\\S]{1,${max}}(?:\\s|$)`, "g")) ?? [text]).map((s) => s.trim()).filter(Boolean));
const MARK = /^[\s*#_\-–—.·•]{3,}$/;
const SIGNOFF = /^(\(?release id|[A-Z]{2,5}(\s*[\/|,&-]\s*[A-Z]{2,5})*\.?$|[A-Za-z]{2,6}\/.+\/\d|.*\bHFW\s*[\/-])/;

export function htmlToBlocks(html: string): Block[] {
  let raw = pieces(html);
  // Staff sign-off: everything after the last row of asterisks, when little follows it.
  let last = -1;
  raw.forEach((r, i) => { if (r.kind === "p" && MARK.test(r.text)) last = i; });
  if (last >= 0 && raw.slice(last + 1).reduce((n, r) => n + r.text.length, 0) < 500) raw = raw.slice(0, last);
  raw = raw.filter((r) => !(r.kind === "p" && MARK.test(r.text)));
  while (raw.length && raw[raw.length - 1]!.kind === "p" && raw[raw.length - 1]!.text.length < 160 && SIGNOFF.test(raw[raw.length - 1]!.text)) raw.pop();

  const blocks: Block[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const endList = () => { if (list) for (let i = 0; i < list.items.length; i += 50) blocks.push({ type: "list", ordered: list.ordered, items: list.items.slice(i, i + 50) }); list = null; };
  for (const r of raw) {
    if (r.kind === "p") {
      endList();
      if (r.bold && r.text.length <= 120 && !/[.;,]$/.test(r.text)) blocks.push({ type: "heading", text: r.text });
      else for (const t of splitLong(r.text, 4800)) blocks.push({ type: "paragraph", text: t });
      continue;
    }
    const ordered = r.kind === "li" ? r.ordered : false;
    if (r.text.length > 1000) { endList(); for (const t of splitLong(r.text, 4800)) blocks.push({ type: "paragraph", text: t }); continue; }
    if (!list || list.ordered !== ordered) { endList(); list = { ordered, items: [] }; }
    list.items.push(r.text);
  }
  endList();
  return blocks;
}

/* ───────────── PIB pages ───────────── */

async function get(url: string, init: RequestInit = {}, tries = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(45_000) });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(4000 * i);
    }
  }
}

const hidden = (html: string) => {
  const f = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    if (name) f.set(name, decode(/value="([^"]*)"/.exec(m[0])?.[1] ?? ""));
  }
  return f;
};

/** PRIDs and titles for one ministry and month, from the English listing. */
async function listMonth(ministry: string, year: number, month: number): Promise<{ prid: string; title: string }[]> {
  const first = await get(LISTING);
  const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const form = hidden(await first.text());
  form.set("ctl00$Bar1$ddlregion", "3");
  form.set("ctl00$Bar1$ddlLang", "1");
  form.set("ctl00$ContentPlaceHolder1$ddlMinistry", ministry);
  form.set("ctl00$ContentPlaceHolder1$ddlday", "0");
  form.set("ctl00$ContentPlaceHolder1$ddlMonth", String(month));
  form.set("ctl00$ContentPlaceHolder1$ddlYear", String(year));
  form.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$ddlMinistry");
  form.set("__EVENTARGUMENT", "");
  const res = await get(LISTING, { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Referer: LISTING } });
  const html = await res.text();
  const sel = (id: string) => new RegExp(`id="ContentPlaceHolder1_${id}"[\\s\\S]*?<option selected="selected" value="([^"]*)"`).exec(html)?.[1];
  if (sel("ddlMinistry") !== ministry || sel("ddlMonth") !== String(month) || sel("ddlYear") !== String(year) || sel("ddlday") !== "0")
    throw new Error(`PIB listing did not apply the filter for ${ministry} ${year}-${month} (got ${sel("ddlMinistry")}, ${sel("ddlday")}, ${sel("ddlMonth")}, ${sel("ddlYear")}).`);
  const area = html.slice(html.indexOf('class="content-area"'));
  const seen = new Map<string, string>();
  for (const m of area.matchAll(/<a[^>]*href=['"][^'"]*PRID=(\d+)[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi)) if (!seen.has(m[1]!)) seen.set(m[1]!, strip(m[2]!));
  return [...seen].map(([prid, title]) => ({ prid, title }));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Release { title: string; ministry: string; issuedAt: string; day: number; month: number; year: number; subtitles: string[]; bodyHtml: string }

async function fetchRelease(prid: string): Promise<Release> {
  const res = await get(`https://www.pib.gov.in/PressReleasePage.aspx?PRID=${prid}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const ministry = strip(/<div id="MinistryName"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "");
  const title = strip(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "").replace(/\n/g, " ");
  const posted = /Posted On:\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(html);
  const start = html.indexOf('<div id="pibReleaseBody">');
  const end = html.indexOf('<div id="reel_pic">', start);
  if (!title || !posted || start < 0 || end < 0) throw new Error("unexpected page layout");
  const [, d, mon, y, h, min, ap] = posted;
  const month = MONTHS.indexOf(mon!.toLowerCase());
  if (month < 0) throw new Error(`unknown month ${mon}`);
  const hour = (Number(h) % 12) + (ap!.toUpperCase() === "PM" ? 12 : 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const issuedAt = `${y}-${pad(month + 1)}-${pad(Number(d))}T${pad(hour)}:${min}:00+05:30`;
  const subtitles = strip(/<span id="ltrSubtitle">([\s\S]*?)<\/span>\s*<\/h3>/.exec(html)?.[1] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return { title, ministry, issuedAt, day: Number(d), month, year: Number(y), subtitles, bodyHtml: html.slice(start + 25, end) };
}

/* ───────────── classification ───────────── */

const STATES: [RegExp, string][] = [
  ["Andhra Pradesh", "andhra-pradesh"], ["Arunachal Pradesh", "arunachal-pradesh"], ["Assam", "assam"], ["Bihar", "bihar"], ["Chhattisgarh", "chhattisgarh"], ["Goa", "goa"], ["Gujarat", "gujarat"], ["Haryana", "haryana"], ["Himachal Pradesh", "himachal-pradesh"], ["Jharkhand", "jharkhand"], ["Karnataka", "karnataka"], ["Kerala", "kerala"], ["Madhya Pradesh", "madhya-pradesh"], ["Maharashtra", "maharashtra"], ["Manipur", "manipur"], ["Meghalaya", "meghalaya"], ["Mizoram", "mizoram"], ["Nagaland", "nagaland"], ["Odisha", "odisha"], ["Punjab", "punjab"], ["Rajasthan", "rajasthan"], ["Sikkim", "sikkim"], ["Tamil Nadu", "tamil-nadu"], ["Telangana", "telangana"], ["Tripura", "tripura"], ["Uttar Pradesh", "uttar-pradesh"], ["Uttarakhand", "uttarakhand"], ["West Bengal", "west-bengal"], ["Jammu (and|&) Kashmir", "jammu-and-kashmir"], ["Ladakh", "ladakh"], ["Puducherry", "puducherry"], ["Chandigarh", "chandigarh"], ["New Delhi|Delhi", "delhi"],
].map(([p, s]) => [new RegExp(`\\b(${p})\\b`, "i"), s as string]);

/** A first guess from the headline. An editor can move a story to another section. */
export function sectionFor(title: string): string {
  const t = title.replace(/(traditional|modern|systems? of|personalized|ayush|unani|ayurvedic?|indian) medicines?/gi, "");
  if (/substance addiction|adulterat|food safety/i.test(t)) return "public-health";
  if (/\b(drugs?|pharma\w*|medicines?|medical devices?|cdsco|nppa|jan aushadhi|pharmacopoeia|ipc|formulations?|antibiotic\w*|antimicrobial|medicinal plants?|herb\w*|ashwagandha|drug testing|quality mark|ayush products|ndct|glp-1|pregabalin|amrit pharmac\w+)\b/i.test(t)) return "medicines-devices";
  if (/\b(icmr|ccras|ccrh|ccryn|research|study|studies|trials?|scientific|scientists?|genom\w+|journal|manuscripts?|patent\w*|dhr)\b/i.test(t)) return "research";
  if (/\b(hospitals?|aiims|medical (colleges?|education)|ayushman|pm-?jay|pmjay|abha|abdm|nha|national health authority|health facilit\w+|doctors?|nurs\w+|mbbs|seats|telemedicine|esanjeevani|convocation|institutes?|infrastructure|arogya mandir|aams|workforce|ambulance|blood|organ|transplant\w*|insurance|cghs|tele-?manas|phcs?|chcs?|dispensar\w+|opd|nbems|aiia|itra|colleges?)\b/i.test(t)) return "healthcare-delivery";
  if (/\b(bill|act|rules|amendments?|cabinet|policy|mous?|notif\w+|regulat\w+|commission|budget|bilateral|brics|bimstec|g20|guidelines|jan vishwas|who)\b/i.test(t)) return "policy";
  return "public-health";
}

/* ───────────── commands ───────────── */

interface Prepared { prid: string; riskHint?: string; brief: Record<string, unknown> & { headline: string; canonicalUrl: string } }

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function existing(): Promise<Map<string, string>> {
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");
  const { db, pool } = createDb(url, 1);
  try {
    const rows = await db.select({ u: articles.canonicalUrl, s: articles.status }).from(articles).where(isNotNull(articles.canonicalUrl));
    return new Map(rows.map((r) => [r.u!, r.s]));
  } finally {
    await pool.end();
  }
}

async function runFetch() {
  const ministry = opt("--ministry");
  const months = opt("--months");
  const out = opt("--out");
  const after = Number(opt("--after-prid") ?? 0);
  const prids = opt("--prids")?.split(",").map((p) => p.trim()).filter((p) => /^\d+$/.test(p));
  if (!ministry || !(months || prids?.length) || !out || !ISSUERS[ministry]) throw new Error("Usage: fetch --ministry <31|80|41> (--months YYYY-MM[..YYYY-MM] | --prids N,N) --out <file.json> [--after-prid N] [--with-subheads]");
  const [from, to = from] = (months ?? "0-0").split("..");
  const [fy, fm] = from!.split("-").map(Number) as [number, number];
  const [ty, tm] = to!.split("-").map(Number) as [number, number];
  const have = await existing();
  const listed: { prid: string; title: string }[] = (prids ?? []).map((prid) => ({ prid, title: "" }));
  for (let y = fy, m = fm; !prids && (y < ty || (y === ty && m <= tm)); m === 12 ? (y++, (m = 1)) : m++) {
    const rows = await listMonth(ministry, y, m);
    console.log(`listing ${y}-${String(m).padStart(2, "0")}: ${rows.length}`);
    listed.push(...rows);
    await sleep(1200);
  }
  const items: Prepared[] = [];
  const skipped: { prid: string; title: string; reason: string }[] = [];
  const titles = new Set<string>();
  for (const { prid, title: listTitle } of [...new Map(listed.map((l) => [l.prid, l])).values()].sort((a, b) => Number(a.prid) - Number(b.prid))) {
    const skip = (reason: string, title = listTitle) => { skipped.push({ prid, title, reason }); console.log(`skip  ${prid} ${reason}: ${title.slice(0, 80)}`); };
    if (Number(prid) <= after) continue;
    if (have.has(canonicalOf(prid))) { skip("already on the site"); continue; }
    if (leftOut(listTitle)) { skip("housekeeping or preview"); continue; }
    try {
      const r = await fetchRelease(prid);
      await sleep(900);
      const wanted = ISSUERS[ministry]!;
      if (!(r.ministry === wanted || (ministry === "80" && /ayush/i.test(r.ministry)) || (ministry === "41" && /department of pharmaceuticals/i.test(r.ministry)))) { skip(`issued by ${r.ministry || "an unnamed body"}`, r.title); continue; }
      if (leftOut(r.title)) { skip("housekeeping or preview", r.title); continue; }
      const key = `${r.issuedAt.slice(0, 10)} ${r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      if (titles.has(key)) { skip("same title issued the same day", r.title); continue; }
      let body = htmlToBlocks(r.bodyHtml);
      if (args.includes("--with-subheads") && r.subtitles.length) body = [{ type: "list", ordered: false, items: r.subtitles.map((s) => s.slice(0, 1000)).slice(0, 50) }, ...body];
      const chars = body.reduce((n, b) => n + (b.type === "list" ? b.items.join(" ").length : b.text.length), 0);
      if (chars < 400) { skip(`too little text (${chars} characters; likely photos or a table image)`, r.title); continue; }
      if (body.length > 400) { skip(`too long (${body.length} blocks)`, r.title); continue; }
      if (/[ऀ-ॿ]{20,}/.test(body.map((b) => (b.type === "list" ? b.items.join(" ") : b.text)).join(" ").slice(0, 1500))) { skip("not in English", r.title); continue; }
      titles.add(key);
      const headline = r.title.length <= 200 ? r.title : `${r.title.slice(0, 199).replace(/\s+\S*$/, "")}…`;
      const dateLong = `${r.day} ${LONG[r.month]} ${r.year}`;
      const dateShort = `${r.day} ${LONG[r.month]!.slice(0, 3)} ${r.year}`;
      const suffix = ` (PIB, ${dateShort})`;
      const canonicalUrl = canonicalOf(prid);
      items.push({
        prid,
        brief: {
          type: "press_material",
          slug: slugify(headline),
          sectionSlug: sectionFor(r.title),
          headline,
          standfirst: `Full text of a press release issued by the ${wanted} through the Press Information Bureau on ${dateLong}.`,
          body,
          canonicalUrl,
          sourceIssuedAt: r.issuedAt,
          sourceIssuer: wanted,
          citations: [{ url: canonicalUrl, label: `${headline.slice(0, 300 - suffix.length)}${suffix}`, publisherName: "Press Information Bureau", isPrimary: true }],
          termSlugs: STATES.filter(([re]) => re.test(r.title)).slice(0, 3).map(([, slug]) => ({ kind: "state", slug })),
        },
      });
      console.log(`ok    ${prid} ${body.length} blocks: ${headline.slice(0, 80)}`);
    } catch (e) {
      skip(`could not be read (${(e as Error).message})`);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ministry: ISSUERS[ministry], months, preparedAt: new Date().toISOString(), items, skipped }, null, 1));
  console.log(`\nprepared ${items.length}, left out ${skipped.length} -> ${out}`);
}

async function runPublish() {
  const file = args.find((a) => a.endsWith(".json"));
  const email = opt("--as");
  const override = args.includes("--override-risk");
  if (!file || !email) throw new Error("Usage: publish <file.json> --as <staff email> [--override-risk]");
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");
  const { items } = JSON.parse(readFileSync(file, "utf8")) as { items: Prepared[] };
  const { db, pool } = createDb(url, 1);
  const tally = { published: 0, overridden: 0, held: 0, skipped: 0, failed: 0 };
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const reason = `Verbatim official release from the Press Information Bureau, published with no added claims. Reclassified by the managing editor on ${today} to publish without medical review; publisher decision.`;
  try {
    const [person] = await db.select().from(people).where(eq(people.email, email.toLowerCase()));
    if (!person) throw new Error(`No staff account for ${email}.`);
    const actor = await loadActor(db, person.id);
    for (const { prid, brief } of items) {
      const [dup] = await db.select({ id: articles.id, status: articles.status }).from(articles).where(eq(articles.canonicalUrl, brief.canonicalUrl));
      if (dup) { tally.skipped++; console.log(`skip      ${prid} already on the site (${dup.status})`); continue; }
      try {
        let r = await createArticle(db, actor, brief, new Date());
        const [row] = await db.select({ risk: articles.riskRoute, lock: articles.lockVersion }).from(articles).where(eq(articles.id, r.id));
        let lock = row!.lock;
        const step = async (action: string, extra: Record<string, unknown> = {}) => {
          r = await performAction(db, actor, r.id, { action, expectedVersion: lock, idempotencyKey: `pib-${prid}-${action}`, ...extra }, new Date());
          const [now] = await db.select({ lock: articles.lockVersion }).from(articles).where(eq(articles.id, r.id));
          lock = now!.lock;
        };
        if (row!.risk !== "routine") {
          if (!override) { tally.held++; console.log(`held      ${prid} ${row!.risk}: ${r.slug}`); continue; }
          await step("classify", { riskRoute: "routine", reason });
          tally.overridden++;
        }
        await step("submit");
        await step("approve-editorial");
        await step("publish");
        tally.published++;
        console.log(`published ${prid} ${r.slug}`);
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
        tally.failed++;
        console.log(`FAILED    ${prid} ${e.code} ${e.message} ${JSON.stringify(e.extra?.fieldErrors ?? [])}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await pool.end();
  }
  console.log(`\n${JSON.stringify(tally)}`);
}

/** Everything new this month from every ministry we carry. Safe to run any number of times a day. */
async function runDaily() {
  const email = opt("--as");
  const override = args.includes("--override-risk");
  if (!email) throw new Error("Usage: daily --as <staff email> [--override-risk]");
  const ist = new Date(Date.now() + 5.5 * 3_600_000); // IST wall clock, read through the UTC getters
  const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const previous = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
  // Early in a month, look back as well: late releases and missed days are picked up.
  const months = ist.getUTCDate() <= 3 ? `${ym(previous)}..${ym(ist)}` : ym(ist);
  for (const ministry of Object.keys(ISSUERS)) {
    const out = `scripts/pib/daily-${ist.toISOString().slice(0, 10)}-${ministry}.json`;
    console.log(`\n== ${ISSUERS[ministry]} ${months}`);
    args.splice(0, args.length, "fetch", "--ministry", ministry, "--months", months, "--out", out);
    await runFetch();
    args.splice(0, args.length, "publish", out, "--as", email, ...(override ? ["--override-risk"] : []));
    await runPublish();
  }
}

if (args[0] === "fetch") await runFetch();
else if (args[0] === "daily") await runDaily();
else if (args[0] === "publish") await runPublish();
else if (args[0] === "probe") {
  const r = await fetchRelease(args[1]!);
  console.log(JSON.stringify({ ...r, bodyHtml: undefined, blocks: htmlToBlocks(r.bodyHtml) }, null, 1));
} else throw new Error("Usage: npm run pib -- fetch|publish|daily|probe …");
