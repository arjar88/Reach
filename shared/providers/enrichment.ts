import { asRecord, liveHttp, pickString, requireEnv, type HttpClient } from "./http.js";

export interface EnrichInput {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  domain: string | null;
}

export interface EnrichmentClient {
  findEmail(input: EnrichInput): Promise<string | null>;
  verify(email: string): Promise<boolean>;
}

async function postJson(http: HttpClient, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await http(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (response.status >= 400) return null;
  return response.json;
}

export function createEnrichment(http: HttpClient = liveHttp): EnrichmentClient {
  return {
    async findEmail(input) {
      const prospeo = process.env.PROSPEO_API_KEY;
      const leadmagic = process.env.LEADMAGIC_API_KEY;
      const icypeas = process.env.ICYPEAS_API_KEY;
      if (prospeo) {
        const json = asRecord(await postJson(http, "https://api.prospeo.io/email-finder", { "X-KEY": prospeo }, {
          first_name: input.firstName,
          last_name: input.lastName,
          company: input.domain ?? input.company,
        }));
        const email = pickString(asRecord(json.response), ["email"]) ?? pickString(json, ["email"]);
        if (email) return email;
      }
      if (leadmagic) {
        const json = asRecord(await postJson(http, "https://api.leadmagic.io/email-finder", { "X-API-Key": leadmagic }, {
          first_name: input.firstName,
          last_name: input.lastName,
          domain: input.domain,
          company_name: input.company,
        }));
        const email = pickString(json, ["email"]);
        if (email) return email;
      }
      if (icypeas) {
        const json = asRecord(await postJson(http, "https://app.icypeas.com/api/email-search", { Authorization: icypeas }, {
          firstname: input.firstName,
          lastname: input.lastName,
          domainOrCompany: input.domain ?? input.company,
        }));
        const email = pickString(json, ["email"]) ?? pickString(asRecord(json.data), ["email"]);
        if (email) return email;
      }
      if (!prospeo && !leadmagic && !icypeas) requireEnv("PROSPEO_API_KEY");
      return null;
    },
    async verify(email) {
      const key = requireEnv("MILLIONVERIFIER_API_KEY");
      const response = await http(`https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=10`, { method: "GET" });
      const json = asRecord(response.json);
      return json.resultcode === 1 || pickString(json, ["result"]) === "ok";
    },
  };
}
