"use server";

import { redirect } from "next/navigation";
import { applyProfileOptOut } from "../../../../shared/inbox/compliance.js";
import { normalizeProfileUrl } from "../../../../shared/profiles.js";
import { createResend } from "../../../../shared/providers/resend.js";
import { signOptOutConfirm } from "../../../../shared/signing.js";
import { getDb } from "../../lib/db";
import { limitPublic } from "../../lib/public";

function fail(message: string): never {
  redirect(`/optout?error=${encodeURIComponent(message)}`);
}

export async function submitOptOut(form: FormData): Promise<void> {
  await limitPublic();
  const linkedin = String(form.get("linkedin") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (linkedin) {
    if (!normalizeProfileUrl(linkedin)) fail("Enter a LinkedIn profile URL");
    const { db } = getDb();
    await applyProfileOptOut(db, linkedin);
    redirect("/optout?done=profile");
  }
  if (!email) fail("Enter a LinkedIn profile URL or an email address");
  if (!process.env.RESEND_API_KEY) fail("Email confirmation is not configured. Set RESEND_API_KEY.");
  const token = signOptOutConfirm({ email });
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  await createResend().send({
    to: email,
    subject: "Confirm your Reach opt-out",
    text: `Confirm you want to opt out: ${appUrl}/optout/confirm?token=${encodeURIComponent(token)}`,
  });
  redirect("/optout?done=email");
}
