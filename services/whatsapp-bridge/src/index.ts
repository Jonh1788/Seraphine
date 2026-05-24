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
import sendMediaRoute from "./routes/send-media";
import searchRoute from "./routes/search";
import contactsRoute from "./routes/contacts";
import recentRoute from "./routes/recent";
import logoutRoute from "./routes/logout";
import lookupRoute from "./routes/lookup";

const config = loadConfig();
const app = express();

app.use(express.json({ limit: "10mb" }));

// Mount all API routes
app.use("/api", statusRoute);
app.use("/api", qrRoute);
app.use("/api", chatsRoute);
app.use("/api", messagesRoute);
app.use("/api", sendRoute);
app.use("/api", sendMediaRoute);
app.use("/api", searchRoute);
app.use("/api", contactsRoute);
app.use("/api", recentRoute);
app.use("/api", logoutRoute);
app.use("/api", lookupRoute);

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
    msg.includes("Navigation timeout") ||
    // Container-restart fallout: previous Chromium left stale lock files
    // because docker SIGKILL'd it before it could clean up. After
    // killOrphanChrome() removes them, the next attempt succeeds.
    msg.includes("profile appears to be in use") ||
    msg.includes("ProcessSingleton") ||
    msg.includes("Failed to launch the browser process")
  );
}

function killOrphanChrome(): void {
  try {
    execSync('pkill -9 -f "chromium.*wwebjs_auth" 2>/dev/null; pkill -9 -f "chrome.*wwebjs_auth" 2>/dev/null', { stdio: "ignore" });
  } catch {
    // no orphans found
  }
  // Remove ALL Singleton* lock files Chromium leaves behind when SIGKILL'd
  // (SingletonLock, SingletonSocket, SingletonCookie). Only removing
  // SingletonLock isn't enough — the others also cause "profile in use".
  const sessionDir = path.join(AUTH_DIR, "session");
  try {
    for (const name of fs.readdirSync(sessionDir)) {
      if (name.startsWith("Singleton")) {
        try { fs.unlinkSync(path.join(sessionDir, name)); } catch { /* noop */ }
      }
    }
  } catch { /* sessionDir doesn't exist yet — fine */ }
  // Also clean /tmp/org.chromium.* leftovers
  try {
    execSync('rm -f /tmp/org.chromium.*/Singleton* 2>/dev/null', { stdio: "ignore" });
  } catch { /* noop */ }
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
  // Eager cleanup BEFORE the first attempt: a previous container
  // (this same name, recreated by docker compose) was SIGKILL'd and
  // left Singleton* lock files behind. Without this, attempt 1 fails
  // with "profile appears to be in use" — wasting the retry budget.
  killOrphanChrome();

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

// Watchdog: if we haven't reached `ready` within 120s, hard-exit so
// docker `restart: unless-stopped` recreates the container with fresh
// locks (killOrphanChrome runs eagerly on the next boot).
//
// Catches BOTH failure modes:
//   - `disconnected` (puppeteer/Chromium never came up)
//   - `authenticating` (came up, `authenticated` event fired, but the
//     `ready` event never followed — WhatsApp Web hung mid-load)
//
// The post-`ready` heartbeat (in client.ts) handles the case where the
// session goes bad LATER. This watchdog handles the BOOTSTRAP case.
setTimeout(() => {
  const { getStatus } = require("./client");
  const st = getStatus();
  if (st !== "ready") {
    console.error(
      `[whatsapp-bridge] WATCHDOG: status=${st} after 120s — exiting for docker to restart with clean locks`,
    );
    process.exit(1);
  }
}, 120_000);

app.listen(config.port, () => {
  console.log(`[whatsapp-bridge] HTTP server listening on :${config.port}`);
});
