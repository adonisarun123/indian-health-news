import { getDb } from "@/db/client";
import { CommandError } from "@/core/articles";
import { sourceAction, type SourceAction } from "@/core/sources";
import { staffApi } from "@/lib/staff-api";

const ACTIONS = ["trial", "enable", "pause", "revoke", "replay"];

/** POST /api/v1/staff/sources/{id}/actions — trial, enable, pause, revoke, replay (ADM-05). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return staffApi(request, (staff, body) => {
    const b = (body ?? {}) as { action?: string; reason?: string };
    if (!b.action || !ACTIONS.includes(b.action)) throw new CommandError(422, "VALIDATION_FAILED", "Unknown action.", { fieldErrors: [{ field: "action", code: "INVALID", message: `Use one of: ${ACTIONS.join(", ")}.` }] });
    return sourceAction(getDb(), staff, id, { action: b.action as SourceAction, reason: b.reason }, new Date());
  });
}
