"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterUnrelayed = filterUnrelayed;
exports.markRelayed = markRelayed;
exports.shouldReportWaiting = shouldReportWaiting;
exports.markWaitingReported = markWaitingReported;
exports.clearWaitingReported = clearWaitingReported;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const MAX_IDS = 500;
function statePath() {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".marshell", "relay-state.json");
}
function emptyState() {
    return {
        relayedIds: [],
        waitingReported: {},
        updatedAt: new Date().toISOString(),
    };
}
async function readState() {
    try {
        const raw = await (0, promises_1.readFile)(statePath(), "utf8");
        const parsed = JSON.parse(raw);
        return {
            relayedIds: parsed.relayedIds ?? [],
            waitingReported: parsed.waitingReported ?? {},
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        };
    }
    catch (error) {
        const maybeCode = error.code;
        if (maybeCode === "ENOENT") {
            return emptyState();
        }
        throw error;
    }
}
async function writeState(state) {
    await (0, promises_1.mkdir)((0, node_path_1.join)((0, node_os_1.homedir)(), ".marshell"), { recursive: true });
    await writeStateFile(state);
}
async function writeStateFile(state) {
    await (0, promises_1.writeFile)(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
async function filterUnrelayed(messages) {
    const state = await readState();
    const seen = new Set(state.relayedIds);
    return messages.filter((m) => !seen.has(m.id));
}
async function markRelayed(ids) {
    if (ids.length === 0)
        return;
    const state = await readState();
    const merged = [...new Set([...state.relayedIds, ...ids])];
    const trimmed = merged.length > MAX_IDS ? merged.slice(merged.length - MAX_IDS) : merged;
    await writeStateFile({
        ...state,
        relayedIds: trimmed,
        updatedAt: new Date().toISOString(),
    });
}
/** True if we should tell the human we're waiting on this peer (once per pending). */
async function shouldReportWaiting(peer, pendingSentAt) {
    const state = await readState();
    const key = peer.toLowerCase();
    return state.waitingReported[key] !== pendingSentAt;
}
async function markWaitingReported(peer, pendingSentAt) {
    const state = await readState();
    const key = peer.toLowerCase();
    await writeStateFile({
        ...state,
        waitingReported: { ...state.waitingReported, [key]: pendingSentAt },
        updatedAt: new Date().toISOString(),
    });
}
async function clearWaitingReported(peer) {
    const state = await readState();
    const key = peer.toLowerCase();
    if (!(key in state.waitingReported))
        return;
    const next = { ...state.waitingReported };
    delete next[key];
    await writeStateFile({
        ...state,
        waitingReported: next,
        updatedAt: new Date().toISOString(),
    });
}
