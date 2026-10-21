/**
 * Stated headline rule, used everywhere a person is filtered:
 * drop freelancers and open-to-work profiles. This is the only pattern.
 */
const FREELANCER = /\b(freelancers?|freelance|open[\s-]?to[\s-]?work|#opentowork)\b/i;

export function isFreelancerOrOpenToWork(headline: string | null | undefined): boolean {
  if (!headline) return false;
  return FREELANCER.test(headline);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Excluded names match case-insensitively on "at X" and "@ X", with a word boundary.
 * "cat Acme" does not match "Acme". "at Acme" and "@Acme" do.
 */
export function headlineHasExcludedName(headline: string | null | undefined, names: string[]): boolean {
  if (!headline || names.length === 0) return false;
  const text = headline.normalize("NFKC");
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const pattern = new RegExp(`(?:\\bat\\s+|@\\s*)${escapeRegExp(trimmed)}\\b`, "i");
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Keywords move the score. They never drop a person. */
export function keywordBump(text: string, keywords: string[], bump: number): number {
  if (!text || keywords.length === 0 || bump <= 0) return 0;
  const hay = text.toLocaleLowerCase();
  let extra = 0;
  for (const keyword of keywords) {
    const k = keyword.trim().toLocaleLowerCase();
    if (!k) continue;
    if (hay.includes(k)) extra += bump;
  }
  return extra;
}
