import { clearPending, listPending, type PendingEntry } from "./pending";
import {
  ackMessages,
  fetchInbox,
  type InboxMessage,
} from "./network";
import { filterUnrelayed, markRelayed } from "./relay-state";

export type RelayItem = {
  kind: "reply" | "new";
  from: string;
  text: string;
  id: string;
  context?: string;
};

export type RelayCronResult = {
  pending_count: number;
  relayed: RelayItem[];
  skipped_relayed: number;
  message?: string;
};

function formatItem(item: RelayItem): string {
  if (item.kind === "reply" && item.context) {
    return `Reply from ${item.from} (re: ${item.context}):\n${item.text}`;
  }
  return `New from ${item.from}:\n${item.text}`;
}

export function formatRelayOutput(items: RelayItem[]): string {
  if (items.length === 0) return "";
  return items.map(formatItem).join("\n\n---\n\n");
}

export async function runRelayCron(options: {
  networkUrl: string;
  pendingOnly: boolean;
}): Promise<RelayCronResult> {
  const pending = await listPending();
  const pendingMap = new Map<string, PendingEntry>(
    pending.map((p) => [p.peer.toLowerCase(), p]),
  );

  if (options.pendingOnly && pending.length === 0) {
    return {
      pending_count: 0,
      relayed: [],
      skipped_relayed: 0,
      message: "No pending tracked sends — list is empty.",
    };
  }

  const inbox = await fetchInbox(options.networkUrl, { peek: true });
  if (inbox.kind === "error") {
    throw new Error(inbox.message);
  }

  const unrelayed = await filterUnrelayed(inbox.messages);
  const skippedRelayed = inbox.messages.length - unrelayed.length;

  const items: RelayItem[] = [];
  const toAck: string[] = [];
  const peersToClear = new Set<string>();

  for (const msg of unrelayed) {
    const peer = msg.from.toLowerCase();
    const tracked = pendingMap.get(peer);

    if (tracked) {
      items.push(buildItem(msg, tracked, "reply"));
      toAck.push(msg.id);
      peersToClear.add(peer);
    } else if (!options.pendingOnly) {
      items.push(buildItem(msg, null, "new"));
      toAck.push(msg.id);
    }
  }

  if (toAck.length > 0) {
    await ackMessages(options.networkUrl, toAck);
    await markRelayed(toAck);
  }

  for (const peer of peersToClear) {
    await clearPending(peer);
  }

  let message: string | undefined;
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

function buildItem(
  msg: InboxMessage,
  pending: PendingEntry | null,
  kind: "reply" | "new",
): RelayItem {
  return {
    kind: pending ? "reply" : kind,
    from: msg.from,
    text: msg.text,
    id: msg.id,
    context: pending?.context,
  };
}
