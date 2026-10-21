"use client";

import { useActionState } from "react";
import { signIn } from "../actions";

export function SignInForm({ checkEmail }: { checkEmail: boolean }) {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <main>
      <h1>Sign in</h1>
      {checkEmail ? <p>Check your email to confirm the account, then sign in.</p> : null}
      <form action={action}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required minLength={8} />
        </label>
        {state?.error ? <p role="alert">{state.error}</p> : null}
        <button disabled={pending} type="submit">Sign in</button>
      </form>
      <p><a href="/sign-up">Create an account</a></p>
    </main>
  );
}
