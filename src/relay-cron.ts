import { clearPending, listPending, type PendingEntry } from "./pending";
import {
  ackMessages,
  fetchInbox,
  type InboxMessage,
} from "./network";
import { runNotifyWithRetry } from "./notify";
import {
  clearWaitingReported,
  filterUnrelayed,
  markRelayed,
  markWaitingReported,
  shouldReportWaiting,
} from "./relay-state";

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
  /** False in --quiet mode when there is nothing worth messaging the human. */
  notify: boolean;
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
  quiet?: boolean;
  notifyCommand?: string;
}): Promise<RelayCronResult> {
  const quiet = options.quiet ?? false;
  const pending = await listPending();
  const pendingMap = new Map<string, PendingEntry>(
    pending.map((p) => [p.peer.toLowerCase(), p]),
  );

  if (options.pendingOnly && pending.length === 0) {
    return {
      pending_count: 0,
      relayed: [],
      skipped_relayed: 0,
      message: quiet
        ? undefined
        : "No pending tracked sends — list is empty.",
      notify: !quiet,
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
  const notifyCommand = options.notifyCommand?.trim();

  for (const msg of unrelayed) {
    const peer = msg.from.toLowerCase();
    const tracked = pendingMap.get(peer);

    if (tracked) {
      const item = buildItem(msg, tracked, "reply");
      if (notifyCommand) {
        try {
          await runNotifyWithRetry(notifyCommand, msg, tracked);
          items.push(item);
          toAck.push(msg.id);
          peersToClear.add(peer);
        } catch {
          // Leave in inbox — bridge or next cron will retry webhook delivery.
        }
      } else {
        items.push(item);
        toAck.push(msg.id);
        peersToClear.add(peer);
      }
    } else if (!options.pendingOnly) {
      const item = buildItem(msg, null, "new");
      if (notifyCommand) {
        try {
          await runNotifyWithRetry(notifyCommand, msg, null);
          items.push(item);
          toAck.push(msg.id);
        } catch {
          // Leave in inbox for retry.
        }
      } else {
        items.push(item);
        toAck.push(msg.id);
      }
    }
  }

  if (toAck.length > 0) {
    await ackMessages(options.networkUrl, toAck);
    await markRelayed(toAck);
  }

  for (const peer of peersToClear) {
    await clearPending(peer);
    await clearWaitingReported(peer);
  }

  if (items.length > 0) {
    return {
      pending_count: pending.length,
      relayed: items,
      skipped_relayed: skippedRelayed,
      notify: true,
    };
  }

  let message: string | undefined;
  let notify = !quiet;

  if (pending.length > 0) {
    const waitingPeers: string[] = [];
    for (const entry of pending) {
      const shouldReport = await shouldReportWaiting(entry.peer, entry.sentAt);
      if (shouldReport) {
        waitingPeers.push(entry.peer);
        await markWaitingReported(entry.peer, entry.sentAt);
      }
    }
    if (waitingPeers.length > 0) {
      message = `Waiting for replies from: ${waitingPeers.join(", ")}`;
      notify = true;
    } else if (quiet) {
      message = undefined;
      notify = false;
    } else {
      message = `Still waiting for: ${pending.map((p) => p.peer).join(", ")}`;
      notify = true;
    }
  }

  return {
    pending_count: pending.length,
    relayed: [],
    skipped_relayed: skippedRelayed,
    message,
    notify,
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
