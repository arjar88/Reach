"use client";

import { useActionState } from "react";
import { signUp } from "../actions";

export default function SignUpPage() {
  const [state, action, pending] = useActionState(signUp, null);
  return (
    <main>
      <h1>Create an account</h1>
      <form action={action}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="new-password" required minLength={8} />
        </label>
        {state?.error ? <p role="alert">{state.error}</p> : null}
        <button disabled={pending} type="submit">Sign up</button>
      </form>
      <p><a href="/sign-in">Already have an account</a></p>
    </main>
  );
}
