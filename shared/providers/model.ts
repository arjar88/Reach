import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { ZodType } from "zod";
import { models } from "../config.js";
import { ModelOutputError, withOneRetry } from "../signals/scoring.js";
import { ProviderError } from "./http.js";

export type ModelSize = "small" | "strong";
export type ModelProviderName = "google" | "anthropic" | "gateway";

export interface ModelClient {
  complete(model: ModelSize, system: string, user: string): Promise<string>;
  json<T>(model: ModelSize, system: string, user: string, schema: ZodType<T>): Promise<T>;
}

const GOOGLE_DEFAULTS: Record<ModelSize, string> = {
  small: "gemini-2.5-flash",
  strong: "gemini-4-argon",
};

const GATEWAY_DEFAULTS: Record<ModelSize, string> = {
  small: "google/gemini-2.5-flash",
  strong: "google/gemini-4-argon",
};

function googleKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;
}

/** Which provider the next model call will use. Throws when no key is configured. */
export function modelProvider(): ModelProviderName {
  const explicit = process.env.LLM_PROVIDER?.trim();
  if (explicit === "google" || explicit === "anthropic" || explicit === "gateway") {
    if (explicit === "google" && !googleKey()) throw new ProviderError("GEMINI_API_KEY", "GEMINI_API_KEY is not set");
    if (explicit === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new ProviderError("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY is not set");
    if (explicit === "gateway" && !process.env.AI_GATEWAY_API_KEY) throw new ProviderError("AI_GATEWAY_API_KEY", "AI_GATEWAY_API_KEY is not set");
    return explicit;
  }
  if (googleKey()) return "google";
  if (process.env.AI_GATEWAY_API_KEY) return "gateway";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  throw new ProviderError("LLM", "Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or AI_GATEWAY_API_KEY");
}

export function modelConfigured(): boolean {
  try {
    modelProvider();
    return true;
  } catch {
    return false;
  }
}

function modelId(provider: ModelProviderName, size: ModelSize): string {
  const override = process.env[size === "small" ? "LLM_MODEL_SMALL" : "LLM_MODEL_STRONG"];
  if (override) return override;
  if (provider === "anthropic") return size === "small" ? models().small : models().strong;
  if (provider === "gateway") return GATEWAY_DEFAULTS[size];
  return GOOGLE_DEFAULTS[size];
}

function languageModel(size: ModelSize) {
  const provider = modelProvider();
  const id = modelId(provider, size);
  if (provider === "gateway") return id;
  if (provider === "google") {
    const key = googleKey();
    if (!key) throw new ProviderError("GEMINI_API_KEY", "GEMINI_API_KEY is not set");
    return createGoogle({ apiKey: key })(id);
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ProviderError("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY is not set");
  return createAnthropic({ apiKey: key })(id);
}

export function createModel(): ModelClient {
  return {
    async complete(size, system, user) {
      const result = await generateText({
        model: languageModel(size),
        instructions: system,
        prompt: user,
        maxOutputTokens: 2000,
      });
      if (!result.text) throw new ModelOutputError("Empty model response");
      return result.text;
    },
    async json(size, system, user, schema) {
      return withOneRetry(async () => {
        try {
          const result = await generateText({
            model: languageModel(size),
            instructions: system,
            prompt: user,
            maxOutputTokens: 2000,
            output: Output.object({ schema }),
          });
          return result.output;
        } catch (error) {
          if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
            throw new ModelOutputError(error instanceof Error ? error.message : "No model object");
          }
          throw error;
        }
      });
    },
  };
}
