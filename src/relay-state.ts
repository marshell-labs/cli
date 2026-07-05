import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InboxMessage } from "./network";

type RelayState = {
  relayedIds: string[];
  updatedAt: string;
};

const MAX_IDS = 500;

function statePath(): string {
  return join(homedir(), ".marshell", "relay-state.json");
}

async function readState(): Promise<RelayState> {
  try {
    const raw = await readFile(statePath(), "utf8");
    return JSON.parse(raw) as RelayState;
  } catch (error) {
    const maybeCode = (error as { code?: string }).code;
    if (maybeCode === "ENOENT") {
      return { relayedIds: [], updatedAt: new Date().toISOString() };
    }
    throw error;
  }
}

async function writeState(state: RelayState): Promise<void> {
  await mkdir(join(homedir(), ".marshell"), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function filterUnrelayed(
  messages: InboxMessage[],
): Promise<InboxMessage[]> {
  const state = await readState();
  const seen = new Set(state.relayedIds);
  return messages.filter((m) => !seen.has(m.id));
}

export async function markRelayed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const state = await readState();
  const merged = [...new Set([...state.relayedIds, ...ids])];
  const trimmed =
    merged.length > MAX_IDS ? merged.slice(merged.length - MAX_IDS) : merged;
  await writeState({
    relayedIds: trimmed,
    updatedAt: new Date().toISOString(),
  });
}
