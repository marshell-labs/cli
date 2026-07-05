"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatRelayOutput = formatRelayOutput;
exports.runRelayCron = runRelayCron;
const pending_1 = require("./pending");
const network_1 = require("./network");
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
    const pending = await (0, pending_1.listPending)();
    const pendingMap = new Map(pending.map((p) => [p.peer.toLowerCase(), p]));
    if (options.pendingOnly && pending.length === 0) {
        return {
            pending_count: 0,
            relayed: [],
            skipped_relayed: 0,
            message: "No pending tracked sends — list is empty.",
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
    for (const msg of unrelayed) {
        const peer = msg.from.toLowerCase();
        const tracked = pendingMap.get(peer);
        if (tracked) {
            items.push(buildItem(msg, tracked, "reply"));
            toAck.push(msg.id);
            peersToClear.add(peer);
        }
        else if (!options.pendingOnly) {
            items.push(buildItem(msg, null, "new"));
            toAck.push(msg.id);
        }
    }
    if (toAck.length > 0) {
        await (0, network_1.ackMessages)(options.networkUrl, toAck);
        await (0, relay_state_1.markRelayed)(toAck);
    }
    for (const peer of peersToClear) {
        await (0, pending_1.clearPending)(peer);
    }
    let message;
    if (items.length === 0 && pending.length > 0) {
        const names = pending.map((p) => p.peer).join(", ");
        message = `Waiting for replies from: ${names}`;
    }
    return {
        pending_count: pending.length,
        relayed: items,
        skipped_relayed: skippedRelayed,
        message,
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
