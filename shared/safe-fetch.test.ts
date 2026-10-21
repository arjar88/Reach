import { describe, expect, it } from "vitest";
import { isBlockedIp, safeFetch, type FetchImpl } from "./safe-fetch.js";

const okFetch: FetchImpl = async () => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode("hello from the public web"),
});

describe("safeFetch", () => {
  it("refuses private, loopback, link-local, and metadata addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.1.2.3")).toBe(true);
    expect(isBlockedIp("192.168.1.4")).toBe(true);
    expect(isBlockedIp("172.16.0.5")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
  });

  it("refuses those hosts before reading a body", async () => {
    await expect(safeFetch("http://127.0.0.1/", {
      lookup: async () => ["127.0.0.1"],
      fetchImpl: okFetch,
      timeoutMs: 200,
    })).rejects.toThrow(/Blocked/);
    await expect(safeFetch("http://metadata.google.internal/computeMetadata/v1/", {
      lookup: async () => ["169.254.169.254"],
      fetchImpl: okFetch,
      timeoutMs: 200,
    })).rejects.toThrow(/Blocked/);
    await expect(safeFetch("ftp://1.1.1.1/file", {
      lookup: async () => ["1.1.1.1"],
      fetchImpl: okFetch,
      timeoutMs: 200,
    })).rejects.toThrow(/http/);
  });

  it("re-checks every redirect", async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.hostname === "ok.test") {
        return { status: 302, headers: { location: "http://169.254.169.254/latest" }, body: new Uint8Array() };
      }
      return { status: 200, headers: {}, body: new TextEncoder().encode("nope") };
    };
    await expect(safeFetch("http://ok.test/start", {
      lookup: async (host) => host === "ok.test" ? ["1.1.1.1"] : ["169.254.169.254"],
      fetchImpl,
      timeoutMs: 200,
    })).rejects.toThrow(/Blocked/);
  });

  it("caps size and time", async () => {
    const big: FetchImpl = async () => ({ status: 200, headers: {}, body: new Uint8Array(50) });
    await expect(safeFetch("http://ok.test/", {
      lookup: async () => ["1.1.1.1"],
      fetchImpl: big,
      maxBytes: 10,
      timeoutMs: 200,
    })).rejects.toThrow(/2MB|exceeds/);
    const hung: FetchImpl = () => new Promise(() => {});
    await expect(safeFetch("http://ok.test/", {
      lookup: async () => ["1.1.1.1"],
      fetchImpl: hung,
      timeoutMs: 30,
    })).rejects.toThrow(/Timed out/);
  });

  it("returns text from a public address", async () => {
    const result = await safeFetch("https://ok.test/about", {
      lookup: async () => ["1.1.1.1"],
      fetchImpl: okFetch,
      timeoutMs: 200,
    });
    expect(result.text).toContain("public web");
    expect(result.status).toBe(200);
  });
});
