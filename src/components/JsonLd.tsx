import { type Graph, serializeJsonLd } from "@/core/jsonld";

/** Server-rendered JSON-LD, escaped for a script context (SD-04). */
export function JsonLd({ graph }: { graph: Graph }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(graph) }} />;
}
