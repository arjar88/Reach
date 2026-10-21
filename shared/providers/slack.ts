import { liveHttp, type HttpClient } from "./http.js";

export async function postSlack(webhookUrl: string, text: string, http: HttpClient = liveHttp): Promise<void> {
  const response = await http(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (response.status >= 400) throw new Error(`Slack webhook failed (${response.status})`);
}
