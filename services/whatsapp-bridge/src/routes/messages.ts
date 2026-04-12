import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

router.get("/messages/:chatId", async (req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const chatId = req.params.chatId as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const before = req.query.before
    ? parseInt(req.query.before as string)
    : undefined;

  try {
    const client = getClient();
    const chat = await client.getChatById(chatId);

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const fetchOptions: { limit: number } = { limit };
    const allMessages = await chat.fetchMessages(fetchOptions);

    // Filter by timestamp if `before` is provided
    const filtered = before
      ? allMessages.filter((m) => m.timestamp < before)
      : allMessages;

    const messages = await Promise.all(
      filtered.slice(0, limit).map(async (msg) => {
        const contact = await msg.getContact();
        let quotedMsg: { body: string; author: string } | null = null;

        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            const quotedContact = await quoted.getContact();
            quotedMsg = {
              body: quoted.body,
              author:
                quotedContact.pushname ??
                quotedContact.name ??
                quotedContact.number,
            };
          } catch {
            // quoted message may no longer be available
          }
        }

        return {
          id: msg.id._serialized,
          body: msg.body,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          author:
            contact.pushname ?? contact.name ?? contact.number,
          type: msg.type,
          hasMedia: msg.hasMedia,
          quotedMsg,
        };
      })
    );

    res.json({
      chatId: chat.id._serialized,
      chatName: chat.name,
      messages,
    });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

export default router;
