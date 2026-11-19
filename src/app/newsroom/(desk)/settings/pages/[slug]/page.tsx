import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import type { Block } from "@/core/articles";
import { getPage, getPageSource, PUBLISHER_FIELDS } from "@/core/settings";
import { Field, Flash, type SP, when } from "@/components/Desk";
import { toMarkup } from "@/lib/markup";
import { pageSaveAction } from "../../../../actions";

export const metadata = { title: "Policy page" };

export default async function EditPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const db = getDb();
  const [src, page] = [await getPageSource(db, slug), await getPage(db, slug)];
  if (!src || !page) notFound();
  return (
    <>
      <p className="breadcrumb">
        <Link href="/newsroom/settings">Settings</Link>
      </p>
      <h1>{src.title}</h1>
      <Flash searchParams={searchParams} />
      <p className="meta">
        Live: version {src.version}, effective {when(src.effectiveAt)}. <Link href={`/${slug}`}>View public page</Link>
      </p>
      <p className="note">
        Use {"{{name}}"} placeholders for publisher details: {PUBLISHER_FIELDS.map((f) => `{{${f.key}}}`).join(" ")}
      </p>
      <form action={pageSaveAction.bind(null, slug)} className="form" style={{ marginTop: "1rem" }}>
        <Field label="Title" name="title">
          <input id="title" name="title" type="text" defaultValue={src.title} required />
        </Field>
        <Field label="Search description" name="description">
          <input id="description" name="description" type="text" defaultValue={src.description} />
        </Field>
        <Field label="Text" name="body" hint="Blank line between paragraphs. '## ' for a heading, '- ' for a list.">
          <textarea id="body" name="body" className="tall" defaultValue={toMarkup(src.body as Block[])} required />
        </Field>
        <Field label="Reviewed by" name="reviewedBy" hint="Name and date of the adviser or editor who reviewed this exact text. Leave empty if it has not been reviewed.">
          <input id="reviewedBy" name="reviewedBy" type="text" />
        </Field>
        <Field label="What changed" name="changeNote" hint="Kept in the public version history.">
          <input id="changeNote" name="changeNote" type="text" required />
        </Field>
        <button className="button primary" type="submit">
          Publish new version
        </button>
      </form>
      <h2>Version history</h2>
      <ul>
        {page.history.map((h) => (
          <li key={h.version}>
            v{h.version} · {when(h.effectiveAt)} · {h.changeNote}
          </li>
        ))}
      </ul>
    </>
  );
}
