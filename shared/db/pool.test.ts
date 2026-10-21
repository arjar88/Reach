import { describe, expect, it } from "vitest";
import { poolConfig } from "./client.js";

describe("poolConfig", () => {
  it("uses prepare false on the web and max 8 on the worker", () => {
    expect(poolConfig("web")).toEqual({ max: 10, prepare: false });
    expect(poolConfig("worker")).toEqual({ max: 8, prepare: true });
  });
});
