import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InboxMessage } from "./network";

type RelayState = {
  relayedIds: string[];
  /** Peers we already told the human we're waiting on (pending sentAt). */
  waitingReported: Record<string, string>;
  updatedAt: string;
};

const MAX_IDS = 500;

function statePath(): string {
  return join(homedir(), ".marshell", "relay-state.json");
}

function emptyState(): RelayState {
  return {
    relayedIds: [],
    waitingReported: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readState(): Promise<RelayState> {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as RelayState;
    return {
      relayedIds: parsed.relayedIds ?? [],
      waitingReported: parsed.waitingReported ?? {},
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    const maybeCode = (error as { code?: string }).code;
    if (maybeCode === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

async function writeState(state: RelayState): Promise<void> {
  await mkdir(join(homedir(), ".marshell"), { recursive: true });
  await writeStateFile(state);
}

async function writeStateFile(state: RelayState): Promise<void> {
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
  await writeStateFile({
    ...state,
    relayedIds: trimmed,
    updatedAt: new Date().toISOString(),
  });
}

/** True if we should tell the human we're waiting on this peer (once per pending). */
export async function shouldReportWaiting(
  peer: string,
  pendingSentAt: string,
): Promise<boolean> {
  const state = await readState();
  const key = peer.toLowerCase();
  return state.waitingReported[key] !== pendingSentAt;
}

export async function markWaitingReported(
  peer: string,
  pendingSentAt: string,
): Promise<void> {
  const state = await readState();
  const key = peer.toLowerCase();
  await writeStateFile({
    ...state,
    waitingReported: { ...state.waitingReported, [key]: pendingSentAt },
    updatedAt: new Date().toISOString(),
  });
}

export async function clearWaitingReported(peer: string): Promise<void> {
  const state = await readState();
  const key = peer.toLowerCase();
  if (!(key in state.waitingReported)) return;
  const next = { ...state.waitingReported };
  delete next[key];
  await writeStateFile({
    ...state,
    waitingReported: next,
    updatedAt: new Date().toISOString(),
  });
}
