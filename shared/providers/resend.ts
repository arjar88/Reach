import { liveHttp, requireEnv, type HttpClient } from "./http.js";

export interface ResendClient {
  send(input: { to: string; subject: string; text: string; html?: string }): Promise<{ id: string | null }>;
}

export function createResend(http: HttpClient = liveHttp): ResendClient {
  return {
    async send(input) {
      const key = requireEnv("RESEND_API_KEY");
      const from = process.env.EMAIL_FROM ?? "Reach <noreply@example.com>";
      const response = await http("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text, html: input.html }),
      });
      if (response.status >= 400) throw new Error(`Resend failed (${response.status})`);
      const json = response.json as { id?: string } | null;
      return { id: json?.id ?? null };
    },
  };
}
