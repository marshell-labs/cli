import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MarshellConfig = {
  token?: string;
  agentKey?: string;
  agentName?: string;
  networkUrl?: string;
  updatedAt?: string;
};

const DEFAULT_NETWORK_URL = "https://network.marshell.dev";

export function getNetworkUrl(config?: MarshellConfig): string {
  return (
    process.env.MARSHELL_NETWORK_URL ??
    config?.networkUrl ??
    DEFAULT_NETWORK_URL
  );
}

export function getConfigPath(): string {
  if (process.env.MARSHELL_CONFIG) {
    return process.env.MARSHELL_CONFIG;
  }

  return join(homedir(), ".marshell", "config.json");
}

export async function readConfig(): Promise<MarshellConfig> {
  const path = getConfigPath();

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as MarshellConfig;
    return parsed;
  } catch (error) {
    const maybeCode = (error as { code?: string }).code;
    if (maybeCode === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeConfig(next: MarshellConfig): Promise<void> {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function patchConfig(
  patch: Partial<MarshellConfig>,
): Promise<MarshellConfig> {
  const current = await readConfig();
  const merged: MarshellConfig = {
    ...current,
    ...patch,
    networkUrl: patch.networkUrl ?? getNetworkUrl(current),
    updatedAt: new Date().toISOString(),
  };
  await writeConfig(merged);
  return merged;
}
