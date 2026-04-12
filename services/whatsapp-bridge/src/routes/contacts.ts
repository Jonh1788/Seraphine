import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

router.get("/contacts", async (_req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const query = (_req.query.query as string | undefined)?.toLowerCase();

  try {
    const client = getClient();
    let contacts = await client.getContacts();

    if (query) {
      contacts = contacts.filter((c) => {
        const name = (c.name ?? "").toLowerCase();
        const pushname = (c.pushname ?? "").toLowerCase();
        const number = c.number ?? "";
        return (
          name.includes(query) ||
          pushname.includes(query) ||
          number.includes(query)
        );
      });
    }

    const result = contacts.map((c) => ({
      id: c.id._serialized,
      name: c.name ?? null,
      pushname: c.pushname ?? null,
      isMyContact: c.isMyContact,
      isGroup: c.isGroup,
    }));

    res.json({ contacts: result });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/contacts error:", err);
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

export default router;
