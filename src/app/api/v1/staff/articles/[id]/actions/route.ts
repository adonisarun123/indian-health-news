import { getDb } from "@/db/client";
import { performAction } from "@/core/articles";
import { staffApi } from "@/lib/staff-api";

/** POST /api/v1/staff/articles/{id}/actions — submit, approve, schedule, publish, correct, retract, remove. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return staffApi(request, (staff, body) => performAction(getDb(), staff, id, body, new Date()));
}
