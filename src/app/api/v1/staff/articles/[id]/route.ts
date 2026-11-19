import { getDb } from "@/db/client";
import { patchArticle } from "@/core/articles";
import { staffApi } from "@/lib/staff-api";

/** PATCH /api/v1/staff/articles/{id} — save a new version. Requires expectedVersion. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return staffApi(request, (staff, body) => patchArticle(getDb(), staff, id, body, new Date()));
}
