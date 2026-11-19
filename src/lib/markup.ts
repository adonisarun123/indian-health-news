import type { Block } from "@/core/articles";

/**
 * Plain-text editing format for the story body. Blank lines separate blocks.
 *   ## Heading        - list item        1. numbered item        > quote -- attribution
 * Anything else is a paragraph. No HTML is accepted or produced.
 */
export function parseMarkup(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines[0]!.startsWith("## ")) {
      blocks.push({ type: "heading", text: lines[0]!.slice(3).trim() });
      if (lines.length > 1) blocks.push({ type: "paragraph", text: lines.slice(1).join(" ") });
    } else if (lines.every((l) => /^[-*]\s+/.test(l))) {
      blocks.push({ type: "list", ordered: false, items: lines.map((l) => l.replace(/^[-*]\s+/, "")) });
    } else if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      blocks.push({ type: "list", ordered: true, items: lines.map((l) => l.replace(/^\d+[.)]\s+/, "")) });
    } else if (lines[0]!.startsWith("> ")) {
      const [quote, attribution] = lines.map((l) => l.replace(/^>\s?/, "")).join(" ").split(/\s+--\s+/);
      blocks.push({ type: "quote", text: quote!.trim(), ...(attribution ? { attribution: attribution.trim() } : {}) });
    } else {
      blocks.push({ type: "paragraph", text: lines.join(" ") });
    }
  }
  return blocks;
}

export function toMarkup(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.type === "heading") return `## ${b.text}`;
      if (b.type === "list") return b.items.map((item, i) => (b.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join("\n");
      if (b.type === "quote") return `> ${b.text}${b.attribution ? ` -- ${b.attribution}` : ""}`;
      return b.text;
    })
    .join("\n\n");
}

export interface CitationLine {
  url: string;
  label: string;
  publisherName: string;
  isPrimary: boolean;
}

/** One source per line: `https://url | Label | Publisher`. The first line is the primary source. */
export function parseCitations(text: string): CitationLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const [url = "", label = "", publisherName = ""] = line.split("|").map((x) => x.trim());
      return { url, label: label || url, publisherName: publisherName || hostOf(url), isPrimary: i === 0 };
    });
}

export function citationsToText(c: { url: string; label: string; publisherName: string; isPrimary: boolean }[]): string {
  return [...c].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((x) => `${x.url} | ${x.label} | ${x.publisherName}`).join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unknown publisher";
  }
}
