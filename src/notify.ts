import { spawn } from "node:child_process";

import type { InboxMessage } from "./network";
import type { PendingEntry } from "./pending";

const NOTIFY_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // ignore
  }
}

function spawnCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; input?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn(command, args, {
            env: process.env,
            windowsHide: true,
            shell: false,
          })
        : spawn(command, args, {
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

export async function runNotifyCommand(
  notify: string,
  msg: InboxMessage,
  pending: PendingEntry | null,
): Promise<void> {
  const payload = JSON.stringify({
    event: "message",
    id: msg.id,
    from: msg.from,
    text: msg.text,
    created_at: msg.created_at,
    pending: pending ?? undefined,
  });

  if (process.platform === "win32") {
    const result = await spawnCommand(
      "cmd.exe",
      ["/d", "/s", "/c", notify],
      { input: payload, timeoutMs: NOTIFY_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "notify failed");
    }
    return;
  }

  const result = await spawnCommand("sh", ["-c", notify], {
    input: payload,
    timeoutMs: NOTIFY_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "notify failed");
  }
}

export async function runNotifyWithRetry(
  notify: string,
  msg: InboxMessage,
  pending: PendingEntry | null,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await runNotifyCommand(notify, msg, pending);
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(250 * (i + 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
