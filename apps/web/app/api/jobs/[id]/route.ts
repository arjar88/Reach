import { readJobForOrg } from "@reach/shared";
import { requireOrg } from "../../../(app)/org";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, orgId } = await requireOrg();
    const { id } = await context.params;
    const job = await readJobForOrg(db, orgId, id);
    if (!job) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ id: job.id, status: job.status, result: job.result, error: job.error });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unauthorized";
    const status = message === "Sign in required" || message === "Supabase is not configured" ? 401 : 500;
    return Response.json({ error: message }, { status });
  }
}
