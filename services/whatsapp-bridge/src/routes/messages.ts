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

    // Do everything inside pupPage.evaluate for speed — no round-trips per message
    const result = await (client as any).pupPage.evaluate(
      async (cid: string, lim: number, bef: number | undefined) => {
        const Store = (globalThis as any).Store;
        if (!Store) return null;

        const chat = Store.Chat.get(cid);
        if (!chat) return null;

        // Load earlier messages if we don't have enough
        const maxLoads = Math.ceil(lim / 20) + 1;
        for (let i = 0; i < maxLoads; i++) {
          const count = chat.msgs.getModelsArray().length;
          if (count >= lim + 5) break;
          try {
            const loaded = await Store.ConversationMsgs?.loadEarlierMsgs?.(chat);
            if (!loaded || loaded.length === 0) break;
          } catch {
            // Try alternate method
            try {
              await chat.onEmptyMRM?.();
            } catch { break; }
          }
        }

        const allMsgs = chat.msgs.getModelsArray();

        // Filter out system messages
        let filtered = allMsgs.filter(
          (m: any) =>
            m.type !== "notification" &&
            m.type !== "e2e_notification" &&
            m.type !== "gp2" &&
            m.type !== "protocol"
        );

        if (bef) {
          filtered = filtered.filter((m: any) => m.t < bef);
        }

        // Sort descending by timestamp
        filtered.sort((a: any, b: any) => b.t - a.t);
        const sliced = filtered.slice(0, lim);

        // Resolve author names from contacts store
        const contactCache: Record<string, string> = {};
        const resolveAuthor = (m: any): string => {
          if (m.id?.fromMe) {
            const me = Store.Contact?.getMeContact?.();
            return me?.pushname || me?.name || "You";
          }
          const authorJid = m.author || m.from;
          if (!authorJid) return "Unknown";
          if (contactCache[authorJid]) return contactCache[authorJid];

          try {
            const contact = Store.Contact?.get?.(authorJid);
            const name = contact?.pushname || contact?.name || contact?.shortName || authorJid;
            contactCache[authorJid] = name;
            return name;
          } catch {
            return authorJid;
          }
        };

        return {
          chatName: chat.name || chat.formattedTitle || cid,
          messages: sliced.map((m: any) => ({
            id: m.id?._serialized || "",
            body: m.body || "",
            timestamp: m.t,
            fromMe: !!m.id?.fromMe,
            author: resolveAuthor(m),
            type: m.type,
            hasMedia: !!m.isMedia,
          })),
        };
      },
      chatId,
      limit,
      before
    );

    if (!result) {
      res.status(404).json({ error: "Chat not found or Store not ready" });
      return;
    }

    res.json({
      chatId,
      chatName: result.chatName,
      messages: result.messages,
    });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

export default router;
