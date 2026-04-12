import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

router.post("/send", async (req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { chatId, message, quoteMsgId } = req.body as {
    chatId?: string;
    message?: string;
    quoteMsgId?: string | null;
  };

  if (!chatId || !message) {
    res.status(400).json({ error: "chatId and message are required" });
    return;
  }

  try {
    const client = getClient();

    // Verify chat exists
    let chat;
    try {
      chat = await client.getChatById(chatId);
    } catch {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // Build send options
    const options: { quotedMessageId?: string } = {};
    if (quoteMsgId) {
      options.quotedMessageId = quoteMsgId;
    }

    const sent = await chat.sendMessage(message, options);

    res.json({
      ok: true,
      messageId: sent.id._serialized,
      timestamp: sent.timestamp,
    });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/send error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
