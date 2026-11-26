/**
 * Signed intake client (API-01..03). The signature is the platform's own
 * `signRequest`: HMAC-SHA256 over `timestamp + "." + event_id + "." + body`.
 * Receipt polling signs an empty body, as decision 9 in DECISIONS.md records.
 */
import { signRequest } from "../../src/core/crypto";
import { parseRetryAfter } from "./http";

export interface WireResponse {
  status: number;
  body: unknown;
  retryAfter?: string | null;
}

/** How bytes reach intake. Production uses HTTP; tests call the platform's handlers directly. */
export interface Transport {
  send(method: "POST" | "GET", path: string, headers: Record<string, string>, body?: Buffer): Promise<WireResponse>;
}

export function httpTransport(baseUrl: string, fetcher: typeof fetch = fetch): Transport {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async send(method, path, headers, body) {
      const res = await fetcher(`${base}${path}`, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, body: json, retryAfter: res.headers.get("retry-after") };
    },
  };
}

export type SubmitOutcome =
  | { kind: "accepted"; httpStatus: number; receiptStatus: string; reasonCode: string | null }
  | { kind: "retry"; error: string }
  | { kind: "rate_limited"; afterSec: number }
  | { kind: "revision_conflict" }
  | { kind: "source_refused"; code: string; message: string }
  | { kind: "park"; httpStatus: number; code: string; message: string }
  | { kind: "fatal"; code: string; message: string };

interface ApiBody {
  status?: string;
  reason_code?: string;
  code?: string;
  message?: string;
  field_errors?: { field: string; message: string }[];
}

export class IngestClient {
  private readonly clock: () => Date;

  constructor(private readonly o: { key: string; secret: string; transport: Transport; clock?: () => Date }) {
    this.clock = o.clock ?? (() => new Date());
  }

  private auth(eventId: string, body: Buffer): Record<string, string> {
    const timestamp = String(Math.floor(this.clock().getTime() / 1000));
    return { "X-Producer-Key": this.o.key, "X-Timestamp": timestamp, "X-Signature": signRequest(this.o.secret, timestamp, eventId, body) };
  }

  async submit(eventId: string, body: Buffer): Promise<SubmitOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: WireResponse;
      try {
        res = await this.o.transport.send("POST", "/api/v1/ingest/events", { "Content-Type": "application/json", "Idempotency-Key": eventId, ...this.auth(eventId, body) }, body);
      } catch (e) {
        return { kind: "retry", error: `network: ${(e as Error).message}` };
      }
      const b = (res.body ?? {}) as ApiBody;
      if (res.status === 200 || res.status === 202) return { kind: "accepted", httpStatus: res.status, receiptStatus: b.status ?? "accepted", reasonCode: b.reason_code ?? null };
      const code = b.code ?? `HTTP_${res.status}`;
      const message = [b.message, ...(b.field_errors ?? []).map((f) => `${f.field}: ${f.message}`)].filter(Boolean).join("; ") || `HTTP ${res.status}`;
      // A fresh timestamp fixes a request that sat in a queue; a second skew means our clock is wrong.
      if (res.status === 401 && code === "TIMESTAMP_SKEW" && attempt === 0) continue;
      if (res.status === 401) return { kind: "fatal", code, message };
      if (res.status === 429) return { kind: "rate_limited", afterSec: parseRetryAfter(res.retryAfter) ?? 60 };
      if (res.status === 409 && code === "REVISION_CONFLICT") return { kind: "revision_conflict" };
      if (res.status === 403) return { kind: "source_refused", code, message };
      if (res.status >= 500 || res.status === 408) return { kind: "retry", error: `${res.status} ${code}` };
      return { kind: "park", httpStatus: res.status, code, message };
    }
    return { kind: "fatal", code: "CLOCK_SKEW", message: "Intake rejected two fresh timestamps. Check this machine's clock." };
  }

  async receipt(eventId: string): Promise<{ ok: true; status: string; reasonCode: string | null } | { ok: false; error: string }> {
    try {
      const res = await this.o.transport.send("GET", `/api/v1/ingest/events/${eventId}`, this.auth(eventId, Buffer.alloc(0)));
      const b = (res.body ?? {}) as ApiBody;
      if (res.status === 200 && b.status) return { ok: true, status: b.status, reasonCode: b.reason_code ?? null };
      return { ok: false, error: `${res.status} ${b.code ?? ""}`.trim() };
    } catch (e) {
      return { ok: false, error: `network: ${(e as Error).message}` };
    }
  }
}
