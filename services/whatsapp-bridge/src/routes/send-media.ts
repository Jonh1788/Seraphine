import { Router, Request, Response } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import { MessageMedia } from "whatsapp-web.js";
import { getClient as defaultGetClient, getStatus as defaultGetStatus } from "../client";

export interface SendMediaDeps {
  getClient: () => {
    sendMessage: (
      chatId: string,
      media: MessageMedia,
      options?: { caption?: string },
    ) => Promise<{ id: { _serialized: string } }>;
  };
  getStatus: () => string;
}

const upload = multer({ dest: "/tmp", limits: { fileSize: 25 * 1024 * 1024 } });

export function createSendMediaRouter(deps: SendMediaDeps): Router {
  const router = Router();

  router.post("/send-media", upload.single("file"), async (req: Request, res: Response) => {
    const { chatId, caption } = (req.body ?? {}) as { chatId?: string; caption?: string };

    if (!chatId) {
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
      res.status(400).json({ error: "missing chatId" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "missing file" });
      return;
    }

    if (deps.getStatus() !== "ready") {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(503).json({ error: "bridge not ready" });
      return;
    }

    try {
      const media = MessageMedia.fromFilePath(req.file.path);
      // Preserve the user-facing PDF name on WhatsApp (multer renames to a
      // random tmp basename, which would otherwise leak into the chat).
      media.filename = req.file.originalname;
      const sent = await deps.getClient().sendMessage(
        chatId,
        media,
        caption ? { caption } : undefined,
      );
      res.json({ ok: true, id: sent.id._serialized });
    } catch (err) {
      console.error("[whatsapp-bridge] /api/send-media error:", err);
      res.status(500).json({ error: (err as Error).message });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  });

  return router;
}

// Default export wires the real client deps — kept for production mounting
// in index.ts. Tests import the factory directly with stubs.
const router = createSendMediaRouter({
  getClient: defaultGetClient,
  getStatus: defaultGetStatus,
});

export default router;
