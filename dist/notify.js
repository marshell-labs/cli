"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runNotifyCommand = runNotifyCommand;
exports.runNotifyWithRetry = runNotifyWithRetry;
const node_child_process_1 = require("node:child_process");
const NOTIFY_TIMEOUT_MS = 30_000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function killProcessTree(pid) {
    if (!pid)
        return;
    try {
        if (process.platform === "win32") {
            (0, node_child_process_1.spawn)("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
        }
        else {
            process.kill(-pid, "SIGTERM");
        }
    }
    catch {
        // ignore
    }
}
function spawnCommand(command, args, options) {
    const timeoutMs = options?.timeoutMs ?? NOTIFY_TIMEOUT_MS;
    return new Promise((resolve) => {
        const child = process.platform === "win32"
            ? (0, node_child_process_1.spawn)(command, args, {
                env: process.env,
                windowsHide: true,
                shell: false,
            })
            : (0, node_child_process_1.spawn)(command, args, {
                env: process.env,
                detached: true,
            });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (code, errText) => {
            if (settled)
                return;
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
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
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
async function runNotifyCommand(notify, msg, pending) {
    const payload = JSON.stringify({
        event: "message",
        id: msg.id,
        from: msg.from,
        text: msg.text,
        created_at: msg.created_at,
        pending: pending ?? undefined,
    });
    if (process.platform === "win32") {
        const result = await spawnCommand("cmd.exe", ["/d", "/s", "/c", notify], { input: payload, timeoutMs: NOTIFY_TIMEOUT_MS });
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
async function runNotifyWithRetry(notify, msg, pending, attempts = 3) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            await runNotifyCommand(notify, msg, pending);
            return;
        }
        catch (error) {
            lastError = error;
            if (i < attempts - 1) {
                await sleep(250 * (i + 1));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
