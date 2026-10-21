/** Dedupe keys are prefixed by source. BullMQ ids cannot contain ":". */

export function unipileKey(parts: string[]): string {
  return `unipile:${parts.map((p) => p.trim()).filter(Boolean).join(":")}`;
}

export function stripeKey(eventId: string): string {
  return `stripe:${eventId.trim()}`;
}

export function bullId(dedupeKey: string): string {
  return dedupeKey.replaceAll(":", "-");
}

export function messageEventKey(messageId: string): string {
  return unipileKey(["message", messageId]);
}

export function relationEventKey(accountId: string, providerId: string): string {
  return unipileKey(["relation", accountId, providerId]);
}

export function accountStatusKey(accountId: string, status: string, at: string): string {
  return unipileKey(["account", accountId, status, at]);
}

export function mailEventKey(kind: string, id: string): string {
  return unipileKey(["mail", kind, id]);
}
