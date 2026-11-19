import { CommandError } from "@/core/articles";
import type { StaffSession } from "@/core/auth";
import { currentStaff, sameOrigin } from "./session";

/**
 * Wrapper for the versioned staff API (ADM-02, ADM-05). Session cookie, same
 * origin for every mutation, and the documented error shape: 409 carries the
 * current version, 422 carries field-level errors.
 */
export async function staffApi(request: Request, fn: (staff: StaffSession, body: unknown) => Promise<unknown>, okStatus = 200): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const staff = await currentStaff();
  if (!staff) return Response.json({ code: "UNAUTHENTICATED", message: "Sign in to the newsroom." }, { status: 401, headers });
  if (!(await sameOrigin())) return Response.json({ code: "CROSS_ORIGIN", message: "State changes must come from the newsroom itself." }, { status: 403, headers });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "MALFORMED_JSON", message: "Body is not valid JSON." }, { status: 400, headers });
  }
  try {
    return Response.json(await fn(staff, body), { status: okStatus, headers });
  } catch (e) {
    if (!(e instanceof CommandError)) throw e;
    return Response.json({ code: e.code, message: e.message, ...(e.extra.fieldErrors ? { field_errors: e.extra.fieldErrors } : {}), ...(e.extra.currentVersion !== undefined ? { current_version: e.extra.currentVersion } : {}) }, { status: e.status, headers });
  }
}
