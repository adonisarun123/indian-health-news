/**
 * Feed dates to absolute instants. The contract needs an explicit offset, so a
 * date that names no zone is only accepted when the manifest says which zone
 * the publisher means; otherwise it is reported as unknown with a reason.
 */

export type DateResult = { at: Date } | { at: null; reason: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** RFC 822 zone names. IST is read as India Standard Time: these are Indian feeds. */
const ZONES: Record<string, string> = {
  ut: "+00:00", utc: "+00:00", gmt: "+00:00", z: "+00:00",
  est: "-05:00", edt: "-04:00", cst: "-06:00", cdt: "-05:00", mst: "-07:00", mdt: "-06:00", pst: "-08:00", pdt: "-07:00",
  ist: "+05:30", bst: "+01:00", cet: "+01:00", cest: "+02:00",
};

function offsetMinutes(offset: string): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Offset of an IANA zone at an instant, in minutes east of UTC. */
function zoneOffset(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at) / 60_000;
}

/** A wall-clock time in a zone (fixed offset or IANA name) to an instant. */
export function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): Date | null {
  const wall = Date.UTC(y, mo, d, h, mi, s);
  const fixed = offsetMinutes(zone);
  if (fixed !== null) return new Date(wall - fixed * 60_000);
  try {
    let at = wall - zoneOffset(wall, zone) * 60_000;
    at = wall - zoneOffset(at, zone) * 60_000; // settle across a DST change
    return new Date(at);
  } catch {
    return null;
  }
}

function hour12(h: number, ampm: string | undefined): number {
  if (!ampm) return h;
  const pm = ampm.toLowerCase() === "pm";
  return (h % 12) + (pm ? 12 : 0);
}

export function parseFeedDate(raw: string | undefined, opts: { zone?: string; now?: Date } = {}): DateResult {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { at: null, reason: "feed gives no publication time" };
  const now = opts.now ?? new Date();
  let at: Date | null = null;
  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s))) {
    // ISO 8601
    const [, y, mo, d, h = "0", mi = "0", sec = "0", z] = m;
    const zone = z ? (z.toUpperCase() === "Z" ? "+00:00" : z) : opts.zone;
    if (!zone) return { at: null, reason: "feed date has no time zone" };
    at = fromWallClock(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), zone);
  } else if ((m = /^(?:[a-z]{3,9},? )?(\d{1,2}) ([a-z]{3})[a-z]*\.? (\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?([ap]m)?(?: ?([+-]\d{2}:?\d{2}|[a-z]{1,5}))?$/i.exec(s))) {
    // RFC 822 / 2822: "Wed, 25 Nov 2026 15:52:27 +0530", "Wed, 25 Nov 2026 06:33:33 EST"
    const [, d, mon, y, h, mi, sec = "0", ampm, z] = m;
    const mo = MONTHS.indexOf(mon!.toLowerCase());
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    const zone = z ? (ZONES[z.toLowerCase()] ?? (/^[+-]/.test(z) ? z : undefined)) : opts.zone;
    if (mo < 0) return { at: null, reason: "feed date is not readable" };
    if (!zone) return { at: null, reason: z ? `feed date names an unknown zone (${z})` : "feed date has no time zone" };
    at = fromWallClock(year, mo, Number(d), hour12(Number(h), ampm), Number(mi), Number(sec), zone);
  } else if ((m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([ap]m)?(?: ([+-]\d{2}:?\d{2}|[a-z]{1,5}))?$/i.exec(s))) {
    // "Nov 24, 2026 4:58pm"
    const [, mon, d, y, h, mi, sec = "0", ampm, z] = m;
    const mo = MONTHS.indexOf(mon!.toLowerCase());
    const zone = z ? (ZONES[z.toLowerCase()] ?? (/^[+-]/.test(z) ? z : undefined)) : opts.zone;
    if (mo < 0) return { at: null, reason: "feed date is not readable" };
    if (!zone) return { at: null, reason: "feed date has no time zone" };
    at = fromWallClock(Number(y), mo, Number(d), hour12(Number(h), ampm), Number(mi), Number(sec), zone);
  } else {
    return { at: null, reason: "feed date is not readable" };
  }

  if (!at || Number.isNaN(at.getTime())) return { at: null, reason: "feed date is not readable" };
  if (at.getTime() > now.getTime() + 36 * 3_600_000) return { at: null, reason: "feed date is in the future" };
  if (at.getUTCFullYear() < 2000) return { at: null, reason: "feed date is before 2000" };
  return { at };
}
