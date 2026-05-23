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

    // Per-chat enrichment is best-effort: a single broken chat (puppeteer
    // state desync, group eviction, etc.) used to take down the whole list
    // via Promise.all rejection. Isolate failures so the listing always
    // returns the basics (id/name/isGroup/unreadCount) for every chat.
    const result = await Promise.all(
      chats.map(async (chat) => {
        const base = {
          id: chat.id._serialized,
          name: chat.name,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount,
          lastMessage: null as null | { body: string; timestamp: number; fromMe: boolean; author?: string },
          profilePicUrl: null as null | string,
        };

        try {
          const msgs = await chat.fetchMessages({ limit: 1 });
          const last = msgs[0] ?? null;
          if (last) {
            base.lastMessage = {
              body: last.body,
              timestamp: last.timestamp,
              fromMe: last.fromMe,
              ...(chat.isGroup && !last.fromMe
                ? { author: (await last.getContact()).pushname ?? (await last.getContact()).name ?? (await last.getContact()).number }
                : {}),
            };
          }
        } catch (err) {
          console.warn(`[whatsapp-bridge] fetchMessages failed for ${base.name}:`, (err as Error).message);
        }

        try {
          base.profilePicUrl = (await chat.getContact().then((c) => c.getProfilePicUrl())) ?? null;
        } catch {
          // no profile pic available
        }

        return base;
      })
    );

    res.json({ chats: result });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/chats error:", err);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
});

export default router;
