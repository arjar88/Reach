import { submitOptOut } from "./actions";

export default async function OptOutPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const params = await searchParams;
  return (
    <main>
      <h1>Opt out</h1>
      <p>A LinkedIn URL is removed everywhere now. An email address needs a confirmation link first.</p>
      {params.error ? <p className="error">{params.error}</p> : null}
      {params.done === "profile" ? <p>That profile was opted out.</p> : null}
      {params.done === "email" ? <p>Check your inbox to confirm the opt-out.</p> : null}
      <form action={submitOptOut}>
        <label>
          LinkedIn profile URL
          <input name="linkedin" type="url" placeholder="https://www.linkedin.com/in/…" />
        </label>
        <label>
          Email
          <input name="email" type="email" placeholder="you@example.com" />
        </label>
        <button type="submit">Opt out</button>
      </form>
    </main>
  );
}
