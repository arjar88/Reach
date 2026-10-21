import { describe, expect, it } from "vitest";
import { checkMessage, fillTemplate } from "./message-check.js";

const english = "Hello, I saw your post and wanted to talk with you about this.";

describe("checkMessage", () => {
  it("enforces invite, message, and email lengths", () => {
    expect(checkMessage({ kind: "invite", body: "a".repeat(300), language: "en" }).ok).toBe(true);
    expect(checkMessage({ kind: "invite", body: "a".repeat(301), language: "en" }).ok).toBe(false);
    expect(checkMessage({ kind: "message", body: "a".repeat(1900), language: "en" }).ok).toBe(true);
    expect(checkMessage({ kind: "message", body: "a".repeat(1901), language: "en" }).ok).toBe(false);
    expect(checkMessage({ kind: "email", body: "a".repeat(2000), language: "en", subject: "Hi" }).ok).toBe(true);
    expect(checkMessage({ kind: "email", body: "a".repeat(2001), language: "en", subject: "Hi" }).ok).toBe(false);
  });

  it("rejects links that are not in the template", () => {
    const blocked = checkMessage({ kind: "message", body: "See https://evil.example/a today", language: "en" });
    expect(blocked).toEqual({ ok: false, reason: "link" });
    const allowed = checkMessage({
      kind: "message",
      body: "See https://ok.example/a today with you",
      template: "Use https://ok.example/a",
      language: "en",
    });
    expect(allowed.ok).toBe(true);
  });

  it("rejects placeholders and empty text", () => {
    expect(checkMessage({ kind: "message", body: "Hi {{name}}", language: "en" })).toMatchObject({ ok: false, reason: "placeholder" });
    expect(checkMessage({ kind: "message", body: "Hi [Name]", language: "en" })).toMatchObject({ ok: false, reason: "placeholder" });
    expect(checkMessage({ kind: "message", body: "   ", language: "en" })).toMatchObject({ ok: false, reason: "empty" });
  });

  it("checks the campaign language", () => {
    expect(checkMessage({ kind: "message", body: english, language: "en" }).ok).toBe(true);
    const french = checkMessage({
      kind: "message",
      body: "Bonjour, je vous écris pour une démo avec votre équipe",
      language: "en",
    });
    expect(french).toEqual({ ok: false, reason: "language" });
  });
});

describe("fillTemplate", () => {
  it("uses fallback text when a field is missing", () => {
    const filled = fillTemplate("Hi {first_name} at {company}", { firstName: "Ada", company: null, title: null });
    expect(filled.usedFallback).toBe(true);
    expect(filled.body).toContain("Ada");
  });
});
