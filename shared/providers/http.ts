export class ProviderError extends Error {
  readonly statusCode?: number;
  readonly errorType?: string;
  readonly accountStatus?: string;
  readonly route: string;
  readonly temporary: boolean;

  constructor(route: string, message: string, extra: {
    statusCode?: number;
    errorType?: string;
    accountStatus?: string;
    temporary?: boolean;
  } = {}) {
    super(message);
    this.name = "ProviderError";
    this.route = route;
    this.statusCode = extra.statusCode;
    this.errorType = extra.errorType;
    this.accountStatus = extra.accountStatus;
    this.temporary = extra.temporary ?? false;
  }
}

export interface HttpResponse {
  status: number;
  text: string;
  json: unknown;
}

export type HttpClient = (url: string, init: RequestInit) => Promise<HttpResponse>;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ProviderError(name, `${name} is not set`);
  return value;
}

export const liveHttp: HttpClient = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
