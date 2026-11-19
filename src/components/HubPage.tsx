import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getHub, type TermKind } from "@/core/reader";
import { first, pageMeta } from "@/lib/page";
import { EmptyHub, Listing } from "./Hub";

export type HubProps = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const PATH: Record<TermKind, string> = { section: "/section", state: "/state", topic: "/topic" };
const DEFAULT_INTRO: Record<TermKind, (name: string) => string> = {
  section: (n) => `Reports and source updates filed under ${n}.`,
  state: (n) => `Health reports and official updates from ${n}.`,
  topic: (n) => `Coverage of ${n} across sections and states.`,
};

export async function hubMetadata(kind: TermKind, { params, searchParams }: HubProps): Promise<Metadata> {
  const { slug } = await params;
  const before = first((await searchParams).before);
  const hub = await getHub(getDb(), kind, slug, new Date());
  if (hub.kind !== "ok") return {};
  const path = `${PATH[kind]}/${hub.term.slug}`;
  return pageMeta({ title: hub.term.name, description: hub.term.intro ?? DEFAULT_INTRO[kind](hub.term.name), path: before ? `${path}?before=${before}` : path, indexable: hub.indexable && !before });
}

/** Section, state and topic hubs share one template (WEB-01, WEB-02). */
export async function HubPage({ kind, params, searchParams }: HubProps & { kind: TermKind }) {
  const { slug } = await params;
  const before = first((await searchParams).before);
  const db = getDb();
  const now = new Date();
  const hub = await getHub(db, kind, slug, now);
  if (hub.kind === "redirect") permanentRedirect(`${PATH[kind]}/${hub.slug}`);
  if (hub.kind !== "ok") notFound();
  const { term } = hub;
  return (
    <>
      <p className="kicker">{kind === "state" ? "State or union territory" : kind === "topic" ? "Topic" : "Section"}</p>
      <h1 className="page-title">{term.name}</h1>
      <p className="intro" style={{ marginBottom: "1.5rem" }}>
        {term.intro ?? DEFAULT_INTRO[kind](term.name)}
      </p>
      <Listing db={db} now={now} basePath={`${PATH[kind]}/${term.slug}`} before={before} filter={{ termId: term.id }} empty={<EmptyHub what={term.name} />} />
    </>
  );
}
