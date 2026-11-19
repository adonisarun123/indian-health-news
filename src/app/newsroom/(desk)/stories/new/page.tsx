import { getDb } from "@/db/client";
import { getItem, listStateTerms } from "@/core/desk";
import { listSections } from "@/core/reader";
import { Flash, type SP } from "@/components/Desk";
import { StoryFields } from "@/components/StoryForm";
import { storyCreateAction } from "../../../actions";

export const metadata = { title: "New story" };

export default async function NewStory({ searchParams }: { searchParams: SP }) {
  const db = getDb();
  const sp = await searchParams;
  // Starting from a source item pre-fills its notice as the primary source.
  const item = typeof sp.item === "string" ? await getItem(db, sp.item) : null;
  const rev = item?.revisions[0];
  const citations = rev ? `${rev.submittedUrl} | ${rev.title ?? "Original notice"} | ${item!.source.displayName}` : "";
  return (
    <>
      <h1>New story</h1>
      <Flash searchParams={searchParams} />
      {rev && <p className="note">Starting from “{rev.title}” at {item!.source.displayName}. Write your own report: do not copy the notice.</p>}
      <form action={storyCreateAction} className="form">
        <StoryFields v={{ citations }} sections={await listSections(db)} states={await listStateTerms(db)} isNew isPublic={false} />
        <button className="button primary" type="submit">
          Create draft
        </button>
      </form>
    </>
  );
}
