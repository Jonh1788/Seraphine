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
let heartbeatTimer: NodeJS.Timeout | null = null;

const QR_EXPIRY_S = 20;
// Heartbeat: while "ready", poll WhatsApp Web's reported state. The
// `ready` + `disconnected` events do NOT always fire when WA Web enters
// a zombie state (e.g. company-side device kick, anti-abuse cooldown,
// page silently logged out). Without this, the bridge can sit at
// "ready" while no messages are delivered for days — exactly the case
// that prompted this code. On N consecutive non-CONNECTED reads we
// hard-exit so docker `restart: unless-stopped` re-initializes us.
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_FAIL_BUDGET = 3;

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

function startHeartbeat(): void {
  stopHeartbeat();
  let consecutiveFailures = 0;
  heartbeatTimer = setInterval(async () => {
    let state: string | null = null;
    try {
      // getState() reaches into the live WA Web page; on a zombie page
      // it either rejects or returns a non-CONNECTED state.
      state = (await client.getState()) ?? null;
    } catch (err) {
      console.warn("[whatsapp-bridge] heartbeat: getState() threw:", (err as Error).message);
    }
    if (state === "CONNECTED") {
      if (consecutiveFailures > 0) {
        console.log(`[whatsapp-bridge] heartbeat: recovered after ${consecutiveFailures} miss(es)`);
      }
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures += 1;
    console.warn(
      `[whatsapp-bridge] heartbeat: state=${state ?? "null"} ` +
      `(${consecutiveFailures}/${HEARTBEAT_FAIL_BUDGET})`
    );
    if (consecutiveFailures >= HEARTBEAT_FAIL_BUDGET) {
      console.error("[whatsapp-bridge] heartbeat: exhausted budget — exiting for restart");
      stopHeartbeat();
      process.exit(1);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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
    startHeartbeat();
  });

  client.on("disconnected", (reason: string) => {
    currentStatus = "disconnected";
    startedAt = null;
    stopHeartbeat();
    console.log("[whatsapp-bridge] disconnected:", reason);
    // Hard exit so docker restart_policy reinitializes a fresh client.
    // The previous behavior (just log + stay alive) left the container
    // in a permanent disconnected state with no recovery path.
    process.exit(1);
  });

  client.on("message", async (msg) => {
    if (currentStatus !== "ready") return;

    const chat = await msg.getChat();
    const contact = await msg.getContact();

    const author = contact.pushname ?? contact.name ?? contact.number;

    // WhatsApp's "Lid" rollout means chat.id._serialized is now an
    // opaque `<id>@lid` string for new chats — splitting on '@' no
    // longer yields the sender's phone. The Contact object still
    // resolves to the real number for non-privacy senders; surface
    // it explicitly so the backend doesn't have to LID-detect or
    // parse the display-formatted chat.name.
    const phone = contact.number ? `+${contact.number}` : null;

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

    // Voice notes ("ptt") and forwarded audio attachments have an empty
    // msg.body; the actual content is the audio file. Pull it down so
    // the backend can transcribe it (PT-BR STT runs on Aura's stack).
    // Skip silently on any download failure — better to drop one audio
    // than to take down the whole inbound path.
    let audio: { data: string; mimetype: string } | null = null;
    const isAudioType = msg.type === "ptt" || msg.type === "audio";
    if (isAudioType && msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media?.data) {
          audio = {
            data: media.data,
            mimetype: media.mimetype || "audio/ogg; codecs=opus",
          };
        }
      } catch (err) {
        console.warn(
          "[whatsapp-bridge] audio download failed for %s: %s",
          msg.id._serialized,
          (err as Error).message,
        );
      }
    }

    const payload = {
      event: "message" as const,
      chatId: chat.id._serialized,
      chatName: chat.name,
      phone,
      message: {
        id: msg.id._serialized,
        body: msg.body,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        author,
        type: msg.type,
        ...(audio ? { audio } : {}),
      },
    };

    dispatchWebhook(config.webhookUrl, payload);
  });

  return client;
}
