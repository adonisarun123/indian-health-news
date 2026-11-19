/**
 * Marks a page whose substance only the publisher can supply: legal entity,
 * contacts, policies. Shown to readers and kept out of the index until the
 * real text is in place (GOV-02).
 */
export function PublisherToSupply({ items }: { items: string[] }) {
  return (
    <div className="draft-note" role="note">
      <p>
        <strong>Not final.</strong> The publisher has not yet supplied:
      </p>
      <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
