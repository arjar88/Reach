import type { ZodType } from "zod";
import { models } from "../config.js";
import { ModelOutputError, parseModelJson, withOneRetry } from "../signals/scoring.js";
import { asRecord, liveHttp, requireEnv, type HttpClient } from "./http.js";

export interface ClaudeClient {
  complete(model: "small" | "strong", system: string, user: string): Promise<string>;
  json<T>(model: "small" | "strong", system: string, user: string, schema: ZodType<T>): Promise<T>;
}

export function createClaude(http: HttpClient = liveHttp): ClaudeClient {
  const ids = models();
  return {
    async complete(model, system, user) {
      const key = requireEnv("ANTHROPIC_API_KEY");
      const response = await http("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model === "small" ? ids.small : ids.strong,
          max_tokens: 2000,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (response.status >= 400) throw new Error(`Claude failed (${response.status})`);
      const body = asRecord(response.json);
      const content = Array.isArray(body.content) ? body.content : [];
      const text = content.map((part) => pickText(part)).join("");
      if (!text) throw new ModelOutputError("Empty model response");
      return text;
    },
    async json(model, system, user, schema) {
      return withOneRetry(async () => parseModelJson(await this.complete(model, system, user), schema));
    },
  };
}

function pickText(part: unknown): string {
  const row = asRecord(part);
  return typeof row.text === "string" ? row.text : "";
}
