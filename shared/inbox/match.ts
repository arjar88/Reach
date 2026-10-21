export interface KnownContact {
  id: string;
  providerId: string | null;
  email: string | null;
  status: string;
  linkedinChatId: string | null;
}

export function findLinkedInContact(contacts: KnownContact[], attendeeProviderId: string | null): KnownContact | null {
  if (!attendeeProviderId) return null;
  return contacts.find((c) => c.providerId === attendeeProviderId) ?? null;
}

export function isOwnerSender(ownerProviderId: string | null, senderProviderId: string | null): boolean {
  return Boolean(ownerProviderId && senderProviderId && ownerProviderId === senderProviderId);
}

export function isAutoReply(headers: Record<string, string | undefined> | null | undefined): boolean {
  if (!headers) return false;
  const entries = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), (v ?? "").toLowerCase()] as const);
  for (const [key, value] of entries) {
    if (key === "auto-submitted" && value && value !== "no") return true;
    if (key === "x-autoreply" || key === "x-autorespond") return true;
    if (key === "precedence" && (value.includes("auto") || value.includes("bulk") || value.includes("junk"))) return true;
  }
  return false;
}

export function isBounce(from: string | null | undefined, subject: string | null | undefined): boolean {
  const address = (from ?? "").toLowerCase();
  const title = (subject ?? "").toLowerCase();
  if (address.includes("mailer-daemon") || address.includes("postmaster")) return true;
  if (title.includes("delivery status notification") || title.includes("undeliverable")) return true;
  return false;
}

export function matchEmailContact(opts: {
  contacts: KnownContact[];
  inReplyTo: string | null;
  sender: string | null;
  actions: { emailMessageId: string | null; contactId: string }[];
}): KnownContact | null {
  if (opts.inReplyTo) {
    const action = opts.actions.find((a) => a.emailMessageId && a.emailMessageId === opts.inReplyTo);
    if (action) return opts.contacts.find((c) => c.id === action.contactId) ?? null;
  }
  const sender = opts.sender?.toLowerCase();
  if (!sender) return null;
  return opts.contacts.find((c) => c.email?.toLowerCase() === sender) ?? null;
}
