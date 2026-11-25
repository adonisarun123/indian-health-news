/**
 * List new CDSCO and FSSAI notices for the daily brief writer (see docs/DECISIONS.md,
 * "CDSCO and FSSAI: briefs only").
 *
 *   npm run sources                 new items since the last run -> scripts/sources/YYYY-MM-DD.json
 *   npm run sources -- --days 30    on a first run, how far back to look (default 14)
 *
 * Nothing here publishes or copies anything to the site. CDSCO's copyright policy does not
 * allow reproduction without permission, and FSSAI's own pages contradict each other, so
 * these notices are only leads: the daily run reads the source and writes an original
 * brief in our own words, saved as a draft for the managing editor.
 *
 * Seen items are remembered in scripts/sources/seen.json, so the command is safe to repeat.
 * Run it from Arun's Mac; the cloud workspace cannot reach these sites.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SEEN = "scripts/sources/seen.json";
const args = process.argv.slice(2);
const days = Number(args.includes("--days") ? args[args.indexOf("--days") + 1] : 14);

interface Item { source: "CDSCO" | "FSSAI"; category: string; title: string; date: string; url: string }

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&(#?\w+);/g, (m, e: string) => ENT[e.toLowerCase()] ?? m).replace(/\s+/g, " ").trim();

async function get(url: string): Promise<string> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9" }, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i >= 3) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

/** CDSCO notice lists: rows of S.no, title, date (2026-Nov-11), PDF link. */
const CDSCO_LISTS: [string, string][] = [
  ["Public notice", "https://cdsco.gov.in/opencms/opencms/en/Notifications/Public-Notices/"],
  ["Notification", "https://cdsco.gov.in/opencms/opencms/en/Notifications/Gazette-Notifications/"],
];
async function cdsco(): Promise<Item[]> {
  const out: Item[] = [];
  for (const [category, url] of CDSCO_LISTS) {
    const html = await get(url);
    for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!);
      const d = cells.map(text).find((c) => /^\d{4}-[A-Za-z]{3}-\d{1,2}$/.test(c));
      const href = /href=['"]([^'"]*download_file[^'"]*)['"]/.exec(row[1]!)?.[1];
      if (!d || !href || cells.length < 3) continue;
      const [y, m, day] = d.split("-");
      const mi = MON.indexOf(m!.toLowerCase());
      if (mi < 0) continue;
      out.push({ source: "CDSCO", category, title: text(cells[1]!), date: `${y}-${String(mi + 1).padStart(2, "0")}-${day!.padStart(2, "0")}`, url: new URL(href, "https://cdsco.gov.in").href });
    }
  }
  return out;
}

/**
 * FSSAI's site is a single-page app whose "What's new" list is built into its script bundle.
 * We read the bundle the home page loads and keep press notes and advisories/orders.
 * If FSSAI changes its site this returns nothing, and the report says so.
 */
async function fssai(): Promise<Item[]> {
  const home = await get("https://www.fssai.gov.in/");
  const bundles = [...home.matchAll(/src="(\/assets\/index-[^"]+\.js)"/g)].map((m) => m[1]!);
  if (!bundles.length) throw new Error("FSSAI home page loads no index bundle (site changed?)");
  const out: Item[] = [];
  for (const b of bundles) {
    const js = await get(`https://www.fssai.gov.in${b}`);
    for (const m of js.matchAll(/\{"category":"([^"]*)","date":"(\d\d)-(\d\d)-(\d{4})","title":"((?:[^"\\]|\\.)*)","href":"([^"]*)","kind":"[^"]*"\}/g)) {
      const [, category, dd, mm, yyyy, rawTitle, href] = m;
      if (!/press note|advisories|notifications/i.test(category!)) continue;
      const title = text(JSON.parse(`"${rawTitle}"`) as string);
      const url = href === "#" || !href ? "https://www.fssai.gov.in/" : new URL(encodeURI(href!), "https://www.fssai.gov.in").href;
      out.push({ source: "FSSAI", category: category!, title, date: `${yyyy}-${mm}-${dd}`, url });
    }
  }
  return out;
}

const key = (i: Item) => `${i.source}|${i.date}|${i.title.toLowerCase()}`;
const firstRun = !existsSync(SEEN);
const seen = new Set<string>(firstRun ? [] : (JSON.parse(readFileSync(SEEN, "utf8")) as string[]));
const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const tally: Record<string, number | string> = {};
const fresh: Item[] = [];
const all: Item[] = [];
for (const [name, fn] of [["CDSCO", cdsco], ["FSSAI", fssai]] as const) {
  try {
    const items = await fn();
    all.push(...items);
    const neu = [...new Map(items.map((i) => [key(i), i])).values()].filter((i) => !seen.has(key(i)) && (!firstRun || i.date >= cutoff));
    fresh.push(...neu);
    tally[name] = neu.length;
    console.log(`${name}: ${items.length} listed, ${neu.length} new`);
  } catch (e) {
    tally[name] = `failed: ${(e as Error).message}`;
    console.log(`${name} FAILED: ${(e as Error).message}`);
  }
}
for (const i of all) seen.add(key(i));
mkdirSync("scripts/sources", { recursive: true });
writeFileSync(SEEN, JSON.stringify([...seen].sort(), null, 0));
const ist = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const outFile = `scripts/sources/${ist}.json`;
fresh.sort((a, b) => b.date.localeCompare(a.date));
writeFileSync(outFile, JSON.stringify({ preparedAt: new Date().toISOString(), note: "Leads only. Do not copy text from these notices; write an original brief and save it as a draft.", items: fresh }, null, 1));
for (const i of fresh) console.log(`new   ${i.source} ${i.date} [${i.category}] ${i.title.slice(0, 100)}`);
console.log(`\n${JSON.stringify(tally)} -> ${outFile}`);
