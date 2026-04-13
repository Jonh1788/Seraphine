import { Router, Request, Response } from "express";
import { MessageMedia } from "whatsapp-web.js";
import { getClient, getStatus } from "../client";

const router = Router();

router.post("/send", async (req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { chatId, message, quoteMsgId, audio } = req.body as {
    chatId?: string;
    message?: string;
    quoteMsgId?: string | null;
    audio?: string; // base64 encoded audio (ogg/opus format)
  };

  if (!chatId || (!message && !audio)) {
    res.status(400).json({ error: "chatId and at least one of message/audio are required" });
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

    const sentIds: string[] = [];

    // Send text message first (if both text and audio provided)
    if (message) {
      const sent = await chat.sendMessage(message, options);
      sentIds.push(sent.id._serialized);
    }

    // Send voice note
    if (audio) {
      const media = new MessageMedia("audio/ogg; codecs=opus", audio);
      const sent = await chat.sendMessage(media, {
        sendAudioAsVoice: true,
        ...(quoteMsgId && !message ? { quotedMessageId: quoteMsgId } : {}),
      });
      sentIds.push(sent.id._serialized);
    }

    res.json({
      ok: true,
      messageId: sentIds[sentIds.length - 1],
      messageIds: sentIds,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/send error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
