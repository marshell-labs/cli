"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatRelayOutput = formatRelayOutput;
exports.runRelayCron = runRelayCron;
const pending_1 = require("./pending");
const network_1 = require("./network");
const notify_1 = require("./notify");
const relay_state_1 = require("./relay-state");
function formatItem(item) {
    if (item.kind === "reply" && item.context) {
        return `Reply from ${item.from} (re: ${item.context}):\n${item.text}`;
    }
    return `New from ${item.from}:\n${item.text}`;
}
function formatRelayOutput(items) {
    if (items.length === 0)
        return "";
    return items.map(formatItem).join("\n\n---\n\n");
}
async function runRelayCron(options) {
    const quiet = options.quiet ?? false;
    const pending = await (0, pending_1.listPending)();
    const pendingMap = new Map(pending.map((p) => [p.peer.toLowerCase(), p]));
    if (options.pendingOnly && pending.length === 0) {
        return {
            pending_count: 0,
            relayed: [],
            skipped_relayed: 0,
            message: quiet
                ? undefined
                : "No pending tracked sends — list is empty.",
            notify: !quiet,
        };
    }
    const inbox = await (0, network_1.fetchInbox)(options.networkUrl, { peek: true });
    if (inbox.kind === "error") {
        throw new Error(inbox.message);
    }
    const unrelayed = await (0, relay_state_1.filterUnrelayed)(inbox.messages);
    const skippedRelayed = inbox.messages.length - unrelayed.length;
    const items = [];
    const toAck = [];
    const peersToClear = new Set();
    const notifyCommand = options.notifyCommand?.trim();
    for (const msg of unrelayed) {
        const peer = msg.from.toLowerCase();
        const tracked = pendingMap.get(peer);
        if (tracked) {
            const item = buildItem(msg, tracked, "reply");
            if (notifyCommand) {
                try {
                    await (0, notify_1.runNotifyWithRetry)(notifyCommand, msg, tracked);
                    items.push(item);
                    toAck.push(msg.id);
                    peersToClear.add(peer);
                }
                catch {
                    // Leave in inbox — bridge or next cron will retry webhook delivery.
                }
            }
            else {
                items.push(item);
                toAck.push(msg.id);
                peersToClear.add(peer);
            }
        }
        else if (!options.pendingOnly) {
            const item = buildItem(msg, null, "new");
            if (notifyCommand) {
                try {
                    await (0, notify_1.runNotifyWithRetry)(notifyCommand, msg, null);
                    items.push(item);
                    toAck.push(msg.id);
                }
                catch {
                    // Leave in inbox for retry.
                }
            }
            else {
                items.push(item);
                toAck.push(msg.id);
            }
        }
    }
    if (toAck.length > 0) {
        await (0, network_1.ackMessages)(options.networkUrl, toAck);
        await (0, relay_state_1.markRelayed)(toAck);
    }
    for (const peer of peersToClear) {
        await (0, pending_1.clearPending)(peer);
        await (0, relay_state_1.clearWaitingReported)(peer);
    }
    if (items.length > 0) {
        return {
            pending_count: pending.length,
            relayed: items,
            skipped_relayed: skippedRelayed,
            notify: true,
        };
    }
    let message;
    let notify = !quiet;
    if (pending.length > 0) {
        const waitingPeers = [];
        for (const entry of pending) {
            const shouldReport = await (0, relay_state_1.shouldReportWaiting)(entry.peer, entry.sentAt);
            if (shouldReport) {
                waitingPeers.push(entry.peer);
                await (0, relay_state_1.markWaitingReported)(entry.peer, entry.sentAt);
            }
        }
        if (waitingPeers.length > 0) {
            message = `Waiting for replies from: ${waitingPeers.join(", ")}`;
            notify = true;
        }
        else if (quiet) {
            message = undefined;
            notify = false;
        }
        else {
            message = `Still waiting for: ${pending.map((p) => p.peer).join(", ")}`;
            notify = true;
        }
    }
    return {
        pending_count: pending.length,
        relayed: [],
        skipped_relayed: skippedRelayed,
        message,
        notify,
    };
}
function buildItem(msg, pending, kind) {
    return {
        kind: pending ? "reply" : kind,
        from: msg.from,
        text: msg.text,
        id: msg.id,
        context: pending?.context,
    };
}
