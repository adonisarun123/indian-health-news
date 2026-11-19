/** Reader-facing times are always Indian Standard Time with an explicit label (UX-02). */
const TZ = "Asia/Kolkata";

const parts = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(new Intl.DateTimeFormat("en-IN", { timeZone: TZ, ...opts }).formatToParts(d).map((p) => [p.type, p.value]));

function clock(d: Date): string {
  const p = parts(d, { hour: "numeric", minute: "2-digit", hour12: true });
  return `${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()} IST`;
}

/** "19 Nov 2026, 10:00 am IST" */
export function longDateTime(d: Date): string {
  const p = parts(d, { day: "numeric", month: "short", year: "numeric" });
  return `${p.day} ${p.month} ${p.year}, ${clock(d)}`;
}

/** "19 Nov · 10:00 am IST", with the year added once it differs from the current one. */
export function shortDateTime(d: Date, now: Date = new Date()): string {
  const p = parts(d, { day: "numeric", month: "short", year: "numeric" });
  const sameYear = parts(now, { year: "numeric" }).year === p.year;
  return `${p.day} ${p.month}${sameYear ? "" : ` ${p.year}`} · ${clock(d)}`;
}

export function longDate(d: Date): string {
  const p = parts(d, { day: "numeric", month: "long", year: "numeric" });
  return `${p.day} ${p.month} ${p.year}`;
}

/** ISO 8601 with the +05:30 offset, for <time datetime>. */
export function isoIst(d: Date): string {
  const shifted = new Date(d.getTime() + 5.5 * 3600_000);
  return `${shifted.toISOString().slice(0, 19)}+05:30`;
}
