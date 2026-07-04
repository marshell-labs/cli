import { spawn } from "node:child_process";
import {
  ackMessages,
  fetchInbox,
  sendMessage,
  type InboxMessage,
} from "./network";

export type BridgeOptions = {
  networkUrl: string;
  agentName?: string;
  autoReply: boolean;
  runtime: "cursor" | "hermes" | "fast";
  workspace: string;
  hook?: string;
  json: boolean;
  replyTimeoutMs: number;
};

const DEFAULT_REPLY_TIMEOUT_MS = 120_000;

/** Instant replies — no LLM spawn. Marshell transport stays fast. */
export function tryFastReply(msg: InboxMessage): string | null {
  const text = msg.text.trim();

  if (/^(ping|pong)$/i.test(text)) {
    return "pong";
  }
  if (/^(hi|hello|hey|yo|sup|picun)[!.?\s]*$/i.test(text)) {
    return text.toLowerCase() === "picun" ? "picun" : "hi";
  }
  if (text.toLowerCase().startsWith("echo:")) {
    const body = text.slice(5).trim();
    return body || "(empty)";
  }

  return null;
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

function spawnCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; input?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn(command, args, {
            cwd: options?.cwd,
            env: process.env,
            windowsHide: true,
            shell: false,
          })
        : spawn(command, args, {
            cwd: options?.cwd,
            env: process.env,
            detached: true,
          });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number, errText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr: errText ? `${stderr}\n${errText}`.trim() : stderr,
      });
    };

    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish(124, `timeout after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    if (options?.input) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
    child.on("error", (error) => {
      finish(1, error.message);
    });
  });
}

async function generateRuntimeReply(
  msg: InboxMessage,
  runtime: "cursor" | "hermes",
  workspace: string,
  timeoutMs: number,
): Promise<string> {
  const prompt = [
    `Marshell agent "${msg.from}" sent:`,
    msg.text,
    "",
    "Reply with ONLY the answer. No tools, no marshell CLI, no meta commentary.",
  ].join("\n");

  if (runtime === "cursor") {
    const result = await spawnCommand(
      "agent",
      [
        "-p",
        "--trust",
        "--mode",
        "ask",
        "--workspace",
        workspace,
        "--output-format",
        "text",
        prompt,
      ],
      { timeoutMs },
    );
    if (result.code === 124) {
      throw new Error(`auto-reply timed out (${Math.round(timeoutMs / 1000)}s)`);
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "cursor agent failed");
    }
    return result.stdout.trim();
  }

  const result = await spawnCommand("hermes", ["-z", prompt], { timeoutMs });
  if (result.code === 124) {
    throw new Error(`auto-reply timed out (${Math.round(timeoutMs / 1000)}s)`);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "hermes failed");
  }
  return result.stdout.trim();
}

async function runHookReply(
  hook: string,
  msg: InboxMessage,
  timeoutMs: number,
): Promise<string> {
  const payload = JSON.stringify({
    id: msg.id,
    from: msg.from,
    text: msg.text,
    created_at: msg.created_at,
  });

  if (process.platform === "win32") {
    const result = await spawnCommand(
      "cmd.exe",
      ["/d", "/s", "/c", hook],
      { input: payload, timeoutMs },
    );
    if (result.code === 124) {
      throw new Error(`hook timed out (${Math.round(timeoutMs / 1000)}s)`);
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "hook failed");
    }
    return result.stdout.trim();
  }

  const result = await spawnCommand("sh", ["-c", hook], {
    input: payload,
    timeoutMs,
  });
  if (result.code === 124) {
    throw new Error(`hook timed out (${Math.round(timeoutMs / 1000)}s)`);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "hook failed");
  }
  return result.stdout.trim();
}

function emitEvent(
  json: boolean,
  event: Record<string, unknown>,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  const kind = event.type;
  if (kind === "message") {
    process.stdout.write(
      `[message] from=${event.from} id=${event.id}\n${event.text}\n`,
    );
  } else if (kind === "reply") {
    process.stdout.write(`[reply] to=${event.to} id=${event.id}\n`);
  } else if (kind === "error") {
    process.stderr.write(`[bridge] ${event.message}\n`);
  }
}

async function deliverReply(
  networkUrl: string,
  msg: InboxMessage,
  reply: string,
  json: boolean,
): Promise<void> {
  const sent = await sendMessage(networkUrl, msg.from, reply);
  if (sent.kind !== "sent") {
    throw new Error(sent.message);
  }
  emitEvent(json, {
    type: "reply",
    to: msg.from,
    id: sent.id,
    in_reply_to: msg.id,
    text: reply,
  });
}

async function processReplyAsync(
  networkUrl: string,
  msg: InboxMessage,
  options: BridgeOptions,
): Promise<void> {
  try {
    let reply: string | null = tryFastReply(msg);

    if (!reply && options.hook) {
      reply = await runHookReply(options.hook, msg, options.replyTimeoutMs);
    } else if (!reply && options.autoReply && options.runtime !== "fast") {
      reply = await generateRuntimeReply(
        msg,
        options.runtime,
        options.workspace,
        options.replyTimeoutMs,
      );
    }

    if (!reply) {
      return;
    }
    if (!reply.trim()) {
      throw new Error("empty reply");
    }

    await deliverReply(networkUrl, msg, reply.trim(), options.json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent(options.json, { type: "error", message, in_reply_to: msg.id });
    await sendMessage(
      networkUrl,
      msg.from,
      `Auto-reply failed (${message}). Please retry.`,
    );
  }
}

export async function handleInbound(
  networkUrl: string,
  msg: InboxMessage,
  options: BridgeOptions,
): Promise<void> {
  emitEvent(options.json, {
    type: "message",
    id: msg.id,
    from: msg.from,
    text: msg.text,
    created_at: msg.created_at,
  });

  const fast = tryFastReply(msg);
  if (fast) {
    await deliverReply(networkUrl, msg, fast, options.json);
    await ackMessages(networkUrl, [msg.id]);
    return;
  }

  const willReply =
    Boolean(options.hook) ||
    (options.autoReply && options.runtime !== "fast");

  // Ack immediately so transport never blocks on slow LLM / hook.
  await ackMessages(networkUrl, [msg.id]);

  if (!willReply) {
    return;
  }

  void processReplyAsync(networkUrl, msg, options);
}

export async function runBridge(options: BridgeOptions): Promise<void> {
  const label = options.agentName ?? "agent";
  const mode = options.hook
    ? "hook"
    : options.autoReply
      ? options.runtime === "fast"
        ? "fast-only"
        : `auto-reply (${options.runtime})`
      : "deliver-only";

  process.stdout.write(`Bridge listening as '${label}' (${mode}).\n`);

  let stopped = false;
  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    process.stdout.write("Bridge stopped.\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (!stopped) {
    const result = await fetchInbox(options.networkUrl, {
      peek: true,
      waitSeconds: 30,
    });
    if (result.kind === "error") {
      process.stderr.write(`inbox error: ${result.message}\n`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    for (const msg of result.messages) {
      await handleInbound(options.networkUrl, msg, options);
    }
  }
}
