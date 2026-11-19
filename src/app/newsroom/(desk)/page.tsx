import Link from "next/link";
import { getDb } from "@/db/client";
import { attention, DASHBOARD_DAYS, type DashboardDay, getDashboard, GRANT_WINDOW_DAYS } from "@/core/dashboard";
import { Badge, Flash, type SP, when } from "@/components/Desk";
import { longDate } from "@/lib/format";
import { requireStaff } from "@/lib/session";

export const metadata = { title: "Dashboard" };

const label = (s: string) => s.replaceAll("_", " ").toLowerCase();
const dayOf = (iso: string) => new Date(`${iso}T12:00:00+05:30`);
const dayNumber = (iso: string) => String(Number(iso.slice(8)));

function Tile({ value, name, href, note, tone }: { value: number; name: string; href?: string; note?: string; tone?: "warn" }) {
  const body = (
    <>
      <span className="dash-value">{value.toLocaleString("en-IN")}</span>
      <span className="dash-name">{name}</span>
      {note && <span className="dash-note">{note}</span>}
    </>
  );
  const cls = `dash-tile${tone ? ` ${tone}` : ""}`;
  return href ? (
    <Link className={cls} href={href}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Stacked bars, drawn as SVG on the server. No script and no third-party code. */
function PublishingChart({ days }: { days: DashboardDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.reports + d.cards));
  const W = 40;
  const H = 120;
  const total = days.reduce((a, d) => a + d.reports + d.cards, 0);
  return (
    <figure className="dash-chart">
      <svg viewBox={`0 0 ${days.length * W} ${H + 36}`} role="img" aria-label={`Items published per day over ${days.length} days. ${total} in total. Figures are in the table below.`}>
        <line x1="0" y1={H + 0.5} x2={days.length * W} y2={H + 0.5} className="axis" />
        {days.map((d, i) => {
          const r = (d.reports / max) * (H - 16);
          const c = (d.cards / max) * (H - 16);
          const sum = d.reports + d.cards;
          return (
            <g key={d.day}>
              <title>{`${longDate(dayOf(d.day))}: ${d.reports} reports, ${d.cards} source cards`}</title>
              {d.cards > 0 && <rect className="bar-cards" x={i * W + 8} y={H - r - c} width={W - 16} height={c} rx="2" />}
              {d.reports > 0 && <rect className="bar-reports" x={i * W + 8} y={H - r} width={W - 16} height={r} rx="2" />}
              {sum > 0 && (
                <text className="bar-total" x={i * W + W / 2} y={H - r - c - 4} textAnchor="middle">
                  {sum}
                </text>
              )}
              <text className="bar-day" x={i * W + W / 2} y={H + 16} textAnchor="middle">
                {dayNumber(d.day)}
              </text>
              {(i === 0 || dayNumber(d.day) === "1") && (
                <text className="bar-month" x={i * W + W / 2} y={H + 31} textAnchor="middle">
                  {longDate(dayOf(d.day)).split(" ")[1]?.slice(0, 3)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <span className="key reports" /> Reports <span className="key cards" /> Source cards · counted by the day each item went live (IST), for items that are still live
      </figcaption>
      <details>
        <summary>Show the figures</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Reports</th>
                <th>Source cards</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{longDate(dayOf(d.day))}</td>
                  <td>{d.reports}</td>
                  <td>{d.cards}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function Rows({ rows, empty }: { rows: [string, number | string][]; empty: string }) {
  if (rows.length === 0) return <p className="meta">{empty}</p>;
  return (
    <dl className="dash-rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === "number" ? v.toLocaleString("en-IN") : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: SP }) {
  await requireStaff();
  const d = await getDashboard(getDb(), new Date());
  const alerts = attention(d);
  const today = d.days.at(-1) ?? { day: "", reports: 0, cards: 0 };
  const week = d.days.slice(-7).reduce((a, x) => a + x.reports + x.cards, 0);
  const s = d.stories.byStatus;
  const inReview = s.in_review ?? 0;
  const ev = d.pipeline.events24h;
  const events24h = Object.values(ev).reduce((a, n) => a + n, 0);

  return (
    <>
      <h1>Dashboard</h1>
      <Flash searchParams={searchParams} />
      <p className="meta">As of {when(d.generatedAt)}. Reload the page to refresh.</p>

      <section aria-labelledby="dash-attention">
        <h2 id="dash-attention">Needs attention</h2>
        {alerts.length === 0 ? (
          <p className="note">Nothing needs attention right now.</p>
        ) : (
          <ul className="dash-alerts">
            {alerts.map((a) => (
              <li key={a.text} className={a.tone}>
                <Link href={a.href}>{a.text}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="dash-numbers">
        <h2 id="dash-numbers">At a glance</h2>
        <div className="dash-tiles">
          <Tile value={today.reports + today.cards} name="Published today" note={`${today.reports} reports · ${today.cards} cards`} />
          <Tile value={week} name="Published, last 7 days" />
          <Tile value={d.live.reports + d.live.cards} name="Live on the site" note={`${d.live.reports} reports · ${d.live.cards} cards`} />
          <Tile value={d.waiting.total} name="Waiting in the queue" href="/newsroom/queue" />
          <Tile value={inReview} name="Stories in review" href="/newsroom/stories?status=in_review" />
          <Tile value={d.tasks.total} name="Open tasks" href="/newsroom/queue" tone={d.tasks.urgent ? "warn" : undefined} note={d.tasks.urgent ? `${d.tasks.urgent} urgent` : undefined} />
          <Tile value={d.cases.open + d.cases.inProgress} name="Open reader cases" href="/newsroom/cases" tone={d.cases.urgent ? "warn" : undefined} note={d.cases.urgent ? `${d.cases.urgent} urgent` : undefined} />
        </div>
      </section>

      <section aria-labelledby="dash-publishing">
        <h2 id="dash-publishing">Publishing, last {DASHBOARD_DAYS} days</h2>
        <PublishingChart days={d.days} />
      </section>

      <div className="dash-grid">
        <section className="panel" aria-labelledby="dash-queue">
          <h3 id="dash-queue">
            <Link href="/newsroom/queue">Queue</Link>
          </h3>
          <Rows empty="Nothing is waiting." rows={d.waiting.reasons.map((r) => [label(r.reason), r.n])} />
          {d.waiting.reasons.length > 1 && <p className="meta">An item held for two reasons is counted under each.</p>}
        </section>

        <section className="panel" aria-labelledby="dash-stories">
          <h3 id="dash-stories">
            <Link href="/newsroom/stories">Stories</Link>
          </h3>
          <Rows
            empty="No stories yet."
            rows={(["draft", "in_review", "approved", "scheduled", "published", "retracted", "removed"] as const).filter((k) => s[k]).map((k) => [label(k), s[k] ?? 0])}
          />
          {inReview > 0 && (
            <p className="meta">
              In review: {d.stories.needEditor} waiting for an editor, {d.stories.needMedical} waiting for medical review.
            </p>
          )}
          {d.stories.nextScheduledAt && <p className="meta">Next scheduled release: {when(d.stories.nextScheduledAt)}.</p>}
        </section>

        <section className="panel" aria-labelledby="dash-tasks">
          <h3 id="dash-tasks">
            <Link href="/newsroom/queue">Open tasks</Link>
          </h3>
          <Rows empty="No open tasks." rows={d.tasks.byKind.map((t) => [label(t.kind), t.n])} />
          {d.tasks.oldestAt && <p className="meta">Oldest opened {when(d.tasks.oldestAt)}.</p>}
        </section>

        <section className="panel" aria-labelledby="dash-cases">
          <h3 id="dash-cases">
            <Link href="/newsroom/cases">Reader cases</Link>
          </h3>
          <Rows
            empty="No open cases."
            rows={([["open", d.cases.open], ["in progress", d.cases.inProgress], ["urgent", d.cases.urgent]] as [string, number][]).filter(([, n]) => n > 0)}
          />
          {d.cases.oldestAt && <p className="meta">Oldest received {when(d.cases.oldestAt)}.</p>}
        </section>

        <section className="panel" aria-labelledby="dash-sources">
          <h3 id="dash-sources">
            <Link href="/newsroom/sources">Sources and rights</Link>
          </h3>
          <Rows
            empty="No sources registered."
            rows={(["enabled", "under_review", "proposed", "paused", "revoked"] as const).filter((k) => d.sources.byStatus[k]).map((k) => [label(k), d.sources.byStatus[k] ?? 0])}
          />
          {d.sources.notices.length === 0 ? (
            <p className="meta">Every enabled source has a grant in force, and none ends or falls due for review within {GRANT_WINDOW_DAYS} days.</p>
          ) : (
            <ul className="dash-list">
              {d.sources.notices.map((n) => (
                <li key={n.sourceId}>
                  <Link href={`/newsroom/sources/${n.sourceId}`}>{n.publisher}</Link>{" "}
                  {n.kind === "missing" ? <Badge tone="warn">no grant in force</Badge> : <Badge>{n.kind === "expires" ? "grant ends" : "review due"} {n.at ? longDate(n.at) : ""}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="dash-pipeline">
          <h3 id="dash-pipeline">Intake and background work</h3>
          <Rows
            empty=""
            rows={[
              ["events received, last 24 hours", events24h],
              ...Object.entries(ev).map(([k, n]) => [`· ${label(k)}`, n] as [string, number]),
              ["failed events, all time", d.pipeline.failedEvents],
              ["jobs that gave up", d.pipeline.deadJobs],
              ["jobs overdue", d.pipeline.overdueJobs],
              ["publication events not yet processed", d.pipeline.pendingOutbox],
              ["failed deliveries", d.pipeline.failedDeliveries],
            ]}
          />
          <p className="meta">
            Last event received: {when(d.pipeline.lastEventAt)}. Automatic publishing is {d.autoPublish ? <Badge tone="good">on</Badge> : <Badge tone="warn">stopped</Badge>}
          </p>
        </section>
      </div>

      <p className="meta">These figures come from the newsroom's own records. Traffic and readership are not shown because the site collects no analytics.</p>
    </>
  );
}
