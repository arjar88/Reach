"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signIn(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const supabase = await createClient();
  if (!supabase) return { error: "Supabase is not configured" };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  redirect("/");
}

export async function signUp(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const supabase = await createClient();
  if (!supabase) return { error: "Supabase is not configured" };
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };
  redirect("/sign-in?check-email=1");
}

export async function signOut() {
  const supabase = await createClient();
  if (supabase) await supabase.auth.signOut();
  redirect("/sign-in");
}
