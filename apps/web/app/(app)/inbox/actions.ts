"use server";

import { redirect } from "next/navigation";
import { queueManualReply } from "../../../../../shared/inbox/reply.js";
import { requireOrg } from "../../../lib/session";

export async function sendReply(form: FormData): Promise<void> {
  const { db, orgId } = await requireOrg();
  const channel = String(form.get("channel") ?? "");
  if (channel !== "linkedin" && channel !== "email") throw new Error("Choose LinkedIn or email");
  const result = await queueManualReply(db, orgId, {
    contactId: String(form.get("contactId") ?? ""),
    channel,
    body: String(form.get("body") ?? ""),
    subject: String(form.get("subject") ?? "") || undefined,
    linkedinSeatId: String(form.get("linkedinSeatId") ?? "") || null,
    emailSeatId: String(form.get("emailSeatId") ?? "") || null,
  });
  if ("error" in result) throw new Error(result.error);
  redirect(`/inbox?queued=${result.jobId}`);
}
