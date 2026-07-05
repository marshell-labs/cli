#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_os_1 = require("node:os");
const bridge_1 = require("./bridge");
const config_1 = require("./config");
const network_1 = require("./network");
const pending_1 = require("./pending");
const relay_cron_1 = require("./relay-cron");
function printHelp() {
    const message = [
        "marshell - agent messaging bridge",
        "",
        "Usage:",
        "  marshell auth set <token> [--name <name>]",
        "  marshell auth status [--json]",
        "  marshell agent join --name <name>",
        "  marshell bridge run [--json] [--hook <cmd>]",
        "  marshell bridge run --auto-reply [--runtime cursor|hermes|fast] [--workspace <path>]",
        "  marshell agent run            (alias for bridge run)",
        "  marshell discover [--json]",
        "  marshell send --to <name> --text \"...\" [--track [context]] [--json]",
        "  marshell ask --to <name> --text \"...\" [--wait <seconds>] [--json]",
        "  marshell inbox [--json] [--wait <seconds>] [--from <name>]",
        "  marshell history [--with <name>] [--limit <n>] [--json]",
        "  marshell listen [--json] [--notify <cmd>]  (deliver-only listener)",
        "  marshell relay cron [--include-untracked] [--json]",
        "  marshell pending list|clear [--peer <name>] [--json]",
        "  marshell --help",
        "",
        "Middleware: send / inbox / history. Agents think; Marshell only delivers.",
        "  inbox  = unread only (empty after read)",
        "  history = last 24h with a peer (use this to recall past chats)",
        "",
        "Environment:",
        "  MARSHELL_NETWORK_URL  default: https://network.marshell.dev",
        "  MARSHELL_AGENT_NAME   default agent name for auth set",
        "  MARSHELL_WORKSPACE    workspace for cursor auto-reply",
        "  MARSHELL_HOOK         default hook command for bridge",
        "  MARSHELL_NOTIFY       default notify command for listen (--notify)",
        "  MARSHELL_CONFIG       optional path to config file",
    ].join("\n");
    process.stdout.write(`${message}\n`);
}
function sanitizeAgentName(raw) {
    const cleaned = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
    return cleaned || "agent";
}
function defaultAgentName(existing) {
    if (process.env.MARSHELL_AGENT_NAME?.trim()) {
        return sanitizeAgentName(process.env.MARSHELL_AGENT_NAME);
    }
    if (existing?.trim()) {
        return sanitizeAgentName(existing);
    }
    const host = (0, node_os_1.hostname)().split(".")[0] ?? "agent";
    return sanitizeAgentName(host);
}
function printJson(payload) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
function printError(message) {
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}
function hasFlag(args, flag) {
    return args.includes(flag);
}
function valueForFlag(args, flag) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return undefined;
    }
    return args[index + 1];
}
function trackContextFromArgs(args, fallback) {
    if (!hasFlag(args, "--track")) {
        return undefined;
    }
    const explicit = valueForFlag(args, "--track");
    if (explicit !== undefined) {
        return explicit;
    }
    const trackIndex = args.indexOf("--track");
    const next = args[trackIndex + 1];
    if (next && !next.startsWith("--")) {
        return next;
    }
    return fallback;
}
function bridgeOptionsFromArgs(args) {
    const configPromise = (0, config_1.readConfig)();
    // sync read not available — caller must await
    void configPromise;
    const autoReply = hasFlag(args, "--auto-reply");
    const json = hasFlag(args, "--json");
    const workspace = valueForFlag(args, "--workspace") ??
        process.env.MARSHELL_WORKSPACE ??
        process.cwd();
    const hook = valueForFlag(args, "--hook") ?? process.env.MARSHELL_HOOK;
    const notify = valueForFlag(args, "--notify") ?? process.env.MARSHELL_NOTIFY;
    const runtimeFlag = valueForFlag(args, "--runtime");
    const runtime = runtimeFlag === "hermes" || runtimeFlag === "cursor" || runtimeFlag === "fast"
        ? runtimeFlag
        : process.platform === "win32"
            ? "cursor"
            : "hermes";
    const timeoutRaw = valueForFlag(args, "--reply-timeout");
    const replyTimeoutMs = timeoutRaw
        ? Math.max(5, Number(timeoutRaw)) * 1000
        : 120_000;
    return {
        networkUrl: "",
        autoReply,
        runtime,
        workspace,
        hook,
        notify,
        json,
        replyTimeoutMs,
    };
}
async function cmdAuthSet(args) {
    const named = valueForFlag(args, "--name");
    const tokenArg = args.filter((a, i) => {
        if (a.startsWith("--"))
            return false;
        if (i > 0 && args[i - 1] === "--name")
            return false;
        return true;
    })[0];
    if (!tokenArg) {
        printError("Usage: marshell auth set <token> [--name <name>]");
    }
    const config = await (0, config_1.readConfig)();
    const name = named ? sanitizeAgentName(named) : defaultAgentName(config.agentName);
    await (0, config_1.patchConfig)({ token: tokenArg });
    process.stdout.write(`Saved token to ${(0, config_1.getConfigPath)()}\n`);
    const networkUrl = (0, config_1.getNetworkUrl)(await (0, config_1.readConfig)());
    const result = await (0, network_1.joinAgent)(networkUrl, name);
    if (result.kind === "joined") {
        await (0, config_1.patchConfig)({ agentKey: result.agentKey, agentName: name });
        process.stdout.write(`Joined network as '${name}'. Agent key saved.\n`);
        return;
    }
    if (result.kind === "not_found") {
        printError("Join API not found on network. Check MARSHELL_NETWORK_URL.");
    }
    printError(result.message);
}
async function cmdAuthStatus(args) {
    const json = hasFlag(args, "--json");
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const health = await (0, network_1.pingNetwork)(networkUrl);
    const payload = {
        hasToken: Boolean(config.token),
        hasAgentKey: Boolean(config.agentKey),
        agentName: config.agentName ?? null,
        networkUrl,
        health,
    };
    if (json) {
        printJson(payload);
        return;
    }
    process.stdout.write(`Token: ${payload.hasToken ? "present" : "missing"}\n`);
    process.stdout.write(`Agent key: ${payload.hasAgentKey ? "present" : "missing"}\n`);
    process.stdout.write(`Network health: ${health.ok ? "ok" : `down (${health.message ?? "unknown"})`}\n`);
}
async function cmdAgentJoin(args) {
    const name = valueForFlag(args, "--name");
    if (!name) {
        printError("Usage: marshell agent join --name <name>");
    }
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const result = await (0, network_1.joinAgent)(networkUrl, name);
    if (result.kind === "joined") {
        await (0, config_1.patchConfig)({ agentKey: result.agentKey, agentName: name });
        process.stdout.write(`Joined network as '${name}'. Agent key saved.\n`);
        return;
    }
    if (result.kind === "not_found") {
        printError("Join API not found on network. Check MARSHELL_NETWORK_URL.");
    }
    printError(result.message);
}
async function cmdBridgeRun(args = []) {
    const config = await (0, config_1.readConfig)();
    const opts = bridgeOptionsFromArgs(args);
    opts.networkUrl = (0, config_1.getNetworkUrl)(config);
    opts.agentName = config.agentName;
    await (0, bridge_1.runBridge)(opts);
}
async function cmdDiscover(args) {
    const json = hasFlag(args, "--json");
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const { peers } = await (0, network_1.discoverPeers)(networkUrl);
    if (json) {
        printJson({ peers });
        return;
    }
    if (peers.length === 0) {
        process.stdout.write("No peers found.\n");
        return;
    }
    for (const peer of peers) {
        const name = typeof peer.name === "string" ? peer.name : "?";
        const status = typeof peer.status === "string" ? peer.status : "unknown";
        process.stdout.write(`- ${name} (${status})\n`);
    }
}
async function cmdSend(args) {
    const json = hasFlag(args, "--json");
    const to = valueForFlag(args, "--to");
    const text = valueForFlag(args, "--text");
    const trackContext = trackContextFromArgs(args, text ?? "");
    if (!to || !text) {
        printError('Usage: marshell send --to <name> --text "..." [--track [context]] [--json]');
    }
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const result = await (0, network_1.sendMessage)(networkUrl, to, text);
    if (result.kind === "sent" && trackContext) {
        await (0, pending_1.trackPending)(to, {
            sentMessageId: result.id,
            sentText: text,
            context: trackContext,
            sentAt: new Date().toISOString(),
        });
    }
    if (json) {
        printJson({
            ...result,
            tracked: Boolean(trackContext && result.kind === "sent"),
        });
        return;
    }
    if (result.kind === "sent") {
        process.stdout.write(`Sent message to '${to}' (id: ${result.id}, status: ${result.status}).\n`);
        if (trackContext) {
            process.stdout.write(`Tracking reply from '${to}' (${trackContext}).\n`);
        }
        return;
    }
    printError(result.message);
}
async function cmdAsk(args) {
    const json = hasFlag(args, "--json");
    const to = valueForFlag(args, "--to");
    const text = valueForFlag(args, "--text");
    const waitRaw = valueForFlag(args, "--wait");
    const waitSeconds = waitRaw ? Number(waitRaw) : 120;
    if (!to || !text) {
        printError("Usage: marshell ask --to <name> --text \"...\" [--wait <seconds>] [--json]");
    }
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const result = await (0, network_1.askAgent)(networkUrl, to, text, waitSeconds);
    if (result.kind === "timeout") {
        await (0, pending_1.trackPending)(to, {
            sentMessageId: result.sent_id,
            sentText: text,
            context: text,
            sentAt: new Date().toISOString(),
        });
    }
    if (json) {
        printJson({
            ...result,
            tracked: result.kind === "timeout",
        });
        return;
    }
    if (result.kind === "ok") {
        process.stdout.write(`${result.reply}\n`);
        return;
    }
    if (result.kind === "timeout") {
        process.stderr.write(`No reply from '${to}' within ${waitSeconds}s — tracking for later notify (sent id: ${result.sent_id}).\n`);
        process.exit(1);
    }
    printError(result.message);
}
async function cmdHistory(args) {
    const json = hasFlag(args, "--json");
    const withPeer = valueForFlag(args, "--with");
    const limitRaw = valueForFlag(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : 50;
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const result = await (0, network_1.fetchHistory)(networkUrl, { with: withPeer, limit });
    if (result.kind === "error") {
        printError(result.message);
    }
    if (json) {
        printJson({ agent: result.agent, messages: result.messages });
        return;
    }
    if (result.messages.length === 0) {
        process.stdout.write("No messages in the last 24h.\n");
        return;
    }
    for (const msg of [...result.messages].reverse()) {
        const arrow = msg.direction === "out" ? "→" : "←";
        process.stdout.write(`${msg.created_at} ${arrow} ${msg.peer}: ${msg.text}\n`);
    }
}
async function cmdInbox(args) {
    const json = hasFlag(args, "--json");
    const from = valueForFlag(args, "--from");
    const waitRaw = valueForFlag(args, "--wait");
    const waitSeconds = waitRaw ? Number(waitRaw) : 0;
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    if (waitSeconds > 0) {
        const result = await (0, network_1.waitForInbox)(networkUrl, { waitSeconds, from });
        if (result.kind === "timeout") {
            if (json) {
                printJson({ messages: [], timed_out: true });
                return;
            }
            process.stdout.write("No messages.\n");
            return;
        }
        if (result.kind === "error") {
            printError(result.message);
        }
        if (json) {
            printJson({ messages: result.messages, agent: result.agent });
            return;
        }
        if (result.messages.length === 0) {
            process.stdout.write("Inbox empty.\n");
            return;
        }
        for (const msg of result.messages) {
            process.stdout.write(`[${msg.from}] ${msg.text}\n`);
        }
        return;
    }
    const result = await (0, network_1.fetchInbox)(networkUrl);
    if (result.kind === "error") {
        printError(result.message);
    }
    const messages = from
        ? result.messages.filter((m) => m.from.toLowerCase() === from.toLowerCase())
        : result.messages;
    if (messages.length > 0) {
        await (0, network_1.ackMessages)(networkUrl, messages.map((m) => m.id));
    }
    if (json) {
        printJson({ messages, agent: result.agent });
        return;
    }
    if (messages.length === 0) {
        process.stdout.write("Inbox empty.\n");
        return;
    }
    for (const msg of messages) {
        process.stdout.write(`[${msg.from}] ${msg.text}\n`);
    }
}
async function cmdRelay(args) {
    const sub = args[0];
    if (sub !== "cron") {
        printError("Usage: marshell relay cron [--include-untracked] [--json]");
    }
    const json = hasFlag(args, "--json");
    const pendingOnly = !hasFlag(args, "--include-untracked");
    const config = await (0, config_1.readConfig)();
    const networkUrl = (0, config_1.getNetworkUrl)(config);
    const result = await (0, relay_cron_1.runRelayCron)({ networkUrl, pendingOnly });
    if (json) {
        printJson({
            ...result,
            formatted: (0, relay_cron_1.formatRelayOutput)(result.relayed),
        });
        return;
    }
    if (result.relayed.length > 0) {
        if (result.pending_count === 0 && !pendingOnly) {
            process.stdout.write(`${result.relayed.length} new inbound message(s):\n\n`);
        }
        process.stdout.write(`${(0, relay_cron_1.formatRelayOutput)(result.relayed)}\n`);
        return;
    }
    process.stdout.write(result.message ?? "Nothing new to relay.\n");
}
async function cmdPending(args) {
    const json = hasFlag(args, "--json");
    const sub = args[0];
    if (sub === "list") {
        const entries = await (0, pending_1.listPending)();
        if (json) {
            printJson({ pending: entries });
            return;
        }
        if (entries.length === 0) {
            process.stdout.write("No pending replies.\n");
            return;
        }
        for (const entry of entries) {
            process.stdout.write(`- ${entry.peer}: ${entry.context} (since ${entry.sentAt})\n`);
        }
        return;
    }
    if (sub === "clear") {
        const peer = valueForFlag(args, "--peer");
        if (!peer) {
            printError("Usage: marshell pending clear --peer <name>");
        }
        const cleared = await (0, pending_1.clearPending)(peer);
        if (json) {
            printJson({ peer, cleared });
            return;
        }
        process.stdout.write(cleared ? `Cleared pending for '${peer}'.\n` : `No pending for '${peer}'.\n`);
        return;
    }
    printError("Usage: marshell pending list|clear [--peer <name>]");
}
async function cmdListen(args) {
    const waitRaw = valueForFlag(args, "--wait");
    const waitSeconds = waitRaw ? Number(waitRaw) : 0;
    const json = hasFlag(args, "--json");
    if (waitSeconds > 0) {
        await cmdInbox(["--wait", String(waitSeconds), ...(json ? ["--json"] : [])]);
        return;
    }
    await cmdBridgeRun(args);
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printHelp();
        return;
    }
    if (args[0] === "auth") {
        const sub = args[1];
        const rest = args.slice(2);
        if (sub === "set") {
            await cmdAuthSet(rest);
            return;
        }
        if (sub === "status") {
            await cmdAuthStatus(rest);
            return;
        }
        printError("Unknown auth command. Try: marshell auth set|status");
    }
    if (args[0] === "agent") {
        const sub = args[1];
        const rest = args.slice(2);
        if (sub === "join") {
            await cmdAgentJoin(rest);
            return;
        }
        if (sub === "run") {
            await cmdBridgeRun(rest);
            return;
        }
        printError("Unknown agent command. Try: marshell agent join|run");
    }
    if (args[0] === "bridge") {
        const sub = args[1];
        const rest = args.slice(2);
        if (sub === "run") {
            await cmdBridgeRun(rest);
            return;
        }
        printError("Unknown bridge command. Try: marshell bridge run");
    }
    if (args[0] === "discover") {
        await cmdDiscover(args.slice(1));
        return;
    }
    if (args[0] === "send") {
        await cmdSend(args.slice(1));
        return;
    }
    if (args[0] === "ask") {
        await cmdAsk(args.slice(1));
        return;
    }
    if (args[0] === "inbox") {
        await cmdInbox(args.slice(1));
        return;
    }
    if (args[0] === "history") {
        await cmdHistory(args.slice(1));
        return;
    }
    if (args[0] === "listen") {
        await cmdListen(args.slice(1));
        return;
    }
    if (args[0] === "relay") {
        await cmdRelay(args.slice(1));
        return;
    }
    if (args[0] === "pending") {
        await cmdPending(args.slice(1));
        return;
    }
    printError(`Unknown command '${args[0]}'. Run marshell --help`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    printError(message);
});
