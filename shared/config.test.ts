import { describe, expect, it } from "vitest";
import { config } from "./config.js";

describe("config", () => {
  it("keeps the worker pool at 8 and has no feature flags", () => {
    expect(config.workerPoolMax).toBe(8);
    expect("featureFlags" in config).toBe(false);
  });

  it("stores ceilings the seat settings cannot exceed", () => {
    expect(config.linkedin.dailyInvites).toBe(15);
    expect(config.linkedin.weeklyInvites).toBe(80);
    expect(config.linkedin.acceptanceSample).toBe(100);
    expect(config.email.blockedCountries).toContain("IL");
  });
});
