#!/usr/bin/env node
import { hostname } from "node:os";
import { getConfigPath, getNetworkUrl, patchConfig, readConfig } from "./config";
import {
  discoverPeers,
  joinAgent,
  pingNetwork,
  sendMessage,
  toWsUrl,
} from "./network";

type JsonShape = Record<string, unknown>;

function printHelp(): void {
  const message = [
    "marshell - Phase 0 CLI",
    "",
    "Usage:",
    "  marshell auth set <token> [--name <name>]",
    "  marshell auth status [--json]",
    "  marshell agent join --name <name>",
    "  marshell agent run",
    "  marshell discover [--json]",
    "  marshell send --to <name> --text \"...\" [--json]",
    "  marshell --help",
    "",
    "Environment:",
    "  MARSHELL_NETWORK_URL  default: https://network.marshell.dev",
    "  MARSHELL_AGENT_NAME   default agent name for auth set",
    "  MARSHELL_CONFIG       optional path to config file",
  ].join("\n");
  process.stdout.write(`${message}\n`);
}

function sanitizeAgentName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "agent";
}

function defaultAgentName(existing?: string): string {
  if (process.env.MARSHELL_AGENT_NAME?.trim()) {
    return sanitizeAgentName(process.env.MARSHELL_AGENT_NAME);
  }
  if (existing?.trim()) {
    return sanitizeAgentName(existing);
  }
  const host = hostname().split(".")[0] ?? "agent";
  return sanitizeAgentName(host);
}

function printJson(payload: JsonShape): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printError(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function valueForFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function cmdAuthSet(args: string[]): Promise<void> {
  const named = valueForFlag(args, "--name");
  const tokenArg = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (i > 0 && args[i - 1] === "--name") return false;
    return true;
  })[0];

  if (!tokenArg) {
    printError("Usage: marshell auth set <token> [--name <name>]");
  }

  const config = await readConfig();
  const name = named ? sanitizeAgentName(named) : defaultAgentName(config.agentName);

  await patchConfig({ token: tokenArg });
  process.stdout.write(`Saved token to ${getConfigPath()}\n`);

  const networkUrl = getNetworkUrl(await readConfig());
  const result = await joinAgent(networkUrl, name);

  if (result.kind === "joined") {
    await patchConfig({ agentKey: result.agentKey, agentName: name });
    process.stdout.write(`Joined network as '${name}'. Agent key saved.\n`);
    return;
  }

  if (result.kind === "not_found") {
    printError("Join API not found on network. Check MARSHELL_NETWORK_URL.");
  }

  printError(result.message);
}

async function cmdAuthStatus(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const config = await readConfig();
  const networkUrl = getNetworkUrl(config);
  const health = await pingNetwork(networkUrl);

  const payload: JsonShape = {
    hasToken: Boolean(config.token),
    hasAgentKey: Boolean(config.agentKey),
    networkUrl,
    health,
  };

  if (json) {
    printJson(payload);
    return;
  }

  process.stdout.write(`Token: ${payload.hasToken ? "present" : "missing"}\n`);
  process.stdout.write(
    `Agent key: ${payload.hasAgentKey ? "present" : "missing"}\n`,
  );
  process.stdout.write(
    `Network health: ${health.ok ? "ok" : `down (${health.message ?? "unknown"})`}\n`,
  );
}

async function cmdAgentJoin(args: string[]): Promise<void> {
  const name = valueForFlag(args, "--name");
  if (!name) {
    printError("Usage: marshell agent join --name <name>");
  }

  const config = await readConfig();
  const networkUrl = getNetworkUrl(config);
  const result = await joinAgent(networkUrl, name);

  if (result.kind === "joined") {
    await patchConfig({ agentKey: result.agentKey, agentName: name });
    process.stdout.write(`Joined network as '${name}'. Agent key saved.\n`);
    return;
  }

  if (result.kind === "not_found") {
    printError("Join API not found on network. Check MARSHELL_NETWORK_URL.");
  }

  printError(result.message);
}

function setupHeartbeat(message: string): NodeJS.Timeout {
  process.stdout.write(`${message}\n`);
  return setInterval(() => {
    process.stdout.write(`[heartbeat] ${new Date().toISOString()}\n`);
  }, 30_000);
}

async function tryConnectAgentWs(url: string): Promise<boolean> {
  const wsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!wsCtor) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const ws = new wsCtor(url);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        resolve(false);
      }
    }, 4000);

    ws.onopen = () => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      process.stdout.write(`Connected to ${url}\n`);
      ws.onmessage = (event) => {
        process.stdout.write(`[message] ${String(event.data)}\n`);
      };
      resolve(true);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve(false);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
  });
}

async function cmdAgentRun(): Promise<void> {
  const config = await readConfig();
  const networkUrl = getNetworkUrl(config);
  const wsUrl = toWsUrl(networkUrl);

  const connected = await tryConnectAgentWs(wsUrl);
  const timer = setupHeartbeat(
    connected
      ? "Agent loop active. Waiting for work..."
      : "waiting for network WSS (Phase 1)",
  );

  const cleanup = (): void => {
    clearInterval(timer);
    process.stdout.write("Exiting agent loop.\n");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function cmdDiscover(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const config = await readConfig();
  const networkUrl = getNetworkUrl(config);
  const discovered = await discoverPeers(networkUrl);

  if (json) {
    printJson({ peers: discovered.peers });
    return;
  }

  if (discovered.peers.length === 0) {
    process.stdout.write("No peers discovered.\n");
    return;
  }

  process.stdout.write(`Discovered ${discovered.peers.length} peer(s):\n`);
  for (const peer of discovered.peers) {
    process.stdout.write(`- ${JSON.stringify(peer)}\n`);
  }
}

async function cmdSend(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const to = valueForFlag(args, "--to");
  const text = valueForFlag(args, "--text");

  if (!to || !text) {
    printError("Usage: marshell send --to <name> --text \"...\" [--json]");
  }

  const config = await readConfig();
  const networkUrl = getNetworkUrl(config);
  const result = await sendMessage(networkUrl, to, text);

  if (json) {
    printJson(result as unknown as JsonShape);
    return;
  }

  if (result.kind === "sent") {
    process.stdout.write(`Sent message to '${to}' (id: ${result.id}).\n`);
    return;
  }

  if (result.kind === "stubbed") {
    process.stdout.write(`Warning: ${result.reason}\n`);
    return;
  }

  printError(result.message);
}

async function main(): Promise<void> {
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
      await cmdAgentRun();
      return;
    }

    printError("Unknown agent command. Try: marshell agent join|run");
  }

  if (args[0] === "discover") {
    await cmdDiscover(args.slice(1));
    return;
  }

  if (args[0] === "send") {
    await cmdSend(args.slice(1));
    return;
  }

  printError(`Unknown command '${args[0]}'. Run marshell --help`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  printError(message);
});
