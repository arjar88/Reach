import { config } from "./config.js";

export function heartbeatIsStale(lastSeen: Date | null, now = new Date(), staleMinutes = config.health.heartbeatStaleMinutes): boolean {
  if (!lastSeen) return true;
  return now.getTime() - lastSeen.getTime() > staleMinutes * 60_000;
}

export async function alertIfHeartbeatStale(opts: {
  lastSeen: Date | null;
  now?: Date;
  email?: string | null;
  send: (input: { to: string; subject: string; text: string }) => Promise<void>;
}): Promise<{ stale: boolean; alerted: boolean; reason?: string }> {
  const now = opts.now ?? new Date();
  if (!heartbeatIsStale(opts.lastSeen, now)) return { stale: false, alerted: false };
  if (!opts.email) return { stale: true, alerted: false, reason: "OPS_ALERT_EMAIL is not set" };
  const when = opts.lastSeen ? opts.lastSeen.toISOString() : "never";
  await opts.send({
    to: opts.email,
    subject: "Reach worker heartbeat is stale",
    text: `The worker heartbeat is stale. Last seen: ${when}.`,
  });
  return { stale: true, alerted: true };
}
