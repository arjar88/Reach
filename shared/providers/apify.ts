import { actors } from "../config.js";
import { normalizeProfileUrl } from "../profiles.js";
import { nextActorState, type ActorSwitchState } from "../signals/select.js";
import { asRecord, liveHttp, pickString, requireEnv, type HttpClient } from "./http.js";

export interface RawPost {
  postId: string;
  url: string | null;
  publishedAt: string;
  textPreview: string | null;
}

export interface RawEngager {
  profileUrl: string;
  name: string;
  headline: string;
  kind: "reaction" | "comment";
}

export interface NormalizedProfile {
  profileUrl: string;
  name: string | null;
  headline: string | null;
  title: string | null;
  company: string | null;
  companyLinkedinId: string | null;
  location: string | null;
  country: string | null;
  isPerson: boolean;
  scrapedId: string | null;
}

export interface NormalizedCompany {
  companyLinkedinId: string;
  name: string | null;
  domain: string | null;
  employeeRange: string | null;
  industry: string | null;
  hqCountry: string | null;
}

export interface CompanyCandidate {
  name: string;
  logo: string | null;
  followers: number | null;
  url: string;
  companyLinkedinId: string | null;
}

export interface ProfileCandidate {
  name: string;
  headline: string | null;
  url: string;
  followers: number | null;
}

export type ApifyKind = "posts" | "reactions" | "comments" | "profiles" | "companies" | "companySearch" | "profileSearch";

export interface ApifyClient {
  posts(input: { target: string; maxPosts: number }): Promise<RawPost[]>;
  reactions(postUrl: string): Promise<RawEngager[]>;
  comments(postUrl: string): Promise<RawEngager[]>;
  profiles(urls: string[]): Promise<NormalizedProfile[]>;
  companies(ids: string[]): Promise<NormalizedCompany[]>;
  searchCompanies(name: string): Promise<CompanyCandidate[]>;
  searchProfiles(name: string): Promise<ProfileCandidate[]>;
  actorState(): Record<ApifyKind, ActorSwitchState>;
  /** Kinds that switched from the primary actor to the backup. */
  switchedActors(): ApifyKind[];
}

function actorUrl(id: string, token: string): string {
  const act = id.replaceAll("/", "~");
  return `https://api.apify.com/v2/acts/${encodeURIComponent(act)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
}

/** Comment and reaction text is dropped here. Only the person and the kind are kept. */
export function toEngager(raw: unknown, kind: "reaction" | "comment"): RawEngager | null {
  const row = asRecord(raw);
  const url = normalizeProfileUrl(pickString(row, ["profileUrl", "profile_url", "linkedinUrl", "url", "profileLink"]));
  if (!url) return null;
  const author = asRecord(row.author);
  return {
    profileUrl: url,
    name: pickString(row, ["name", "fullName", "authorName"]) ?? pickString(author, ["name"]) ?? "",
    headline: pickString(row, ["headline", "occupation", "title"]) ?? pickString(author, ["headline"]) ?? "",
    kind,
  };
}

export function toProfile(raw: unknown): NormalizedProfile | null {
  const row = asRecord(raw);
  const url = normalizeProfileUrl(pickString(row, ["profileUrl", "linkedinUrl", "url", "profile_url"]));
  if (!url) return null;
  const type = (pickString(row, ["type", "entityType"]) ?? "").toLowerCase();
  return {
    profileUrl: url,
    name: pickString(row, ["name", "fullName"]),
    headline: pickString(row, ["headline", "occupation"]),
    title: pickString(row, ["title", "jobTitle"]),
    company: pickString(row, ["company", "companyName"]),
    companyLinkedinId: pickString(row, ["companyLinkedinId", "companyId"]),
    location: pickString(row, ["location", "geo"]),
    country: pickString(row, ["country", "countryCode"]),
    isPerson: type ? type === "person" || type === "profile" : true,
    scrapedId: pickString(row, ["id", "publicIdentifier", "entityUrn"]),
  };
}

function freshState(): Record<ApifyKind, ActorSwitchState> {
  const blank = (): ActorSwitchState => ({ active: "primary", consecutiveFailures: 0 });
  return {
    posts: blank(), reactions: blank(), comments: blank(), profiles: blank(),
    companies: blank(), companySearch: blank(), profileSearch: blank(),
  };
}

export function createApify(http: HttpClient = liveHttp, token = process.env.APIFY_TOKEN): ApifyClient {
  const ids = actors();
  const state = freshState();
  const switched: ApifyKind[] = [];
  async function runActor(actorId: string, input: unknown): Promise<unknown[]> {
    if (!token) requireEnv("APIFY_TOKEN");
    const response = await http(actorUrl(actorId, token!), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (response.status >= 400) throw new Error(`Apify ${actorId} failed (${response.status})`);
    return Array.isArray(response.json) ? response.json : [];
  }
  async function run(kind: ApifyKind, input: unknown): Promise<unknown[]> {
    const pair = ids[kind];
    const actorId = state[kind].active === "primary" ? pair.primary : pair.backup;
    try {
      const rows = await runActor(actorId, input);
      state[kind] = nextActorState(state[kind], "ok");
      return rows;
    } catch (error) {
      const next = nextActorState(state[kind], "fail");
      state[kind] = next;
      if (!next.switched) throw error;
      switched.push(kind);
      return runActor(pair.backup, input);
    }
  }
  return {
    actorState: () => structuredClone(state),
    switchedActors: () => [...switched],
    async posts(input) {
      const rows = await run("posts", { search: input.target, maxItems: input.maxPosts });
      return rows.map((raw) => {
        const row = asRecord(raw);
        return {
          postId: pickString(row, ["postId", "id", "urn", "url"]) ?? "",
          url: pickString(row, ["url", "postUrl"]),
          publishedAt: pickString(row, ["publishedAt", "postedAt", "date"]) ?? new Date().toISOString(),
          textPreview: null,
        };
      }).filter((p) => p.postId);
    },
    async reactions(postUrl) {
      const rows = await run("reactions", { postUrl, maxItems: 200 });
      return rows.map((row) => toEngager(row, "reaction")).filter((row): row is RawEngager => row !== null).slice(0, 200);
    },
    async comments(postUrl) {
      const rows = await run("comments", { postUrl, maxItems: 100 });
      return rows.map((row) => toEngager(row, "comment")).filter((row): row is RawEngager => row !== null).slice(0, 100);
    },
    async profiles(urls) {
      if (urls.length === 0) return [];
      const rows = await run("profiles", { profileUrls: urls });
      return rows.map(toProfile).filter((row): row is NormalizedProfile => row !== null);
    },
    async companies(companyIds) {
      if (companyIds.length === 0) return [];
      const rows = await run("companies", { companyIds });
      return rows.map((raw) => {
        const row = asRecord(raw);
        const id = pickString(row, ["companyLinkedinId", "id", "companyId"]);
        if (!id) return null;
        return {
          companyLinkedinId: id,
          name: pickString(row, ["name"]),
          domain: pickString(row, ["domain", "website"]),
          employeeRange: pickString(row, ["employeeRange", "staffCount"]),
          industry: pickString(row, ["industry"]),
          hqCountry: pickString(row, ["hqCountry", "country"]),
        } satisfies NormalizedCompany;
      }).filter((row): row is NormalizedCompany => row !== null);
    },
    async searchCompanies(name) {
      const rows = await run("companySearch", { search: name, maxItems: 3 });
      return rows.slice(0, 3).map((raw) => {
        const row = asRecord(raw);
        return {
          name: pickString(row, ["name"]) ?? name,
          logo: pickString(row, ["logo", "logoUrl"]),
          followers: typeof row.followers === "number" ? row.followers : null,
          url: pickString(row, ["url", "linkedinUrl"]) ?? "",
          companyLinkedinId: pickString(row, ["id", "companyId"]),
        };
      }).filter((row) => row.url);
    },
    async searchProfiles(name) {
      const rows = await run("profileSearch", { search: name, maxItems: 3 });
      return rows.slice(0, 3).map((raw) => {
        const row = asRecord(raw);
        const url = normalizeProfileUrl(pickString(row, ["url", "linkedinUrl", "profileUrl"]));
        if (!url) return null;
        return {
          name: pickString(row, ["name"]) ?? name,
          headline: pickString(row, ["headline"]),
          url,
          followers: typeof row.followers === "number" ? row.followers : null,
        };
      }).filter((row): row is ProfileCandidate => row !== null);
    },
  };
}
