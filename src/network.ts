import { readConfig } from "./config";

export type HealthStatus = {
  ok: boolean;
  status?: number;
  message?: string;
};

export type JoinResponse = {
  agent_key: string;
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
): Promise<HttpResult<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
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
    );

    if (result.status === 404) {
      return { kind: "not_found" };
    }

    if (result.status >= 200 && result.status < 300 && result.data.agent_key) {
      return { kind: "joined", agentKey: result.data.agent_key };
    }

    return {
      kind: "error",
      status: result.status,
      message: `Join failed with HTTP ${result.status}.`,
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
  const config = await readConfig();
  const headers: Record<string, string> = {};
  if (config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }

  const candidates = ["/v1/peers", "/v1/discover"];

  for (const path of candidates) {
    try {
      const response = await fetch(withPath(baseUrl, path), {
        method: "GET",
        headers,
      });
      if (response.status === 404) {
        continue;
      }

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
  }

  return { peers: [] };
}

export async function sendMessage(
  baseUrl: string,
  to: string,
  text: string,
): Promise<
  | { kind: "sent"; id: string }
  | { kind: "stubbed"; reason: string }
  | { kind: "error"; message: string; status?: number }
> {
  const config = await readConfig();

  if (!config.token) {
    return { kind: "error", message: "Missing auth token." };
  }

  try {
    const result = await postJson<{ id?: string }>(
      withPath(baseUrl, "/v1/messages/send"),
      {
        token: config.token,
        to,
        text,
      },
    );

    if (result.status === 404) {
      return {
        kind: "stubbed",
        reason: "Network send API is not available yet (Phase 1).",
      };
    }

    if (result.status >= 200 && result.status < 300) {
      return {
        kind: "sent",
        id: result.data.id ?? `local-${Date.now()}`,
      };
    }

    return {
      kind: "error",
      status: result.status,
      message: `Send failed with HTTP ${result.status}.`,
    };
  } catch (error) {
    return {
      kind: "stubbed",
      reason: `Network unavailable, stored as local stub: ${(error as Error).message}`,
    };
  }
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
