import { getDb } from "@/db/client";
import { getReceipt } from "@/core/ingest/receive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/ingest/events/{event_id} — receipt status (API-03).
 * Signed like a POST with an empty body: HMAC over `timestamp.event_id.`.
 */
export async function GET(request: Request, ctx: { params: Promise<{ event_id: string }> }): Promise<Response> {
  const { event_id } = await ctx.params;
  try {
    const result = await getReceipt(
      getDb(),
      {
        producerKey: request.headers.get("x-producer-key"),
        timestamp: request.headers.get("x-timestamp"),
        signature: request.headers.get("x-signature"),
      },
      event_id,
      new Date(),
    );
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(JSON.stringify({ msg: "receipt_error", error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ code: "INTERNAL", message: "Transient failure." }, { status: 503, headers: { "Retry-After": "5" } });
  }
}
