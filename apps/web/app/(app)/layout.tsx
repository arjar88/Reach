import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { signOut } from "../(auth)/actions";
import { requireOrg } from "./org";

export default async function AppLayout({ children }: { children: ReactNode }) {
  let email = "";
  try {
    email = (await requireOrg()).email;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Supabase is not configured") {
      return (
        <main>
          <h1>Reach</h1>
          <p role="alert">Supabase is not configured.</p>
        </main>
      );
    }
    redirect("/sign-in");
  }
  return (
    <div className="shell">
      <nav className="nav">
        <strong>Reach</strong>
        <a href="/onboarding">Onboarding</a>
        <a href="/agents">Agents</a>
        <a href="/leads">Leads</a>
        <a href="/accounts">Accounts</a>
        <a href="/campaigns">Campaigns</a>
        <a href="/inbox">Inbox</a>
        <a href="/dashboard">Dashboard</a>
        <a href="/settings">Settings</a>
        <span className="meta">{email}</span>
        <form action={signOut}>
          <button className="ghost" type="submit">Sign out</button>
        </form>
      </nav>
      {children}
    </div>
  );
}
