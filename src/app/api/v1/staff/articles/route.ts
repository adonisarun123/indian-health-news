import { getDb } from "@/db/client";
import { createArticle } from "@/core/articles";
import { staffApi } from "@/lib/staff-api";

/** POST /api/v1/staff/articles — create a draft (ADM-02). */
export function POST(request: Request): Promise<Response> {
  return staffApi(request, (staff, body) => createArticle(getDb(), staff, body, new Date()), 201);
}
