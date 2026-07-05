"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterUnrelayed = filterUnrelayed;
exports.markRelayed = markRelayed;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const MAX_IDS = 500;
function statePath() {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".marshell", "relay-state.json");
}
async function readState() {
    try {
        const raw = await (0, promises_1.readFile)(statePath(), "utf8");
        return JSON.parse(raw);
    }
    catch (error) {
        const maybeCode = error.code;
        if (maybeCode === "ENOENT") {
            return { relayedIds: [], updatedAt: new Date().toISOString() };
        }
        throw error;
    }
}
async function writeState(state) {
    await (0, promises_1.mkdir)((0, node_path_1.join)((0, node_os_1.homedir)(), ".marshell"), { recursive: true });
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
    await writeState({
        relayedIds: trimmed,
        updatedAt: new Date().toISOString(),
    });
}
