import { getDb } from "@/db/client";
import { listStateTerms } from "@/core/desk";
import { listSections } from "@/core/reader";
import { Field, Flash, type SP } from "@/components/Desk";
import { sourceCreateAction } from "../../../actions";

export const metadata = { title: "Register a source" };

export default async function NewSource({ searchParams }: { searchParams: SP }) {
  const db = getDb();
  return (
    <>
      <h1>Register a source</h1>
      <Flash searchParams={searchParams} />
      <p className="note">A new source starts as proposed with no rights on record. It cannot publish anything until a managing editor records a grant and enables it.</p>
      <form action={sourceCreateAction} className="form" style={{ marginTop: "1rem" }}>
        <Field label="Identifier" name="slug" hint="Lowercase with hyphens. The scraper sends this as source_id.">
          <input id="slug" name="slug" type="text" required pattern="[a-z0-9][a-z0-9-]+" />
        </Field>
        <Field label="Legal name" name="legalName">
          <input id="legalName" name="legalName" type="text" required />
        </Field>
        <Field label="Display name" name="displayName" hint="Shown to readers on cards and source lists.">
          <input id="displayName" name="displayName" type="text" required />
        </Field>
        <Field label="Homepage" name="homepageUrl">
          <input id="homepageUrl" name="homepageUrl" type="url" placeholder="https://" required />
        </Field>
        <Field label="Approved hosts" name="hosts" hint="Host names the scraper may submit links for, separated by spaces.">
          <input id="hosts" name="hosts" type="text" required />
        </Field>
        <Field label="Source family" name="family">
          <select id="family" name="family" defaultValue="state_local">
            <option value="national_authority">National authority</option>
            <option value="state_local">State or local body</option>
            <option value="research_professional">Research or professional body</option>
            <option value="independent_commercial">Independent or commercial publisher</option>
          </select>
        </Field>
        <Field label="Jurisdiction" name="jurisdiction" hint="Leave empty for a national source.">
          <select id="jurisdiction" name="jurisdiction" defaultValue="">
            <option value="">National</option>
            {(await listStateTerms(db)).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language" name="language">
          <input id="language" name="language" type="text" defaultValue="en" />
        </Field>
        <Field label="Default risk route" name="defaultRiskRoute" hint="Choose clinical for a source such as drug safety alerts, so nothing from it posts automatically.">
          <select id="defaultRiskRoute" name="defaultRiskRoute" defaultValue="routine">
            <option value="routine">Routine</option>
            <option value="clinical">Clinical</option>
            <option value="sensitive">Sensitive</option>
          </select>
        </Field>
        <Field label="Section for partner copies" name="defaultSection" hint="Only needed for a licensed partner feed.">
          <select id="defaultSection" name="defaultSection" defaultValue="">
            <option value="">None</option>
            {(await listSections(db)).map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Neutral card label" name="neutralLabel" hint="Used instead of the headline when the grant does not cover headlines.">
          <input id="neutralLabel" name="neutralLabel" type="text" />
        </Field>
        <Field label="Contact at the publisher" name="contact">
          <input id="contact" name="contact" type="text" />
        </Field>
        <button className="button primary" type="submit">
          Register
        </button>
      </form>
    </>
  );
}
