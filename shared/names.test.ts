import { describe, expect, it } from "vitest";
import { cleanFirstName } from "./names.js";

describe("cleanFirstName", () => {
  it("drops titles, emoji, and credentials", () => {
    expect(cleanFirstName("Dr. DAVID 🔒 | CISSP")).toBe("David");
  });

  it("title-cases a lowercase first name and ignores the surname", () => {
    expect(cleanFirstName("maria lópez")).toBe("Maria");
  });

  it("returns null when nothing is left", () => {
    expect(cleanFirstName("Dr. | CISSP")).toBeNull();
    expect(cleanFirstName("")).toBeNull();
  });
});
