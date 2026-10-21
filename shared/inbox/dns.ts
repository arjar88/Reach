import { resolveTxt } from "node:dns/promises";

export interface DomainCheck {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

async function txt(name: string): Promise<string[]> {
  try {
    const rows = await resolveTxt(name);
    return rows.map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

/** SPF, a guessed DKIM selector, and DMARC. Missing records are a warning, not a block. */
export async function checkDomain(domain: string): Promise<DomainCheck> {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  const root = await txt(host);
  const spf = root.some((row) => row.toLowerCase().startsWith("v=spf1"));
  const dmarcRows = await txt(`_dmarc.${host}`);
  const dmarc = dmarcRows.some((row) => row.toLowerCase().includes("v=dmarc1"));
  const selectors = ["google", "selector1", "selector2", "k1", "default"];
  let dkim = false;
  for (const selector of selectors) {
    const rows = await txt(`${selector}._domainkey.${host}`);
    if (rows.some((row) => row.toLowerCase().includes("v=dkim1"))) {
      dkim = true;
      break;
    }
  }
  return { spf, dkim, dmarc };
}
