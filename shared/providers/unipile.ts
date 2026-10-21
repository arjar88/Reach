import { ProviderError, asRecord, liveHttp, pickString, requireEnv, type HttpClient } from "./http.js";

export interface HostedLinkInput {
  sessionId: string;
  type: "create" | "reconnect";
  providers: ("LINKEDIN" | "GOOGLE" | "OUTLOOK")[];
  notifyUrl: string;
  successUrl: string;
  failureUrl: string;
  expiresOn: string;
  reconnectAccountId?: string;
}

export interface UnipileAccount {
  id: string;
  type: string;
  status: string;
}

export interface OwnProfile {
  providerId: string;
  premium: boolean;
  connections: number;
  firstName: string | null;
  headline: string | null;
}

export interface ProfileView {
  providerId: string;
  networkDistance: string | null;
  firstName: string | null;
  headline: string | null;
  title: string | null;
  company: string | null;
  country: string | null;
  profileUrl: string | null;
}

export interface SentInvite {
  providerId: string;
  at: string;
}

export interface ChatMessage {
  id: string;
  providerId: string | null;
  text: string;
  at: string;
  isSender: boolean;
}

export interface MailMessage {
  id: string;
  messageId: string | null;
  trackingId: string | null;
  providerId: string | null;
  at: string;
}

export interface UnipileClient {
  createHostedLink(input: HostedLinkInput): Promise<{ url: string }>;
  getAccount(accountId: string): Promise<UnipileAccount>;
  deleteAccount(accountId: string): Promise<void>;
  getOwnProfile(accountId: string): Promise<OwnProfile>;
  getProfile(accountId: string, profileUrl: string, notify: boolean): Promise<ProfileView>;
  invite(accountId: string, providerId: string, note: string | null): Promise<{ id: string | null }>;
  withdrawInvite(accountId: string, providerId: string): Promise<void>;
  sendChat(accountId: string, opts: { providerId: string; chatId: string | null; text: string }): Promise<{ chatId: string; messageId: string | null }>;
  sendEmail(accountId: string, opts: {
    to: string;
    subject: string;
    body: string;
    actionId: string;
    replyTo: string | null;
    unsubscribeUrl: string;
  }): Promise<{ trackingId: string | null; providerId: string | null }>;
  listInvitations(accountId: string): Promise<SentInvite[]>;
  listChatMessages(accountId: string, chatId: string): Promise<ChatMessage[]>;
  listEmails(accountId: string, sinceIso: string): Promise<MailMessage[]>;
  listAccounts(): Promise<UnipileAccount[]>;
}

function baseUrl(): string {
  const dsn = requireEnv("UNIPILE_DSN").replace(/\/$/, "");
  if (dsn.startsWith("http://") || dsn.startsWith("https://")) return `${dsn}/api/v1`;
  return `https://${dsn}/api/v1`;
}

function throwFor(route: string, status: number, json: unknown): never {
  const body = asRecord(json);
  const errorType = pickString(body, ["type", "error", "code"]) ?? undefined;
  const accountStatus = pickString(asRecord(body.account), ["status"]) ?? pickString(body, ["account_status"]) ?? undefined;
  const temporary = status >= 500 || errorType === "timeout";
  throw new ProviderError(route, `Unipile ${route} failed (${status})`, { statusCode: status, errorType, accountStatus, temporary });
}

export function createUnipile(http: HttpClient = liveHttp): UnipileClient {
  async function call(route: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const key = requireEnv("UNIPILE_API_KEY");
    const response = await http(`${baseUrl()}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-API-KEY": key,
        ...(init.headers ?? {}),
      },
    });
    if (response.status >= 400) throwFor(route, response.status, response.json);
    return response.json;
  }
  return {
    async createHostedLink(input) {
      const json = await call("hosted_link", "/hosted/accounts/link", {
        method: "POST",
        body: JSON.stringify({
          type: input.type,
          providers: input.providers,
          api_url: baseUrl().replace(/\/api\/v1$/, ""),
          expiresOn: input.expiresOn,
          name: input.sessionId,
          notify_url: input.notifyUrl,
          success_redirect_url: input.successUrl,
          failure_redirect_url: input.failureUrl,
          reconnect_account: input.reconnectAccountId,
        }),
      });
      const url = pickString(asRecord(json), ["url"]);
      if (!url) throw new ProviderError("hosted_link", "Unipile did not return a link");
      return { url };
    },
    async getAccount(accountId) {
      const json = asRecord(await call("get_account", `/accounts/${encodeURIComponent(accountId)}`));
      return {
        id: pickString(json, ["id"]) ?? accountId,
        type: pickString(json, ["type", "provider"]) ?? "",
        status: pickString(asRecord(json.sources), ["status"]) ?? pickString(json, ["status"]) ?? "CONNECTING",
      };
    },
    async deleteAccount(accountId) {
      await call("delete_account", `/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    },
    async getOwnProfile(accountId) {
      const json = asRecord(await call("own_profile", `/users/me?account_id=${encodeURIComponent(accountId)}`));
      return {
        providerId: pickString(json, ["provider_id", "providerId"]) ?? "",
        premium: Boolean(json.premium || json.is_premium),
        connections: typeof json.connections_count === "number" ? json.connections_count : 0,
        firstName: pickString(json, ["first_name", "firstName"]),
        headline: pickString(json, ["headline"]),
      };
    },
    async getProfile(accountId, profileUrl, notify) {
      const json = asRecord(await call("get_profile", `/users/${encodeURIComponent(profileUrl)}?account_id=${encodeURIComponent(accountId)}&notify=${notify ? "true" : "false"}`));
      return {
        providerId: pickString(json, ["provider_id", "providerId"]) ?? "",
        networkDistance: pickString(json, ["network_distance", "networkDistance"]),
        firstName: pickString(json, ["first_name", "firstName"]),
        headline: pickString(json, ["headline"]),
        title: pickString(json, ["title", "headline"]),
        company: pickString(json, ["company"]),
        country: pickString(json, ["country", "location"]),
        profileUrl: pickString(json, ["public_profile_url", "profile_url"]),
      };
    },
    async invite(accountId, providerId, note) {
      const json = asRecord(await call("invite", "/users/invite", {
        method: "POST",
        body: JSON.stringify({
          account_id: accountId,
          provider_id: providerId,
          message: note ?? undefined,
        }),
      }));
      return { id: pickString(json, ["invitation_id", "id"]) };
    },
    async withdrawInvite(accountId, providerId) {
      await call("withdraw", `/users/invite/cancel?account_id=${encodeURIComponent(accountId)}`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId, provider_id: providerId }),
      });
    },
    async sendChat(accountId, opts) {
      if (opts.chatId) {
        const json = asRecord(await call("send_message", `/chats/${encodeURIComponent(opts.chatId)}/messages`, {
          method: "POST",
          body: JSON.stringify({ account_id: accountId, text: opts.text }),
        }));
        return { chatId: opts.chatId, messageId: pickString(json, ["message_id", "id"]) };
      }
      const json = asRecord(await call("start_chat", "/chats", {
        method: "POST",
        body: JSON.stringify({
          account_id: accountId,
          attendees_ids: [opts.providerId],
          text: opts.text,
        }),
      }));
      return {
        chatId: pickString(json, ["chat_id", "id"]) ?? "",
        messageId: pickString(json, ["message_id"]),
      };
    },
    async sendEmail(accountId, opts) {
      const json = asRecord(await call("send_email", "/emails", {
        method: "POST",
        headers: { "Idempotency-Key": opts.actionId },
        body: JSON.stringify({
          account_id: accountId,
          to: [{ identifier: opts.to }],
          subject: opts.subject,
          body: opts.body,
          reply_to: opts.replyTo ?? undefined,
          headers: [
            { name: "List-Unsubscribe", value: `<${opts.unsubscribeUrl}>` },
            { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
          ],
        }),
      }));
      return {
        trackingId: pickString(json, ["tracking_id", "id"]),
        providerId: pickString(json, ["provider_id", "id"]),
      };
    },
    async listInvitations(accountId) {
      const json = asRecord(await call("list_invitations", `/users/invite/sent?account_id=${encodeURIComponent(accountId)}`));
      const items = Array.isArray(json.items) ? json.items : Array.isArray(json) ? json : [];
      return items.map((raw) => {
        const row = asRecord(raw);
        return {
          providerId: pickString(row, ["provider_id", "invited_user_id"]) ?? "",
          at: pickString(row, ["parsed_datetime", "created_at", "date"]) ?? new Date(0).toISOString(),
        };
      }).filter((row) => row.providerId);
    },
    async listChatMessages(accountId, chatId) {
      const json = asRecord(await call("list_messages", `/chats/${encodeURIComponent(chatId)}/messages?account_id=${encodeURIComponent(accountId)}`));
      const items = Array.isArray(json.items) ? json.items : [];
      return items.map((raw) => {
        const row = asRecord(raw);
        return {
          id: pickString(row, ["id"]) ?? "",
          providerId: pickString(asRecord(row.sender), ["attendee_provider_id"]) ?? pickString(row, ["sender_id"]),
          text: pickString(row, ["text"]) ?? "",
          at: pickString(row, ["timestamp"]) ?? new Date(0).toISOString(),
          isSender: Boolean(row.is_sender),
        };
      });
    },
    async listEmails(accountId, sinceIso) {
      const json = asRecord(await call("list_emails", `/emails?account_id=${encodeURIComponent(accountId)}&after=${encodeURIComponent(sinceIso)}`));
      const items = Array.isArray(json.items) ? json.items : [];
      return items.map((raw) => {
        const row = asRecord(raw);
        return {
          id: pickString(row, ["id"]) ?? "",
          messageId: pickString(row, ["message_id"]),
          trackingId: pickString(row, ["tracking_id"]),
          providerId: pickString(row, ["provider_id"]),
          at: pickString(row, ["date"]) ?? new Date(0).toISOString(),
        };
      });
    },
    async listAccounts() {
      const json = asRecord(await call("list_accounts", "/accounts"));
      const items = Array.isArray(json.items) ? json.items : [];
      return items.map((raw) => {
        const row = asRecord(raw);
        return {
          id: pickString(row, ["id"]) ?? "",
          type: pickString(row, ["type"]) ?? "",
          status: pickString(row, ["status"]) ?? "OK",
        };
      }).filter((row) => row.id);
    },
  };
}

export type NormalizedWebhook =
  | { kind: "message"; accountId: string; messageId: string; chatId: string | null; text: string; at: string; senderProviderId: string | null; ownerProviderId: string | null; attendeeProviderId: string | null }
  | { kind: "new_relation"; accountId: string; providerId: string; at: string }
  | { kind: "account_status"; accountId: string; status: string; at: string }
  | { kind: "mail_sent"; accountId: string; trackingId: string | null; messageId: string | null; providerId: string | null }
  | { kind: "mail_received"; accountId: string; messageId: string | null; inReplyTo: string | null; from: string | null; subject: string | null; body: string; headers: Record<string, string>; at: string }
  | { kind: "ignore" };

export function parseUnipileWebhook(payload: unknown): NormalizedWebhook {
  const row = asRecord(payload);
  const event = (pickString(row, ["event", "type"]) ?? "").toLowerCase();
  const accountId = pickString(row, ["account_id"]) ?? pickString(asRecord(row.AccountStatus), ["account_id"]) ?? "";
  if (event === "message_received" || event === "message_sent") {
    const sender = asRecord(row.sender);
    const accountInfo = asRecord(row.account_info);
    const attendees = Array.isArray(row.attendees) ? row.attendees.map(asRecord) : [];
    const other = attendees.find((a) => pickString(a, ["attendee_provider_id"]) !== pickString(accountInfo, ["user_id"]));
    return {
      kind: "message",
      accountId,
      messageId: pickString(row, ["message_id", "id"]) ?? "",
      chatId: pickString(row, ["chat_id"]),
      text: pickString(row, ["message", "text"]) ?? "",
      at: pickString(row, ["timestamp"]) ?? new Date().toISOString(),
      senderProviderId: pickString(sender, ["attendee_provider_id"]),
      ownerProviderId: pickString(accountInfo, ["user_id"]),
      attendeeProviderId: pickString(other ?? {}, ["attendee_provider_id"]) ?? pickString(sender, ["attendee_provider_id"]),
    };
  }
  if (event === "new_relation") {
    return {
      kind: "new_relation",
      accountId,
      providerId: pickString(row, ["user_provider_id", "provider_id"]) ?? "",
      at: pickString(row, ["timestamp"]) ?? new Date().toISOString(),
    };
  }
  if (event.includes("account") || row.AccountStatus) {
    const status = asRecord(row.AccountStatus);
    return {
      kind: "account_status",
      accountId: pickString(status, ["account_id"]) ?? accountId,
      status: pickString(status, ["message", "status"]) ?? pickString(row, ["status"]) ?? "",
      at: new Date().toISOString(),
    };
  }
  if (event === "mail_sent") {
    return {
      kind: "mail_sent",
      accountId,
      trackingId: pickString(row, ["tracking_id"]),
      messageId: pickString(row, ["message_id"]),
      providerId: pickString(row, ["provider_id"]),
    };
  }
  if (event === "mail_received") {
    const fromAtt = Array.isArray(row.from_attendee) ? asRecord(row.from_attendee[0]) : asRecord(row.from_attendee ?? row.from);
    const headers: Record<string, string> = {};
    const rawHeaders = asRecord(row.headers);
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") headers[key] = value;
    }
    const inReply = asRecord(row.in_reply_to);
    return {
      kind: "mail_received",
      accountId,
      messageId: pickString(row, ["message_id", "id"]),
      inReplyTo: pickString(inReply, ["message_id"]) ?? pickString(row, ["in_reply_to"]),
      from: pickString(fromAtt, ["identifier", "email"]),
      subject: pickString(row, ["subject"]),
      body: pickString(row, ["body", "body_plain"]) ?? "",
      headers,
      at: pickString(row, ["date"]) ?? new Date().toISOString(),
    };
  }
  return { kind: "ignore" };
}
