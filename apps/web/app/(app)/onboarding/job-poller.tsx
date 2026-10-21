"use client";

import { useEffect, useState } from "react";

export function JobPoller({ jobId, label }: { jobId: string; label: string }) {
  const [body, setBody] = useState<{ status?: string; result?: unknown; error?: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`);
        if (!response.ok) {
          if (!stop) setFailed(`Job status returned ${response.status}`);
          return;
        }
        const json = await response.json() as { status?: string; result?: unknown; error?: string | null };
        if (stop) return;
        setBody(json);
        if (json.status === "pending" || json.status === "running") timer = window.setTimeout(tick, 2000);
      } catch (error) {
        if (!stop) setFailed(error instanceof Error ? error.message : "Could not read the job");
      }
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  return (
    <article style={{ border: "1px solid #e2dcd0", padding: 12, margin: "12px 0", background: "#fff" }}>
      <strong>{label}</strong>
      <p style={{ fontFamily: "ui-sans-serif, system-ui", fontSize: 14 }}>
        {failed ?? body?.error ?? (body?.status ? `Status: ${body.status}` : "Waiting for the worker")}
      </p>
      {body?.result ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(body.result, null, 2)}</pre> : null}
    </article>
  );
}
