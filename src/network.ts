import { readConfig } from "./config";

export type HealthStatus = {
  ok: boolean;
  status?: number;
  message?: string;
};

export type JoinResponse = {
  agent_key: string;
};

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

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResult<T>> {
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
}

export async function joinAgent(
  baseUrl: string,
  name: string,
): Promise<
  | { kind: "joined"; agentKey: string }
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
      },
      { "content-type": "application/json" },
    );

    if (result.status === 404) {
      return { kind: "not_found" };
    }

    if (result.status >= 200 && result.status < 300 && result.data.agent_key) {
      return { kind: "joined", agentKey: result.data.agent_key };
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

export async function sendMessage(
  baseUrl: string,
  to: string,
  text: string,
): Promise<
  | { kind: "sent"; id: string; status: string }
  | { kind: "error"; message: string; status?: number }
> {
  try {
    const headers = await authHeaders("agent");
    const result = await postJson<{ id?: string; status?: string; error?: string }>(
      withPath(baseUrl, "/v1/messages/send"),
      { to, text },
      headers,
    );

    if (result.status >= 200 && result.status < 300 && result.data.id) {
      return {
        kind: "sent",
        id: result.data.id,
        status: result.data.status ?? "delivered",
      };
    }

    return {
      kind: "error",
      status: result.status,
      message: result.data.error ?? `Send failed with HTTP ${result.status}.`,
    };
  } catch (error) {
    return {
      kind: "error",
      message: (error as Error).message,
    };
  }
}

export async function fetchInbox(
  baseUrl: string,
  options?: { peek?: boolean; waitSeconds?: number },
): Promise<
  | { kind: "ok"; messages: InboxMessage[]; agent: string }
  | { kind: "error"; message: string; status?: number }
> {
  try {
    const headers = await authHeaders("agent");
    const params = new URLSearchParams();
    if (options?.peek) {
      params.set("peek", "1");
    }
    if (options?.waitSeconds && options.waitSeconds > 0) {
      params.set("wait", String(Math.min(120, options.waitSeconds)));
    }
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const response = await fetch(withPath(baseUrl, `/v1/messages/inbox${qs}`), {
      method: "GET",
      headers,
    });
    const data = (await response.json()) as {
      messages?: InboxMessage[];
      agent?: string;
      error?: string;
    };

    if (!response.ok) {
      return {
        kind: "error",
        status: response.status,
        message: data.error ?? `Inbox failed with HTTP ${response.status}.`,
      };
    }

    return {
      kind: "ok",
      messages: data.messages ?? [],
      agent: data.agent ?? "",
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
  options: { waitSeconds: number; from?: string },
): Promise<
  | { kind: "ok"; messages: InboxMessage[]; agent: string }
  | { kind: "timeout" }
  | { kind: "error"; message: string }
> {
  const deadline = Date.now() + options.waitSeconds * 1000;
  const from = options.from?.toLowerCase();

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
      ? result.messages.filter((m) => m.from.toLowerCase() === from)
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
  waitSeconds: number,
): Promise<
  | { kind: "ok"; reply: string; message_id: string }
  | { kind: "timeout"; sent_id: string }
  | { kind: "error"; message: string }
> {
  // Drain any stale messages from this peer before asking.
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

  const sentAt = Date.now() - 2000;
  const sent = await sendMessage(baseUrl, to, text);
  if (sent.kind !== "sent") {
    return { kind: "error", message: sent.message };
  }

  const deadline = Date.now() + waitSeconds * 1000;
  const peer = to.toLowerCase();

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
      };
    }
  }

  return { kind: "timeout", sent_id: sent.id };
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
