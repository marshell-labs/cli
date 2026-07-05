#!/usr/bin/env node
/**
 * Marshell relay — notify script for gateway agents (Harvey, etc.)
 *
 * Receives JSON on stdin from `marshell listen --notify`:
 *   { event, id, from, text, created_at, pending?: { context, sentText, ... } }
 *
 * Env:
 *   MARSHELL_NOTIFY_WEBHOOK  POST JSON payload to this URL
 *   MARSHELL_NOTIFY_FORMAT   "text" (default) | "json"
 */
import { readFileSync } from "node:fs";

async function main() {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write("relay: invalid JSON on stdin\n");
    process.exit(1);
  }

  const from = payload.from ?? "unknown";
  const text = payload.text ?? "";
  const pending = payload.pending;
  const context = pending?.context ?? pending?.sentText;

  const format = process.env.MARSHELL_NOTIFY_FORMAT ?? "text";
  const webhook = process.env.MARSHELL_NOTIFY_WEBHOOK?.trim();

  let message;
  if (context) {
    message = `Reply from ${from} (re: ${context}):\n${text}`;
  } else {
    message = `New from ${from}:\n${text}`;
  }

  if (webhook) {
    const body = JSON.stringify({
      ...payload,
      message,
      relay: true,
    });
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      process.stderr.write(`relay: webhook ${res.status}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ ...payload, message })}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`relay: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
