import Link from "next/link";
import type { Db } from "@/db/client";
import { decodeCursor, encodeCursor, listFeed, type FeedFilter } from "@/core/reader";
import { FeedList, Pager } from "./Feed";

/** A dated listing with keyset pagination, shared by latest, hubs and profiles. */
export async function Listing({ db, now, basePath, before, filter = {}, empty, pageSize = 20 }: { db: Db; now: Date; basePath: string; before?: string; filter?: FeedFilter; empty: React.ReactNode; pageSize?: number }) {
  const cursor = decodeCursor(before);
  const { items, next } = await listFeed(db, now, { ...filter, cursor, limit: pageSize });
  if (items.length === 0) return <div className="note">{empty}</div>;
  return (
    <>
      <FeedList items={items} now={now} twoCol />
      <Pager newerHref={cursor ? basePath : null} olderHref={next ? `${basePath}?before=${encodeCursor(next)}` : null} />
    </>
  );
}

export function EmptyHub({ what }: { what: string }) {
  return (
    <>
      <p>There is no coverage of {what} yet.</p>
      <p>
        <Link href="/latest">See the latest from across India</Link> or <Link href="/search">search all coverage</Link>.
      </p>
    </>
  );
}
