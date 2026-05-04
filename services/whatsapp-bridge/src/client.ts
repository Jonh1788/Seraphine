import { Client, LocalAuth } from "whatsapp-web.js";
// @ts-ignore — no types available
import qrcodeTerminal from "qrcode-terminal";
import type { Config } from "./config";
import { dispatchWebhook } from "./webhook";

export type ClientStatus =
  | "disconnected"
  | "qr_pending"
  | "authenticating"
  | "ready";

let client: Client;
let currentStatus: ClientStatus = "disconnected";
let currentQr: string | null = null;
let qrTimestamp: number | null = null;
let startedAt: number | null = null;

const QR_EXPIRY_S = 20;

// Bounded ring buffer of recent inbound messages — exposed via
// /api/recent for the unified Manager UI. Process-local; resets on
// container restart (acceptable — webhook log is the durable store).
const RECENT_MAX = 50;
export interface RecentMessage {
  chatId: string;
  chatName: string;
  author: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
}
const recent: RecentMessage[] = [];

export function getRecent(limit = 20): RecentMessage[] {
  const n = Math.max(1, Math.min(RECENT_MAX, limit));
  return recent.slice(-n).reverse();
}

export function getClient(): Client {
  return client;
}

export function getStatus(): ClientStatus {
  return currentStatus;
}

export function getCurrentQr(): { qr: string | null; expiresInS: number } {
  if (!currentQr || !qrTimestamp) {
    return { qr: null, expiresInS: 0 };
  }
  const elapsed = (Date.now() - qrTimestamp) / 1000;
  const remaining = Math.max(0, QR_EXPIRY_S - elapsed);
  if (remaining <= 0) {
    return { qr: null, expiresInS: 0 };
  }
  return { qr: currentQr, expiresInS: Math.round(remaining) };
}

export function getUptime(): number {
  if (!startedAt) return 0;
  return Math.round((Date.now() - startedAt) / 1000);
}

export function initClient(config: Config): Client {
  client = new Client({
    authStrategy: new LocalAuth(),
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    puppeteer: {
      headless: "new" as any,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=ServiceWorker",
      ],
    },
  });

  client.on("qr", (qr: string) => {
    currentStatus = "qr_pending";
    currentQr = qr;
    qrTimestamp = Date.now();
    console.log("[whatsapp-bridge] QR available at GET /api/qr");
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    currentStatus = "authenticating";
    currentQr = null;
    qrTimestamp = null;
    console.log("[whatsapp-bridge] session authenticated");
  });

  client.on("auth_failure", (msg: string) => {
    currentStatus = "disconnected";
    currentQr = null;
    qrTimestamp = null;
    console.error("[whatsapp-bridge] auth failure:", msg);
  });

  client.on("ready", () => {
    currentStatus = "ready";
    startedAt = Date.now();
    const info = client.info;
    console.log(
      `[whatsapp-bridge] ready as ${info?.pushname ?? "?"} (${info?.wid?.user ?? "?"})`
    );
    console.log(`[whatsapp-bridge] webhook target: ${config.webhookUrl}`);
  });

  client.on("disconnected", (reason: string) => {
    currentStatus = "disconnected";
    startedAt = null;
    console.log("[whatsapp-bridge] disconnected:", reason);
  });

  client.on("message", async (msg) => {
    if (currentStatus !== "ready") return;

    const chat = await msg.getChat();
    const contact = await msg.getContact();

    const author = contact.pushname ?? contact.name ?? contact.number;

    // Push to bounded ring buffer for the Manager UI feed.
    recent.push({
      chatId: chat.id._serialized,
      chatName: chat.name,
      author,
      body: msg.body,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
    });
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);

    const payload = {
      event: "message" as const,
      chatId: chat.id._serialized,
      chatName: chat.name,
      message: {
        id: msg.id._serialized,
        body: msg.body,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        author,
        type: msg.type,
      },
    };

    dispatchWebhook(config.webhookUrl, payload);
  });

  return client;
}
