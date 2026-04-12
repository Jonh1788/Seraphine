import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

router.get("/search", async (req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const query = req.query.query as string | undefined;
  const chatId = req.query.chatId as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  if (!query) {
    res.status(400).json({ error: "query parameter is required" });
    return;
  }

  try {
    const client = getClient();

    const searchOptions: { page: number; limit: number; chatId?: string } = {
      page: 1,
      limit,
    };
    if (chatId) {
      searchOptions.chatId = chatId;
    }

    const messages = await client.searchMessages(query, searchOptions);

    const results = await Promise.all(
      messages.slice(0, limit).map(async (msg) => {
        const chat = await msg.getChat();
        const contact = await msg.getContact();

        return {
          chatId: chat.id._serialized,
          chatName: chat.name,
          message: {
            id: msg.id._serialized,
            body: msg.body,
            timestamp: msg.timestamp,
            author:
              contact.pushname ?? contact.name ?? contact.number,
            fromMe: msg.fromMe,
          },
        };
      })
    );

    res.json({ results });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/search error:", err);
    res.status(500).json({ error: "Failed to search messages" });
  }
});

export default router;
