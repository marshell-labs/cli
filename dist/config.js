"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNetworkUrl = getNetworkUrl;
exports.getConfigPath = getConfigPath;
exports.readConfig = readConfig;
exports.writeConfig = writeConfig;
exports.patchConfig = patchConfig;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const DEFAULT_NETWORK_URL = "https://network.marshell.dev";
function getNetworkUrl(config) {
    return (process.env.MARSHELL_NETWORK_URL ??
        config?.networkUrl ??
        DEFAULT_NETWORK_URL);
}
function getConfigPath() {
    if (process.env.MARSHELL_CONFIG) {
        return process.env.MARSHELL_CONFIG;
    }
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".marshell", "config.json");
}
async function readConfig() {
    const path = getConfigPath();
    try {
        const raw = await (0, promises_1.readFile)(path, "utf8");
        const parsed = JSON.parse(raw);
        return parsed;
    }
    catch (error) {
        const maybeCode = error.code;
        if (maybeCode === "ENOENT") {
            return {};
        }
        throw error;
    }
}
async function writeConfig(next) {
    const path = getConfigPath();
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(path), { recursive: true });
    await (0, promises_1.writeFile)(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
async function patchConfig(patch) {
    const current = await readConfig();
    const merged = {
        ...current,
        ...patch,
        networkUrl: patch.networkUrl ?? getNetworkUrl(current),
        updatedAt: new Date().toISOString(),
    };
    await writeConfig(merged);
    return merged;
}
