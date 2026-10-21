import { afterEach, describe, expect, it } from "vitest";
import { modelConfigured, modelProvider } from "./model.js";

const KEYS = ["LLM_PROVIDER", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearKeys() {
  for (const key of KEYS) delete process.env[key];
}

describe("model provider", () => {
  it("prefers a Gemini key over Anthropic when no provider is set", () => {
    clearKeys();
    process.env.GEMINI_API_KEY = "gemini";
    process.env.ANTHROPIC_API_KEY = "anthropic";
    expect(modelProvider()).toBe("google");
    expect(modelConfigured()).toBe(true);
  });

  it("uses Anthropic when that is the only key", () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = "anthropic";
    expect(modelProvider()).toBe("anthropic");
  });

  it("follows LLM_PROVIDER when that provider's key is set", () => {
    clearKeys();
    process.env.LLM_PROVIDER = "gateway";
    process.env.AI_GATEWAY_API_KEY = "gateway";
    process.env.GEMINI_API_KEY = "gemini";
    expect(modelProvider()).toBe("gateway");
  });

  it("is not configured when no key is set", () => {
    clearKeys();
    expect(modelConfigured()).toBe(false);
    expect(() => modelProvider()).toThrow(/GEMINI_API_KEY/);
  });
});
