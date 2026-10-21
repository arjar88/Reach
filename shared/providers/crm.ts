import { liveHttp, type HttpClient } from "./http.js";

export async function createCrmNote(opts: {
  provider: "hubspot" | "pipedrive";
  apiKey: string;
  email: string | null;
  body: string;
}, http: HttpClient = liveHttp): Promise<void> {
  if (opts.provider === "hubspot") {
    const response = await http("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ properties: { hs_note_body: opts.body, hs_timestamp: new Date().toISOString() } }),
    });
    if (response.status >= 400) throw new Error(`HubSpot note failed (${response.status})`);
    return;
  }
  const response = await http(`https://api.pipedrive.com/v1/notes?api_token=${encodeURIComponent(opts.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: opts.body, person_id: undefined }),
  });
  if (response.status >= 400) throw new Error(`Pipedrive note failed (${response.status})`);
}
