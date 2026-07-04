"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tryFastReply = tryFastReply;
exports.handleInbound = handleInbound;
exports.runBridge = runBridge;
const node_child_process_1 = require("node:child_process");
const network_1 = require("./network");
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const GREETING_COOLDOWN_MS = 120_000;
const ECHO_WINDOW_MS = 60_000;
const peers = new Map();
function peerState(name) {
    const key = name.toLowerCase();
    let state = peers.get(key);
    if (!state) {
        state = { lastGreetingAt: 0, recentOutbound: [], inflight: false };
        peers.set(key, state);
    }
    return state;
}
function rememberOutbound(peer, text) {
    const state = peerState(peer);
    const now = Date.now();
    state.recentOutbound.push({ text: text.trim().toLowerCase(), at: now });
    state.recentOutbound = state.recentOutbound.filter((item) => now - item.at < ECHO_WINDOW_MS);
}
function isEcho(peer, text) {
    const normalized = text.trim().toLowerCase();
    const state = peerState(peer);
    const now = Date.now();
    return state.recentOutbound.some((item) => item.text === normalized && now - item.at < ECHO_WINDOW_MS);
}
function isGreeting(text) {
    return /^(hi|hello|hey|yo|sup|picun)[!.?\s]*$/i.test(text.trim());
}
/**
 * Instant replies — no LLM. Never reply in a way that loops with another bridge.
 * ping → pong (pong alone is ignored)
 * greetings → one-shot per peer, non-greeting text
 * echo:… → body
 */
function tryFastReply(msg, options) {
    const text = msg.text.trim();
    if (/^ping$/i.test(text)) {
        return "pong";
    }
    // Never auto-reply to "pong" — breaks ping/pong loops.
    if (/^pong$/i.test(text)) {
        return null;
    }
    if (isGreeting(text)) {
        if (options?.allowGreeting === false) {
            return null;
        }
        const state = peerState(msg.from);
        const now = Date.now();
        if (now - state.lastGreetingAt < GREETING_COOLDOWN_MS) {
            return null;
        }
        state.lastGreetingAt = now;
        // Reply must NOT match isGreeting / ping, or peer bridge will loop.
        return `hey ${msg.from} — here. send a question anytime.`;
    }
    if (text.toLowerCase().startsWith("echo:")) {
        const body = text.slice(5).trim();
        return body || "(empty)";
    }
    return null;
}
function killProcessTree(pid) {
    if (!pid)
        return;
    if (process.platform === "win32") {
        (0, node_child_process_1.spawn)("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        });
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            // ignore
        }
    }
}
function spawnCommand(command, args, options) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    return new Promise((resolve) => {
        const child = process.platform === "win32"
            ? (0, node_child_process_1.spawn)(command, args, {
                cwd: options?.cwd,
                env: process.env,
                windowsHide: true,
                shell: false,
            })
            : (0, node_child_process_1.spawn)(command, args, {
                cwd: options?.cwd,
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
async function generateRuntimeReply(msg, runtime, workspace, timeoutMs) {
    const prompt = [
        `You are Marshell agent listening on this machine.`,
        `Peer agent "${msg.from}" sent you a message.`,
        "Answer using the local workspace when relevant.",
        "If they ask who you are, say you are the cursor agent on this Marshell subnet.",
        "Reply with ONLY the answer text. No tools, no marshell CLI, no meta commentary.",
        "",
        "Message:",
        msg.text,
    ].join("\n");
    if (runtime === "cursor") {
        const result = await spawnCommand("agent", [
            "-p",
            "--trust",
            "--mode",
            "ask",
            "--workspace",
            workspace,
            "--output-format",
            "text",
            prompt,
        ], { timeoutMs });
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
async function runHookReply(hook, msg, timeoutMs) {
    const payload = JSON.stringify({
        id: msg.id,
        from: msg.from,
        text: msg.text,
        created_at: msg.created_at,
    });
    if (process.platform === "win32") {
        const result = await spawnCommand("cmd.exe", ["/d", "/s", "/c", hook], { input: payload, timeoutMs });
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
function emitEvent(json, event) {
    if (json) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
    }
    const kind = event.type;
    if (kind === "message") {
        process.stdout.write(`[message] from=${event.from} id=${event.id}\n${event.text}\n`);
    }
    else if (kind === "reply") {
        process.stdout.write(`[reply] to=${event.to} id=${event.id}\n`);
    }
    else if (kind === "skip") {
        process.stdout.write(`[skip] from=${event.from} reason=${event.reason}\n`);
    }
    else if (kind === "error") {
        process.stderr.write(`[bridge] ${event.message}\n`);
    }
}
async function deliverReply(networkUrl, msg, reply, json) {
    const sent = await (0, network_1.sendMessage)(networkUrl, msg.from, reply);
    if (sent.kind !== "sent") {
        throw new Error(sent.message);
    }
    rememberOutbound(msg.from, reply);
    emitEvent(json, {
        type: "reply",
        to: msg.from,
        id: sent.id,
        in_reply_to: msg.id,
        text: reply,
    });
}
async function processReplyAsync(networkUrl, msg, options) {
    const state = peerState(msg.from);
    if (state.inflight) {
        emitEvent(options.json, {
            type: "skip",
            from: msg.from,
            reason: "peer already has an inflight reply",
            id: msg.id,
        });
        return;
    }
    state.inflight = true;
    try {
        let reply = tryFastReply(msg);
        if (!reply && options.hook) {
            reply = await runHookReply(options.hook, msg, options.replyTimeoutMs);
        }
        else if (!reply && options.autoReply && options.runtime !== "fast") {
            reply = await generateRuntimeReply(msg, options.runtime, options.workspace, options.replyTimeoutMs);
        }
        if (!reply) {
            return;
        }
        if (!reply.trim()) {
            throw new Error("empty reply");
        }
        await deliverReply(networkUrl, msg, reply.trim(), options.json);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitEvent(options.json, { type: "error", message, in_reply_to: msg.id });
        // Do not send failure text that peers might auto-reply to in a loop.
    }
    finally {
        state.inflight = false;
    }
}
async function handleInbound(networkUrl, msg, options) {
    emitEvent(options.json, {
        type: "message",
        id: msg.id,
        from: msg.from,
        text: msg.text,
        created_at: msg.created_at,
    });
    // Always ack first so backlog never sticks.
    await (0, network_1.ackMessages)(networkUrl, [msg.id]);
    // Drop echoes of our own recent outbound (hi↔hi loops).
    if (isEcho(msg.from, msg.text)) {
        emitEvent(options.json, {
            type: "skip",
            from: msg.from,
            reason: "echo of our recent outbound",
            id: msg.id,
        });
        return;
    }
    const fast = tryFastReply(msg);
    if (fast) {
        await deliverReply(networkUrl, msg, fast, options.json);
        return;
    }
    // Trivial greetings already handled or on cooldown — do not burn LLM.
    if (isGreeting(msg.text) || /^pong$/i.test(msg.text.trim())) {
        emitEvent(options.json, {
            type: "skip",
            from: msg.from,
            reason: "trivial/cooldown",
            id: msg.id,
        });
        return;
    }
    const willReply = Boolean(options.hook) ||
        (options.autoReply && options.runtime !== "fast");
    if (!willReply) {
        return;
    }
    void processReplyAsync(networkUrl, msg, options);
}
async function drainBacklog(networkUrl, json) {
    const result = await (0, network_1.fetchInbox)(networkUrl, { peek: true });
    if (result.kind !== "ok" || result.messages.length === 0) {
        return;
    }
    await (0, network_1.ackMessages)(networkUrl, result.messages.map((m) => m.id));
    emitEvent(json, {
        type: "skip",
        from: "*",
        reason: `drained ${result.messages.length} backlog message(s) on startup`,
    });
}
async function runBridge(options) {
    const label = options.agentName ?? "agent";
    const mode = options.hook
        ? "hook"
        : options.autoReply
            ? options.runtime === "fast"
                ? "fast-only"
                : `auto-reply (${options.runtime})`
            : "deliver-only";
    process.stdout.write(`Bridge listening as '${label}' (${mode}).\n`);
    // Drop stale inbox so we don't replay an old hi storm.
    await drainBacklog(options.networkUrl, options.json);
    let stopped = false;
    const cleanup = () => {
        if (stopped)
            return;
        stopped = true;
        process.stdout.write("Bridge stopped.\n");
        process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    while (!stopped) {
        const result = await (0, network_1.fetchInbox)(options.networkUrl, {
            peek: true,
            waitSeconds: 30,
        });
        if (result.kind === "error") {
            process.stderr.write(`inbox error: ${result.message}\n`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
        }
        // Newest first — real questions beat greeting backlog.
        const messages = [...result.messages].sort((a, b) => {
            const ta = Date.parse(a.created_at) || 0;
            const tb = Date.parse(b.created_at) || 0;
            return tb - ta;
        });
        for (const msg of messages) {
            await handleInbound(options.networkUrl, msg, options);
        }
    }
}
