import type { ReactNode } from "react";

const nav = [
  ["/onboarding", "Onboarding"],
  ["/agents", "Agents"],
  ["/leads", "Leads"],
  ["/accounts", "Accounts"],
  ["/campaigns", "Campaigns"],
  ["/inbox", "Inbox"],
  ["/dashboard", "Dashboard"],
  ["/settings", "Settings"],
];

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ fontFamily: "Georgia, serif", background: "#f4f1ea", color: "#1c1915", minHeight: "100vh" }}>
      <header style={{ display: "flex", gap: 16, alignItems: "baseline", padding: "20px 28px", borderBottom: "1px solid #e2dcd0" }}>
        <strong style={{ letterSpacing: "0.08em" }}>REACH</strong>
        <nav style={{ display: "flex", gap: 12, fontFamily: "ui-sans-serif, system-ui", fontSize: 14 }}>
          {nav.map(([href, label]) => (
            <a key={href} href={href} style={{ color: "#0f6e56" }}>{label}</a>
          ))}
        </nav>
      </header>
      <section style={{ padding: "28px", maxWidth: 980 }}>
        <h1 style={{ fontWeight: 500, fontSize: 32, marginTop: 0 }}>{title}</h1>
        {children}
      </section>
    </main>
  );
}

export const fieldStyle = { display: "grid", gap: 6, marginBottom: 12, fontFamily: "ui-sans-serif, system-ui", fontSize: 14 };
export const inputStyle = { padding: "8px 10px", border: "1px solid #cfc6b8", background: "#fff", font: "inherit" };
export const buttonStyle = { background: "#0f6e56", color: "#fff", border: 0, padding: "8px 14px", cursor: "pointer" };
