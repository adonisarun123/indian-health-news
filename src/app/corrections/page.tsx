import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { listCorrections } from "@/core/reader";
import { PublisherToSupply } from "@/components/Draft";
import { isoIst, longDate } from "@/lib/format";
import { pageMeta } from "@/lib/page";

export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Corrections", description: "Material corrections to India Health News reports, and how to report an error.", path: "/corrections", indexable: true });
}

export default async function Corrections() {
  const list = await listCorrections(getDb(), new Date());
  return (
    <div className="prose">
      <h1 className="page-title">Corrections</h1>
      <p className="intro">When we correct a report we keep its address and original publication time, and add a dated note saying what changed.</p>

      <h2 id="report">Report an error</h2>
      <p>Tell us about a factual error, a broken source link, a rights objection or a privacy concern.</p>
      <PublisherToSupply items={["The corrections email address or form", "The duty editor contact for urgent clinical or privacy reports"]} />
      <p>
        Until then, see <Link href="/contact">contact</Link>.
      </p>

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
