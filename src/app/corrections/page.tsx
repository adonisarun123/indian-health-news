import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { CASE_REASONS } from "@/core/cases";
import { listCorrections } from "@/core/reader";
import { isoIst, longDate } from "@/lib/format";
import { first, pageMeta } from "@/lib/page";
import { reportAction } from "../newsroom/actions";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Corrections", description: "Material corrections to our reports, and how to report an error.", path: "/corrections", indexable: true });
}

export default async function Corrections({ searchParams }: Props) {
  const sp = await searchParams;
  const list = await listCorrections(getDb(), new Date());
  const caseNumber = first(sp.case);
  const error = first(sp.error);
  const story = (first(sp.story) ?? "").replace(/[^a-z0-9-]/g, "").slice(0, 120);
  return (
    <div className="prose">
      <h1 className="page-title">Corrections</h1>
      <p className="intro">When we correct a report we keep its address and original publication time, and add a dated note saying what changed.</p>

      <h2 id="report">Report an error</h2>
      {caseNumber ? (
        <div className="note" role="status">
          <p>
            <strong>Thank you. Your report has been received.</strong>
          </p>
          {caseNumber !== "received" && (
            <p>
              Your case number is <strong>{caseNumber}</strong>. Keep it if you want to follow up.
            </p>
          )}
          <p>
            <Link href="/corrections#report">Report something else</Link>
          </p>
        </div>
      ) : (
        <>
          <p>Tell us about a factual error, a broken source link, a rights objection or a privacy concern. Urgent clinical safety and privacy reports go to the duty editor at once.</p>
          {error && (
            <p className="flash error" role="alert">
              {error}
            </p>
          )}
          <form action={reportAction} className="form">
            <input type="hidden" name="story" value={story} />
            <div>
              <label htmlFor="reason">What is this about?</label>
              <select id="reason" name="reason" defaultValue="factual_error" required>
                {Object.entries(CASE_REASONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {story && <p className="meta">About the report at /news/{story}</p>}
            <div>
              <label htmlFor="description">What is wrong, and how do you know?</label>
              <textarea id="description" name="description" minLength={10} maxLength={5000} required />
            </div>
            <div>
              <label htmlFor="sourceUrl">
                Source link, if the problem is a link <span className="hint">Optional.</span>
              </label>
              <input id="sourceUrl" name="sourceUrl" type="url" placeholder="https://" />
            </div>
            <div>
              <label htmlFor="contact">
                How can we reach you? <span className="hint">Optional. Seen only by the staff handling your report. Never published.</span>
              </label>
              <input id="contact" name="contact" type="text" maxLength={300} autoComplete="email" />
            </div>
            {/* Honeypot: hidden from people, filled by bots. */}
            <div className="visually-hidden" aria-hidden="true">
              <label htmlFor="website">Leave this field empty</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <button className="button primary" type="submit">
              Send report
            </button>
          </form>
          <p className="meta">
            For a formal complaint, see <Link href="/complaints">complaints</Link>.
          </p>
        </>
      )}

      <h2>Recent corrections</h2>
      {list.length === 0 ? (
        <p>No material corrections have been published.</p>
      ) : (
        <ul className="plain-list">
          {list.map((c) => (
            <li key={c.url} style={{ marginBottom: "1.25rem" }}>
              <p className="meta">
                <time dateTime={isoIst(c.correctedAt)}>{longDate(c.correctedAt)}</time>
              </p>
              <p>
                <Link href={c.url}>{c.title}</Link>
              </p>
              <p>{c.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
