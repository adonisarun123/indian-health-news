import { Field } from "./Desk";

export interface StoryFormValues {
  type?: string;
  headline?: string;
  standfirst?: string;
  body?: string;
  section?: string;
  state?: string;
  citations?: string;
  contribution?: string | null;
  contributionNote?: string | null;
  correctionNote?: string | null;
  assistModel?: string | null;
}

const CONTRIBUTIONS = [
  ["prior_notice_comparison", "Checked comparison with an earlier notice"],
  ["on_record_interview", "On-record interview"],
  ["local_reporting", "Local reporting"],
  ["dataset_analysis", "Analysis of the underlying dataset"],
];

/** Shared fields for creating and editing a story (ED-02). */
export function StoryFields({ v, sections, states, isNew, isPublic }: { v: StoryFormValues; sections: { slug: string; name: string }[]; states: { slug: string; name: string }[]; isNew: boolean; isPublic: boolean }) {
  return (
    <>
      {isNew && (
        <Field label="Type" name="type">
          <select id="type" name="type" defaultValue={v.type ?? "original_brief"}>
            <option value="original_brief">News brief</option>
            <option value="original_report">News report</option>
            <option value="analysis">Analysis</option>
            <option value="press_material">Press material (labelled, not indexed)</option>
          </select>
        </Field>
      )}
      <Field label="Headline" name="headline" hint="Sentence case. The address is made from the first headline and does not change.">
        <input id="headline" name="headline" type="text" defaultValue={v.headline} maxLength={200} required />
      </Field>
      <Field label="Standfirst" name="standfirst" hint="One sentence. Also used as the search and share description.">
        <textarea id="standfirst" name="standfirst" defaultValue={v.standfirst} maxLength={400} style={{ minHeight: "4.5rem" }} />
      </Field>
      <Field label="Body" name="body" hint="Blank line between paragraphs. '## ' for a heading, '- ' for a list, '> quote -- attribution' for a quote.">
        <textarea id="body" name="body" className="tall" defaultValue={v.body} required />
      </Field>
      <Field label="Sources" name="citations" hint="One per line: https://address | Title of the notice | Publisher. The first line is the primary source.">
        <textarea id="citations" name="citations" defaultValue={v.citations} placeholder="https://health.example/notices/204 | District reporting calendar released | State Health Bulletin" />
      </Field>
      <Field label="Section" name="section">
        <select id="section" name="section" defaultValue={v.section ?? ""} required>
          <option value="" disabled>
            Choose one
          </option>
          {sections.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="State or union territory" name="state" hint="Leave empty for an India-wide story.">
        <select id="state" name="state" defaultValue={v.state ?? ""}>
          <option value="">India-wide</option>
          {states.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Original contribution" name="contribution" hint="What this report adds. A new headline or light rewrite is not enough.">
        <select id="contribution" name="contribution" defaultValue={v.contribution ?? ""}>
          <option value="">None recorded</option>
          {CONTRIBUTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Contribution note" name="contributionNote" hint="What exactly was checked or who was interviewed.">
        <input id="contributionNote" name="contributionNote" type="text" defaultValue={v.contributionNote ?? ""} maxLength={2000} />
      </Field>
      {isPublic && (
        <Field label="Correction note" name="correctionNote" hint="Shown to readers with the date. Required to release a correction.">
          <input id="correctionNote" name="correctionNote" type="text" defaultValue={v.correctionNote ?? ""} maxLength={2000} />
        </Field>
      )}
      <Field label="Embargo until (IST)" name="embargoUntil" hint="Optional. Nothing is public before this time.">
        <input id="embargoUntil" name="embargoUntil" type="datetime-local" />
      </Field>
      <Field label="Drafting assistance" name="assistModel" hint="If software helped draft this, record the model and version. A person still owns the byline.">
        <input id="assistModel" name="assistModel" type="text" defaultValue={v.assistModel ?? ""} maxLength={120} />
      </Field>
    </>
  );
}
