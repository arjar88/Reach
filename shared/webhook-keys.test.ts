import { describe, expect, it } from "vitest";
import { bullId, messageEventKey, stripeKey, unipileKey } from "./webhook-keys.js";

describe("webhook keys", () => {
  it("prefixes dedupe keys by source", () => {
    expect(unipileKey(["message", "abc"])).toBe("unipile:message:abc");
    expect(stripeKey("evt_1")).toBe("stripe:evt_1");
    expect(messageEventKey("m1")).toBe("unipile:message:m1");
  });

  it("turns colons into hyphens for BullMQ ids", () => {
    expect(bullId("unipile:message:abc")).toBe("unipile-message-abc");
    expect(bullId(stripeKey("evt_1"))).not.toContain(":");
  });
});
