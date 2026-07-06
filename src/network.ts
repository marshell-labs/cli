import { randomUUID } from "node:crypto";
import { readConfig } from "./config";

export type HealthStatus = {
  ok: boolean;
  status?: number;
  message?: string;
};

export type JoinResponse = {
  agent_key: string;
  agent_card_url?: string;
};

export const MARSHELL_CLI_VERSION = "0.8.1";

export type JoinAgentOptions = {
  description?: string;
  version?: string;
};

export type WalletSnapshot = {
  free_remaining: number;
  prepaid_balance: number;
  messages_remaining: number;
};

export function formatWalletLine(wallet: WalletSnapshot): string {
  const parts: string[] = [];
  if (wallet.free_remaining > 0) {
    parts.push(`${wallet.free_remaining} free`);
  }
  if (wallet.prepaid_balance > 0) {
    parts.push(`${wallet.prepaid_balance} prepaid`);
  }
  const detail = parts.length > 0 ? parts.join(" · ") : "none";
  return `Messages remaining: ${wallet.messages_remaining} (${detail})`;
}

export function parseWallet(raw: unknown): WalletSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  if (
    typeof w.free_remaining !== "number" ||
    typeof w.prepaid_balance !== "number" ||
    typeof w.messages_remaining !== "number"
  ) {
    return undefined;
  }
  return {
    free_remaining: w.free_remaining,
    prepaid_balance: w.prepaid_balance,
    messages_remaining: w.messages_remaining,
  };
}

export type InboxMessage = {
  id: string;
  from: string;
  from_id: string;
  to: string;
  to_id: string;
  text: string;
  created_at: string;
};

type HttpResult<T> = {
  status: number;
  data: T;
};

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<HttpResult<T>> {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    const response = await fetch(url, { method: "GET", headers });
    const text = await response.text();
    let data: unknown = {};
    if (text.trim().length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    const result = { status: response.status, data: data as T };
    if (
      isRetryableStatus(response.status) &&
      i < attempts - 1
    ) {
      const waitMs =
        response.status === 429
          ? parseRetryAfterSeconds(response.headers.get("Retry-After")) * 1000
          : 250 * (i + 1);
      await sleep(waitMs);
      continue;
    }
    return result;
  }
  return { status: 0, data: {} as T };
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function withPath(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

async function authHeaders(
  kind: "token" | "agent",
): Promise<Record<string, string>> {
  const config = await readConfig();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (kind === "agent") {
    if (!config.agentKey) {
      throw new Error("Missing agent key. Run: marshell agent join --name <name>");
    }
    headers.authorization = `Bearer ${config.agentKey}`;
  } else if (config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }
  return headers;
}

export async function pingNetwork(baseUrl: string): Promise<HealthStatus> {
  const candidates = ["/health", "/v1/health"];

  for (const path of candidates) {
    try {
      const response = await fetch(withPath(baseUrl, path), {
        method: "GET",
      });
      if (response.ok) {
        return { ok: true, status: response.status };
      }
      if (response.status !== 404) {
        return {
          ok: false,
          status: response.status,
          message: `Health endpoint returned HTTP ${response.status}.`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        message: (error as Error).message,
      };
    }
  }

  return {
    ok: false,
    message: "Health endpoint not found.",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    attempts?: number;
    shouldRetry?: (result: T) => boolean;
  },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (!opts?.shouldRetry?.(result) || i === attempts - 1) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) {
        throw error;
      }
    }
    await sleep(250 * (i + 1));
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResult<T>> {
  return withRetry(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const text = await response.text();
      let data: unknown = {};

      if (text.trim().length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }

      return {
        status: response.status,
        data: data as T,
      };
    },
    {
      shouldRetry: (result) => isRetryableStatus(result.status),
    },
  );
}

function parseRetryAfterSeconds(raw: string | null): number {
  if (!raw) return 60;
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n > 0) return Math.min(120, Math.ceil(n));
  return 60;
}

export async function joinAgent(
  baseUrl: string,
  name: string,
  options: JoinAgentOptions = {},
): Promise<
  | { kind: "joined"; agentKey: string; agentCardUrl?: string }
  | { kind: "not_found" }
  | { kind: "error"; status: number; message: string }
> {
  const config = await readConfig();
  if (!config.token) {
    return {
      kind: "error",
      status: 401,
      message: "Missing auth token. Run: marshell auth set <token>",
    };
  }

  try {
    const result = await postJson<Partial<JoinResponse>>(
      withPath(baseUrl, "/v1/agents/join"),
      {
        token: config.token,
        name,
        description: options.description?.trim() || undefined,
        version: options.version ?? MARSHELL_CLI_VERSION,
      },
      { "content-type": "application/json" },
    );

    if (result.status === 404) {
      return { kind: "not_found" };
    }

    if (result.status >= 200 && result.status < 300 && result.data.agent_key) {
      return {
        kind: "joined",
        agentKey: result.data.agent_key,
        agentCardUrl: result.data.agent_card_url,
      };
    }

    const errText =
      typeof result.data === "object" &&
      result.data &&
      "error" in result.data &&
      typeof (result.data as { error?: string }).error === "string"
        ? (result.data as { error: string }).error
        : `Join failed with HTTP ${result.status}.`;

    return {
      kind: "error",
      status: result.status,
      message: errText,
    };
  } catch (error) {
    return {
      kind: "error",
      status: 0,
      message: (error as Error).message,
    };
  }
}

export async function discoverPeers(
  baseUrl: string,
): Promise<{ peers: Array<Record<string, unknown>> }> {
  // Prefer agent_key — survives join-token rotation.
  const config = await readConfig();
  const kind = config.agentKey ? "agent" : "token";

  try {
    const headers = await authHeaders(kind);
    const response = await fetch(withPath(baseUrl, "/v1/peers"), {
      method: "GET",
      headers,
    });

    if (response.ok) {
      const data = (await response.json()) as
        | { peers?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>;
      if (Array.isArray(data)) {
        return { peers: data };
      }
      return { peers: data.peers ?? [] };
    }
  } catch {
    return { peers: [] };
  }

  return { peers: [] };
}

export async function fetchWallet(
  baseUrl: string,
): Promise<
  | { kind: "ok"; wallet: WalletSnapshot; topUpUrl: string }
  | { kind: "error"; message: string; status?: number }
> {
  try {
    const headers = await authHeaders("agent");
    const response = await fetch(withPath(baseUrl, "/v1/wallet"), {
      method: "GET",
      headers,
    });
    const data = (await response.json()) as {
      wallet?: WalletSnapshot;
      pricing?: { top_up?: string };
      error?: string;
    };
    if (!response.ok) {
      return {
        kind: "error",
        status: response.status,
        message: data.error ?? `Wallet check failed with HTTP ${response.status}.`,
      };
    }
    const wallet = parseWallet(data.wallet);
    if (!wallet) {
      return { kind: "error", message: "Wallet response missing balance." };
    }
    return {
      kind: "ok",
      wallet,
      topUpUrl:
        data.pricing?.top_up ?? "https://console.marshell.dev/dashboard/billing",
    };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

export type SendOptions = {
  correlationId?: string;
  clientMessageId?: string;
};

export function defaultClientMessageId(): string {
  return `cmid_${randomUUID()}`;
}

type SendSuccess = {
  kind: "sent";
  id: string;
  status: string;
  wallet: WalletSnapshot;
  poll_status: string;
  correlation_id?: string;
  client_message_id?: string;
};

type SendError = {
  kind: "error";
  message: string;
  status?: number;
  code?: string;
  wallet?: WalletSnapshot;
  action?: string;
  recovered_id?: string;
};

function isAmbiguousSendFailure(status: number | undefined): boolean {
  return (
    status === undefined ||
    status === 0 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function recoverSentMessageId(
  baseUrl: string,
  to: string,
  text: string,
  opts: {
    correlationId?: string;
    clientMessageId?: string;
    sinceMs: number;
  },
): Promise<string | undefined> {
  const history = await fetchHistory(baseUrl, { with: to, limit: 30 });
  if (history.kind !== "ok") return undefined;
  for (const m of history.messages) {
    if (m.direction !== "out") continue;
    const created = Date.parse(m.created_at);
    if (Number.isNaN(created) || created < opts.sinceMs) continue;
    if (opts.clientMessageId && m.client_message_id === opts.clientMessageId) {
      return m.id;
    }
    if (opts.correlationId && m.correlation_id === opts.correlationId) {
      return m.id;
    }
    if (m.text === text) return m.id;
  }
  return undefined;
}

export type MessageReceipt = {
  message_id: string;
  status: string;
  from?: string;
  to?: string;
  updated_at?: string;
};

export async function sendMessage(
  baseUrl: string,
  to: string,
  text: string,
  options: SendOptions = {},
): Promise<SendSuccess | SendError> {
  try {
    const headers = await authHeaders("agent");
    const clientMessageId =
      options.clientMessageId?.trim() || defaultClientMessageId();
    if (options.correlationId?.trim()) {
      headers["x-correlation-id"] = options.correlationId.trim();
    }
    headers["idempotency-key"] = clientMessageId;
    const body: Record<string, string> = { to, text, client_message_id: clientMessageId };
    if (options.correlationId?.trim()) {
      body.correlation_id = options.correlationId.trim();
    }

    const result = await withRetry(
      async () => {
        const response = await fetch(withPath(baseUrl, "/v1/messages/send"), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const raw = await response.text();
        let data: {
          id?: string;
          status?: string;
          wallet?: WalletSnapshot;
          error?: string;
          code?: string;
          action?: string;
          poll_status?: string;
          correlation_id?: string;
        } = {};
        if (raw.trim().length > 0) {
          try {
            data = JSON.parse(raw) as typeof data;
          } catch {
            data = { error: raw };
          }
        }
        return { status: response.status, data };
      },
      {
        attempts: 3,
        shouldRetry: (r) => isRetryableStatus(r.status),
      },
    );

    const wallet = parseWallet(result.data.wallet);

    if (result.status === 402) {
      return {
        kind: "error",
        status: 402,
        code: result.data.code ?? "payment_required",
        message: result.data.error ?? "No message credits remaining.",
        wallet,
        action:
          result.data.action ??
          "Ask the subnet owner to top up at https://console.marshell.dev/dashboard/billing",
      };
    }

    if (result.status === 429) {
      return {
        kind: "error",
        status: 429,
        code: "rate_limited",
        message:
          result.data.error ??
          "Rate limit exceeded. Retry after the Retry-After interval.",
      };
    }

    if (result.status >= 200 && result.status < 300 && result.data.id) {
      if (!wallet) {
        return {
          kind: "error",
          message: "Send succeeded but wallet balance was missing from response.",
          status: result.status,
        };
      }
      return {
        kind: "sent",
        id: result.data.id,
        status: result.data.status ?? "delivered",
        wallet,
        poll_status:
          result.data.poll_status ??
          `/v1/messages/status?ids=${result.data.id}`,
        correlation_id: result.data.correlation_id,
        client_message_id: clientMessageId,
      };
    }

    return {
      kind: "error",
      status: result.status,
      message: result.data.error ?? `Send failed with HTTP ${result.status}.`,
      wallet,
    };
  } catch (error) {
    return {
      kind: "error",
      message: (error as Error).message,
    };
  }
}

export async function sendMessageWithRecovery(
  baseUrl: string,
  to: string,
  text: string,
  options: SendOptions = {},
): Promise<SendSuccess | SendError> {
  const clientMessageId =
    options.clientMessageId?.trim() || defaultClientMessageId();
  const sendOptions = { ...options, clientMessageId };
  const sendStartedAt = Date.now() - 5000;
  const first = await sendMessage(baseUrl, to, text, sendOptions);
  if (first.kind === "sent") return first;

  if (!isAmbiguousSendFailure(first.status) && first.status !== 429) {
    return first;
  }

  const recoveredId = await recoverSentMessageId(baseUrl, to, text, {
    correlationId: sendOptions.correlationId,
    clientMessageId,
    sinceMs: sendStartedAt,
  });
  if (!recoveredId) {
    if (isAmbiguousSendFailure(first.status)) {
      return {
        ...first,
        message: `${first.message} Message may already be queued — poll: marshell status --ids <id> or marshell history --with ${to}`,
      };
    }
    return first;
  }

  const status = await fetchMessageStatus(baseUrl, [recoveredId], 0);
  const wallet = await fetchWallet(baseUrl);
  if (status.kind === "ok" && status.receipts.length > 0) {
    if (wallet.kind !== "ok") {
      return {
        kind: "error",
        message: "Recovered message id but wallet check failed.",
        recovered_id: recoveredId,
      };
    }
    return {
      kind: "sent",
      id: recoveredId,
      status: status.receipts[0]?.status ?? "delivered",
      wallet: wallet.wallet,
      poll_status: `/v1/messages/status?ids=${recoveredId}`,
      correlation_id: sendOptions.correlationId,
      client_message_id: clientMessageId,
    };
  }

  return {
    ...first,
    recovered_id: recoveredId,
    message: `${first.message} Recovered id ${recoveredId} — poll: marshell status --ids ${recoveredId}`,
  };
}

export async function fetchInbox(
  baseUrl: string,
  options?: { peek?: boolean; waitSeconds?: number },
): Promise<
  | { kind: "ok"; messages: InboxMessage[]; agent: string }
  | { kind: "error"; message: string; status?: number }
> {
  const peek = options?.peek !== false;
  try {
    const headers = await authHeaders("agent");
    const params = new URLSearchParams();
    if (peek) {
      params.set("peek", "1");
    }
    if (options?.waitSeconds && options.waitSeconds > 0) {
      params.set("wait", String(Math.min(120, options.waitSeconds)));
    }
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const result = await getJson<{
      messages?: InboxMessage[];
      agent?: string;
      error?: string;
    }>(withPath(baseUrl, `/v1/messages/inbox${qs}`), headers);

    if (result.status < 200 || result.status >= 300) {
      return {
        kind: "error",
        status: result.status,
        message: result.data.error ?? `Inbox failed with HTTP ${result.status}.`,
      };
    }

    return {
      kind: "ok",
      messages: result.data.messages ?? [],
      agent: result.data.agent ?? "",
    };
  } catch (error) {
    return {
      kind: "error",
      message: (error as Error).message,
    };
  }
}

export async function ackMessages(
  baseUrl: string,
  ids: string[],
): Promise<{ kind: "ok"; acked: number } | { kind: "error"; message: string }> {
  if (ids.length === 0) {
    return { kind: "ok", acked: 0 };
  }
  try {
    const headers = await authHeaders("agent");
    const result = await postJson<{ acked?: number; error?: string }>(
      withPath(baseUrl, "/v1/messages/ack"),
      { ids },
      headers,
    );
    if (result.status >= 200 && result.status < 300) {
      return { kind: "ok", acked: result.data.acked ?? ids.length };
    }
    return {
      kind: "error",
      message: result.data.error ?? `Ack failed with HTTP ${result.status}.`,
    };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

export async function waitForInbox(
  baseUrl: string,
  options: { waitSeconds: number; from?: string; sinceMessageId?: string },
): Promise<
  | { kind: "ok"; messages: InboxMessage[]; agent: string }
  | { kind: "timeout" }
  | { kind: "error"; message: string }
> {
  const deadline = Date.now() + options.waitSeconds * 1000;
  const from = options.from?.toLowerCase();
  let sinceMs = 0;

  if (options.sinceMessageId) {
    const history = await fetchHistory(baseUrl, {
      with: options.from,
      limit: 100,
    });
    if (history.kind === "ok") {
      const sent = history.messages.find((m) => m.id === options.sinceMessageId);
      if (sent) {
        sinceMs = Date.parse(sent.created_at) - 2000;
      }
    }
  }

  while (Date.now() < deadline) {
    const remaining = Math.max(
      1,
      Math.min(30, Math.ceil((deadline - Date.now()) / 1000)),
    );
    const result = await fetchInbox(baseUrl, {
      peek: true,
      waitSeconds: remaining,
    });
    if (result.kind === "error") {
      return result;
    }

    const messages = from
      ? result.messages.filter((m) => {
          if (m.from.toLowerCase() !== from) return false;
          if (sinceMs > 0) {
            const created = Date.parse(m.created_at);
            return !Number.isNaN(created) && created >= sinceMs;
          }
          return true;
        })
      : result.messages;

    if (messages.length > 0) {
      await ackMessages(
        baseUrl,
        messages.map((m) => m.id),
      );
      return { kind: "ok", messages, agent: result.agent };
    }
  }

  return { kind: "timeout" };
}

export type HistoryMessage = {
  id: string;
  direction: "in" | "out" | string;
  peer: string;
  text: string;
  created_at: string;
  correlation_id?: string;
  client_message_id?: string;
};

export async function fetchMessageStatus(
  baseUrl: string,
  ids: string[],
  waitSeconds = 0,
): Promise<
  | { kind: "ok"; receipts: MessageReceipt[] }
  | { kind: "error"; message: string; status?: number }
> {
  if (ids.length === 0) {
    return { kind: "ok", receipts: [] };
  }
  try {
    const headers = await authHeaders("agent");
    const params = new URLSearchParams({ ids: ids.join(",") });
    if (waitSeconds > 0) {
      params.set("wait", String(Math.min(120, waitSeconds)));
    }
    const result = await getJson<{
      receipts?: MessageReceipt[];
      error?: string;
    }>(withPath(baseUrl, `/v1/messages/status?${params}`), headers);

    if (result.status < 200 || result.status >= 300) {
      return {
        kind: "error",
        status: result.status,
        message: result.data.error ?? `Status failed with HTTP ${result.status}.`,
      };
    }
    return { kind: "ok", receipts: result.data.receipts ?? [] };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

export async function waitForDelivery(
  baseUrl: string,
  messageId: string,
  timeoutSeconds: number,
): Promise<
  | { kind: "ok"; status: string; receipt?: MessageReceipt }
  | { kind: "timeout"; last_status?: string }
  | { kind: "error"; message: string }
> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    const remaining = Math.max(
      1,
      Math.min(30, Math.ceil((deadline - Date.now()) / 1000)),
    );
    const result = await fetchMessageStatus(baseUrl, [messageId], remaining);
    if (result.kind === "error") {
      return result;
    }
    const receipt = result.receipts[0];
    if (receipt) {
      lastStatus = receipt.status;
      if (receipt.status === "received") {
        return { kind: "ok", status: receipt.status, receipt };
      }
    }
  }

  return { kind: "timeout", last_status: lastStatus };
}

export type AskOptions = {
  waitSeconds: number;
  noWait?: boolean;
  pollDelivery?: boolean;
  correlationId?: string;
  trackOnTimeout?: boolean;
};

export async function fetchHistory(
  baseUrl: string,
  options?: { with?: string; limit?: number },
): Promise<
  | { kind: "ok"; agent: string; messages: HistoryMessage[] }
  | { kind: "error"; message: string; status?: number }
> {
  try {
    const headers = await authHeaders("agent");
    const params = new URLSearchParams();
    if (options?.with) {
      params.set("with", options.with);
    }
    if (options?.limit && options.limit > 0) {
      params.set("limit", String(options.limit));
    }
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const response = await fetch(
      withPath(baseUrl, `/v1/messages/history${qs}`),
      { method: "GET", headers },
    );
    const data = (await response.json()) as {
      agent?: string;
      messages?: HistoryMessage[];
      error?: string;
    };
    if (!response.ok) {
      return {
        kind: "error",
        status: response.status,
        message: data.error ?? `History failed with HTTP ${response.status}.`,
      };
    }
    return {
      kind: "ok",
      agent: data.agent ?? "",
      messages: data.messages ?? [],
    };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

export async function askAgent(
  baseUrl: string,
  to: string,
  text: string,
  options: AskOptions | number,
): Promise<
  | {
      kind: "ok";
      reply: string;
      message_id: string;
      sent_id: string;
      delivery_status?: string;
    }
  | { kind: "sent"; sent_id: string; poll_status: string; tracked?: boolean }
  | { kind: "timeout"; sent_id: string; delivery_status?: string; tracked?: boolean }
  | { kind: "error"; message: string }
> {
  const opts: AskOptions =
    typeof options === "number" ? { waitSeconds: options } : options;
  const waitSeconds = opts.waitSeconds;
  const pollDelivery = opts.pollDelivery !== false;

  const stale = await fetchInbox(baseUrl, { peek: true });
  if (stale.kind === "ok") {
    const fromPeer = stale.messages.filter(
      (m) => m.from.toLowerCase() === to.toLowerCase(),
    );
    if (fromPeer.length > 0) {
      await ackMessages(
        baseUrl,
        fromPeer.map((m) => m.id),
      );
    }
  }

  const sent = await sendMessageWithRecovery(baseUrl, to, text, {
    correlationId: opts.correlationId,
  });
  if (sent.kind !== "sent") {
    return { kind: "error", message: sent.message };
  }

  if (opts.noWait) {
    return {
      kind: "sent",
      sent_id: sent.id,
      poll_status: sent.poll_status,
    };
  }

  const sentAt = Date.now() - 2000;
  const deadline = Date.now() + waitSeconds * 1000;
  const peer = to.toLowerCase();
  let deliveryStatus = sent.status;

  while (Date.now() < deadline) {
    const remaining = Math.max(
      1,
      Math.min(30, Math.ceil((deadline - Date.now()) / 1000)),
    );

    if (pollDelivery && deliveryStatus !== "received") {
      const delivery = await fetchMessageStatus(
        baseUrl,
        [sent.id],
        Math.min(10, remaining),
      );
      if (delivery.kind === "ok" && delivery.receipts[0]) {
        deliveryStatus = delivery.receipts[0].status;
      }
    }

    const result = await fetchInbox(baseUrl, {
      peek: true,
      waitSeconds: remaining,
    });
    if (result.kind === "error") {
      return { kind: "error", message: result.message };
    }

    const messages = result.messages.filter((m) => {
      if (m.from.toLowerCase() !== peer) return false;
      const created = Date.parse(m.created_at);
      return Number.isNaN(created) || created >= sentAt;
    });

    if (messages.length > 0) {
      await ackMessages(
        baseUrl,
        messages.map((m) => m.id),
      );
      return {
        kind: "ok",
        reply: messages.map((m) => m.text.trim()).join("\n\n"),
        message_id: messages[0]?.id ?? sent.id,
        sent_id: sent.id,
        delivery_status: deliveryStatus,
      };
    }
  }

  return {
    kind: "timeout",
    sent_id: sent.id,
    delivery_status: deliveryStatus,
    tracked: opts.trackOnTimeout,
  };
}

export function toWsUrl(httpBase: string): string {
  const url = new URL(httpBase);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }
  return `${url.toString().replace(/\/$/, "")}/v1/agents/ws`;
}
