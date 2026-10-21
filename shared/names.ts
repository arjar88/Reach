const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "sir", "madam", "mx"]);
const CREDENTIALS = new Set([
  "cissp", "phd", "mba", "cpa", "pmp", "md", "esq", "jr", "sr", "ii", "iii", "iv", "cissp,",
]);

function stripEmoji(value: string): string {
  return value.replace(/\p{Extended_Pictographic}/gu, " ").replace(/\uFE0F/g, " ");
}

function titleCase(token: string): string {
  const lower = token.toLocaleLowerCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

/** First-name cleaner. "Dr. DAVID 🔒 | CISSP" → "David". "maria lópez" → "Maria". */
export function cleanFirstName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const head = stripEmoji(raw.split("|")[0] ?? "");
  const tokens = head.split(/[\s,;/]+/).map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const bare = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (!bare) continue;
    const key = bare.toLocaleLowerCase().replace(/\.$/, "");
    if (TITLES.has(key) || CREDENTIALS.has(key)) continue;
    if (bare.length < 2) continue;
    return titleCase(bare);
  }
  return null;
}
