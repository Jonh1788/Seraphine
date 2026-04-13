import express from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { loadConfig } from "./config";
import { initClient } from "./client";
import statusRoute from "./routes/status";
import qrRoute from "./routes/qr";
import chatsRoute from "./routes/chats";
import messagesRoute from "./routes/messages";
import sendRoute from "./routes/send";
import searchRoute from "./routes/search";
import contactsRoute from "./routes/contacts";

const config = loadConfig();
const app = express();

app.use(express.json({ limit: "10mb" }));

// Mount all API routes
app.use("/api", statusRoute);
app.use("/api", qrRoute);
app.use("/api", chatsRoute);
app.use("/api", messagesRoute);
app.use("/api", sendRoute);
app.use("/api", searchRoute);
app.use("/api", contactsRoute);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const AUTH_DIR = path.resolve(__dirname, "..", ".wwebjs_auth");

function isRetriableError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("Execution context was destroyed") ||
    msg.includes("ProtocolError") ||
    msg.includes("Target closed") ||
    msg.includes("Session closed") ||
    msg.includes("browser is already running") ||
    msg.includes("Navigation timeout")
  );
}

function killOrphanChrome(): void {
  try {
    execSync('pkill -9 -f "chromium.*wwebjs_auth" 2>/dev/null; pkill -9 -f "chrome.*wwebjs_auth" 2>/dev/null', { stdio: "ignore" });
  } catch {
    // no orphans found
  }
  // Remove stale lock file
  const lockFile = path.join(AUTH_DIR, "session", "SingletonLock");
  try { fs.unlinkSync(lockFile); } catch { /* noop */ }
}

async function destroyClientSafe(client: import("whatsapp-web.js").Client): Promise<void> {
  try {
    await client.destroy();
  } catch {
    // client may already be dead
  }
  killOrphanChrome();
}

function deleteAuthDir(): void {
  if (fs.existsSync(AUTH_DIR)) {
    console.log("[whatsapp-bridge] deleting .wwebjs_auth for fresh session...");
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
}

async function initializeWithRetry(): Promise<void> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = initClient(config);

    // Log puppeteer lifecycle events for debugging
    client.on("loading_screen" as any, (percent: any, msg: any) => {
      console.log(`[whatsapp-bridge] loading: ${percent}% — ${msg}`);
    });

    console.log(`[whatsapp-bridge] client.initialize() attempt ${attempt}/${MAX_RETRIES}...`);

    try {
      await client.initialize();
      console.log("[whatsapp-bridge] client.initialize() resolved");
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[whatsapp-bridge] initialize attempt ${attempt} failed:`, err);

      if (!isRetriableError(err)) {
        console.error("[whatsapp-bridge] non-retriable error, giving up");
        return;
      }

      await destroyClientSafe(client);
      // Give Chrome time to fully release the userDataDir lock
      await new Promise((r) => setTimeout(r, 2_000));

      if (attempt < MAX_RETRIES) {
        console.log(`[whatsapp-bridge] waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  // All retries exhausted — try one last time with a fresh session
  console.warn("[whatsapp-bridge] all retries exhausted, trying fresh session (QR scan required)...");
  deleteAuthDir();

  const client = initClient(config);
  client.on("loading_screen" as any, (percent: any, msg: any) => {
    console.log(`[whatsapp-bridge] loading: ${percent}% — ${msg}`);
  });

  try {
    await client.initialize();
    console.log("[whatsapp-bridge] client.initialize() resolved (fresh session)");
  } catch (err) {
    console.error("[whatsapp-bridge] fresh session also failed:", err);
  }
}

console.log(`[whatsapp-bridge] starting on :${config.port}`);
console.log("[whatsapp-bridge] loading session from .wwebjs_auth/...");

initializeWithRetry();

// Watchdog: if no status change within 90s, log warning (increased for retries)
setTimeout(() => {
  const { getStatus } = require("./client");
  const st = getStatus();
  if (st === "disconnected") {
    console.warn("[whatsapp-bridge] WATCHDOG: still disconnected after 90s — WhatsApp Web may be unreachable");
  }
}, 90_000);

app.listen(config.port, () => {
  console.log(`[whatsapp-bridge] HTTP server listening on :${config.port}`);
});
