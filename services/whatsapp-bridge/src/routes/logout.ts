import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getClient, getStatus } from "../client";

const router = Router();

const AUTH_DIR = path.resolve(__dirname, "..", "..", ".wwebjs_auth");

// POST /api/logout — terminates the WhatsApp Web session and (when
// ?wipe=true) removes the auth folder so the next /api/qr will issue
// a brand new pairing code. Used by the Manager UI's "Disconnect"
// button. Always responds 200; subsequent /api/status should report
// "disconnected" within a few seconds.
router.post("/logout", async (req: Request, res: Response) => {
  const wipe = req.query.wipe === "true";
  const wasReady = getStatus() === "ready";

  try {
    const client = getClient();
    if (client && wasReady) {
      try {
        await client.logout();
      } catch (err) {
        console.warn("[whatsapp-bridge] logout() error (ignored):", err);
      }
    }
  } catch (err) {
    console.warn("[whatsapp-bridge] logout client lookup error:", err);
  }

  if (wipe) {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn("[whatsapp-bridge] auth dir wipe failed:", err);
    }
  }

  res.json({ ok: true, was_ready: wasReady, wiped: wipe });
});

export default router;
