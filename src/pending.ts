import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type PendingEntry = {
  peer: string;
  sentMessageId: string;
  sentText: string;
  context: string;
  sentAt: string;
  channel?: string;
};

function pendingDir(): string {
  return join(homedir(), ".marshell", "pending");
}

function pendingPath(peer: string): string {
  const safe = peer.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return join(pendingDir(), `${safe}.json`);
}

export async function trackPending(
  peer: string,
  entry: Omit<PendingEntry, "peer">,
): Promise<PendingEntry> {
  await mkdir(pendingDir(), { recursive: true });
  const full: PendingEntry = { peer: peer.toLowerCase(), ...entry };
  await writeFile(pendingPath(peer), `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return full;
}

export async function matchPending(peer: string): Promise<PendingEntry | null> {
  try {
    const raw = await readFile(pendingPath(peer), "utf8");
    return JSON.parse(raw) as PendingEntry;
  } catch (error) {
    const maybeCode = (error as { code?: string }).code;
    if (maybeCode === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function clearPending(peer: string): Promise<boolean> {
  try {
    await unlink(pendingPath(peer));
    return true;
  } catch (error) {
    const maybeCode = (error as { code?: string }).code;
    if (maybeCode === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function listPending(): Promise<PendingEntry[]> {
  try {
    const files = await readdir(pendingDir());
    const entries: PendingEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(pendingDir(), file), "utf8");
        entries.push(JSON.parse(raw) as PendingEntry);
      } catch {
        // ignore corrupt files
      }
    }
    return entries.sort(
      (a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt),
    );
  } catch (error) {
    const maybeCode = (error as { code?: string }).code;
    if (maybeCode === "ENOENT") {
      return [];
    }
    throw error;
  }
}
