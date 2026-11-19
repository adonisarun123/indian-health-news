import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getPage } from "@/core/settings";
import { isoIst, longDate } from "@/lib/format";
import { pageMeta } from "@/lib/page";
import { ArticleBody } from "./ArticleBody";

/** A policy page is indexable only when no publisher detail is missing and a reviewer is on record. */
export async function policyMetadata(slug: string): Promise<Metadata> {
  const page = await getPage(getDb(), slug);
  if (!page) return {};
  return pageMeta({ title: page.title, description: page.description, path: `/${slug}`, indexable: page.missing.length === 0 && Boolean(page.reviewedBy) });
}

/** Versioned policy document with its public version history (GOV-02). */
export async function PolicyPage({ slug }: { slug: string }) {
  const page = await getPage(getDb(), slug);
  if (!page) notFound();
  return (
    <div className="prose">
      <h1 className="page-title">{page.title}</h1>
      {page.missing.length > 0 && (
        <div className="draft-note" role="note">
          <p>
            <strong>Some details are still to be confirmed by the publisher:</strong> {page.missing.join(", ").toLowerCase()}.
          </p>
        </div>
      )}
      <ArticleBody blocks={page.body} />
      <h2>Version history</h2>
      <ul>
        {page.history.map((h) => (
          <li key={h.version}>
            Version {h.version}, effective <time dateTime={isoIst(h.effectiveAt)}>{longDate(h.effectiveAt)}</time>
            {h.changeNote && <>: {h.changeNote}</>}
          </li>
        ))}
      </ul>
    </div>
  );
}
