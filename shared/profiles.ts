import type { SignalType } from "./config.js";

export function normalizeProfileUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => p.toLowerCase() === "in");
  if (idx < 0 || !parts[idx + 1]) return null;
  let slug = parts[idx + 1]!;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  slug = slug.toLowerCase().replace(/\/+$/, "");
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function normalizeCompanyKey(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    if (!candidate.includes("linkedin.")) return candidate.toLowerCase();
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p.toLowerCase() === "company");
    if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]!).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
  return raw.toLowerCase();
}

export function signalKey(type: SignalType, value: string): string {
  if (type === "keyword") return `keyword:${value.trim().toLowerCase()}`;
  if (type === "company_page") {
    const key = normalizeCompanyKey(value);
    if (!key) throw new Error("Company page signal needs a company URL or id");
    return `company_page:${key}`;
  }
  const profile = normalizeProfileUrl(value);
  if (!profile) throw new Error("Influencer signal needs a LinkedIn profile URL");
  return `influencer:${profile}`;
}

export function isBlockedCountry(country: string | null | undefined, blocked: readonly string[]): boolean {
  if (!country) return false;
  const value = country.trim().toUpperCase();
  return blocked.some((entry) => entry.toUpperCase() === value);
}
