import { getDb } from "@/db/client";
import { MAX_BODY_BYTES } from "@/core/ingest/contract";
import { receiveEvent } from "@/core/ingest/receive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/ingest/events — submit one revision (API-01). */
export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return Response.json({ code: "BODY_TOO_LARGE", message: "Request body exceeds 256 KiB." }, { status: 413 });
  }
  const rawBody = Buffer.from(await request.arrayBuffer());
  try {
    const result = await receiveEvent(
      getDb(),
      {
        producerKey: request.headers.get("x-producer-key"),
        timestamp: request.headers.get("x-timestamp"),
        signature: request.headers.get("x-signature"),
        idempotencyKey: request.headers.get("idempotency-key"),
      },
      rawBody,
      new Date(),
    );
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store", ...result.headers } });
  } catch (e) {
    console.error(JSON.stringify({ msg: "ingest_error", error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ code: "INTERNAL", message: "Transient failure. Retry the same bytes and ID." }, { status: 503, headers: { "Retry-After": "5" } });
  }
}
