import { config } from "./config.js";

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\{[a-z_]+\}|\[[A-Za-z][A-Za-z0-9 _-]{0,40}\]/;

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "you", "your", "for", "with", "this", "that", "to", "of"],
  fr: ["vous", "pour", "avec", "une", "les", "des", "bonjour", "je"],
  es: ["usted", "para", "con", "una", "hola", "que", "los"],
  de: ["und", "sie", "für", "mit", "ich", "hallo", "das"],
  he: [],
};

export interface CheckInput {
  kind: "invite" | "message" | "email";
  body: string;
  subject?: string;
  template?: string;
  language: string;
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;]+$/, "").toLowerCase());
}

function countWords(text: string, words: string[]): number {
  const tokens = text.toLocaleLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const set = new Set(words);
  return tokens.filter((t) => set.has(t)).length;
}

function languageMatches(body: string, language: string): boolean {
  const lang = language.toLowerCase();
  const hebrew = (body.match(/[\u0590-\u05FF]/g) ?? []).length;
  const letters = (body.match(/\p{L}/gu) ?? []).length || 1;
  if (lang === "he") return hebrew / letters > 0.3;
  if (hebrew / letters > 0.2) return false;
  const target = STOPWORDS[lang];
  if (!target || target.length === 0) return true;
  const targetHits = countWords(body, target);
  let otherHits = 0;
  for (const [code, words] of Object.entries(STOPWORDS)) {
    if (code === lang || words.length === 0) continue;
    otherHits += countWords(body, words);
  }
  if (targetHits === 0 && otherHits >= 2) return false;
  if (otherHits > targetHits && otherHits >= 2) return false;
  return true;
}

export function checkMessage(input: CheckInput): CheckResult {
  const body = input.body?.trim() ?? "";
  if (!body) return { ok: false, reason: "empty" };
  const limit = input.kind === "invite"
    ? config.linkedin.inviteNoteMax
    : input.kind === "email"
      ? config.email.bodyMax
      : config.linkedin.messageMax;
  if (body.length > limit) return { ok: false, reason: `longer than ${limit}` };
  if (input.kind === "email") {
    const subject = input.subject?.trim() ?? "";
    if (subject.length > config.email.subjectMax) return { ok: false, reason: "subject too long" };
  }
  if (PLACEHOLDER_RE.test(body) || (input.subject && PLACEHOLDER_RE.test(input.subject))) {
    return { ok: false, reason: "placeholder" };
  }
  const allowed = new Set(urlsIn(input.template ?? ""));
  const found = [...urlsIn(body), ...urlsIn(input.subject ?? "")];
  for (const url of found) {
    if (!allowed.has(url)) return { ok: false, reason: "link" };
  }
  if (!languageMatches(body, input.language || "en")) return { ok: false, reason: "language" };
  return { ok: true };
}

export function fillTemplate(
  template: string,
  contact: { firstName?: string | null; company?: string | null; title?: string | null },
): { body: string; usedFallback: boolean } {
  let missing = false;
  const body = template.replace(/\{(first_name|company|title)\}/g, (_m, key: string) => {
    const value = key === "first_name" ? contact.firstName : key === "company" ? contact.company : contact.title;
    if (!value) {
      missing = true;
      return "";
    }
    return value;
  });
  if (missing || !body.trim()) {
    const name = contact.firstName?.trim() || "there";
    return { body: `Hi ${name}, I wanted to reach out.`, usedFallback: true };
  }
  return { body, usedFallback: false };
}
