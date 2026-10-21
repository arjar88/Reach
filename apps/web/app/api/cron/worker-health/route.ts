import { alertIfHeartbeatStale, createDb, heartbeatIsStale, readHeartbeat } from "@reach/shared";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL_SESSION;
  if (!url) return Response.json({ error: "DATABASE_URL_POOLED is not set" }, { status: 503 });
  const { sql } = createDb(url, "web");
  try {
    const lastSeen = await readHeartbeat(sql);
    const email = process.env.OPS_ALERT_EMAIL;
    const hasResend = Boolean(process.env.RESEND_API_KEY);
    if (!hasResend) {
      const stale = heartbeatIsStale(lastSeen);
      if (stale) {
        return Response.json({ stale: true, alerted: false, error: "RESEND_API_KEY is not set" }, { status: 503 });
      }
    }
    const result = await alertIfHeartbeatStale({
      lastSeen,
      email,
      send: async (input) => {
        if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
        const { createResend } = await import("@reach/shared/providers/resend");
        await createResend().send(input);
      },
    });
    if (result.stale && !result.alerted) return Response.json(result, { status: 503 });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "alert failed";
    return Response.json({ stale: true, alerted: false, error: message }, { status: 503 });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
