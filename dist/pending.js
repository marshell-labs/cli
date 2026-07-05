"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackPending = trackPending;
exports.matchPending = matchPending;
exports.clearPending = clearPending;
exports.listPending = listPending;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
function pendingDir() {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".marshell", "pending");
}
function pendingPath(peer) {
    const safe = peer.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    return (0, node_path_1.join)(pendingDir(), `${safe}.json`);
}
async function trackPending(peer, entry) {
    await (0, promises_1.mkdir)(pendingDir(), { recursive: true });
    const full = { peer: peer.toLowerCase(), ...entry };
    await (0, promises_1.writeFile)(pendingPath(peer), `${JSON.stringify(full, null, 2)}\n`, "utf8");
    return full;
}
async function matchPending(peer) {
    try {
        const raw = await (0, promises_1.readFile)(pendingPath(peer), "utf8");
        return JSON.parse(raw);
    }
    catch (error) {
        const maybeCode = error.code;
        if (maybeCode === "ENOENT") {
            return null;
        }
        throw error;
    }
}
async function clearPending(peer) {
    try {
        await (0, promises_1.unlink)(pendingPath(peer));
        return true;
    }
    catch (error) {
        const maybeCode = error.code;
        if (maybeCode === "ENOENT") {
            return false;
        }
        throw error;
    }
}
async function listPending() {
    try {
        const files = await (0, promises_1.readdir)(pendingDir());
        const entries = [];
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const raw = await (0, promises_1.readFile)((0, node_path_1.join)(pendingDir(), file), "utf8");
                entries.push(JSON.parse(raw));
            }
            catch {
                // ignore corrupt files
            }
        }
        return entries.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    }
    catch (error) {
        const maybeCode = error.code;
        if (maybeCode === "ENOENT") {
            return [];
        }
        throw error;
    }
}
