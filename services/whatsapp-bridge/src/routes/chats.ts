import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

router.get("/chats", async (req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const unreadOnly = req.query.unreadOnly === "true";

  try {
    const client = getClient();
    let chats = await client.getChats();

    if (unreadOnly) {
      chats = chats.filter((c) => c.unreadCount > 0);
    }

    chats = chats.slice(0, limit);

    const result = await Promise.all(
      chats.map(async (chat) => {
        const msgs = await chat.fetchMessages({ limit: 1 });
        const last = msgs[0] ?? null;

        let profilePicUrl: string | null = null;
        try {
          profilePicUrl = await chat.getContact().then((c) => c.getProfilePicUrl()) ?? null;
        } catch {
          // no profile pic available
        }

        const lastMessage = last
          ? {
              body: last.body,
              timestamp: last.timestamp,
              fromMe: last.fromMe,
              ...(chat.isGroup && !last.fromMe
                ? { author: (await last.getContact()).pushname ?? (await last.getContact()).name ?? (await last.getContact()).number }
                : {}),
            }
          : null;

        return {
          id: chat.id._serialized,
          name: chat.name,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount,
          lastMessage,
          profilePicUrl,
        };
      })
    );

    res.json({ chats: result });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/chats error:", err);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
});

export default router;
