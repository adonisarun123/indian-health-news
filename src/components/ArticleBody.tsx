import type { Block } from "@/core/articles";

/** Renders allowlisted content blocks. Text is escaped by React; no HTML passes through. */
export function ArticleBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="body">
      {blocks.map((b, i) => {
        if (b.type === "heading") return <h2 key={i}>{b.text}</h2>;
        if (b.type === "quote")
          return (
            <blockquote key={i}>
              <p>{b.text}</p>
              {b.attribution && <footer>{b.attribution}</footer>}
            </blockquote>
          );
        if (b.type === "list") {
          const L = b.ordered ? "ol" : "ul";
          return (
            <L key={i}>
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </L>
          );
        }
        return <p key={i}>{b.text}</p>;
      })}
    </div>
  );
}
