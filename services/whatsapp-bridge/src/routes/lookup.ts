import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

// Resolve a user-input phone number to its WhatsApp-canonical form.
//
// `client.getNumberId(digits)` asks WhatsApp whether the number is
// registered and returns the canonical JID — for ordinary contacts
// that's `<phone>@c.us`, so we extract `numberId.user` (the bare
// digits) and surface it as the authoritative phone. This lets the
// backend store the same E.164 that inbound webhooks will resolve to,
// instead of whatever the user typed at signup.
router.get("/lookup", async (req: Request, res: Response) => {
  if (getStatus() !== "ready") {
    res.status(503).json({ error: "Not ready" });
    return;
  }
  const raw = String(req.query.phone || "");
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) {
    res.status(400).json({ error: "phone query param required" });
    return;
  }
  try {
    const client = getClient();
    const numberId = await client.getNumberId(digits);
    if (!numberId) {
      res.status(404).json({ error: "Number not on WhatsApp" });
      return;
    }
    // Lid identifiers are opaque — there's no phone to canonicalize.
    // Refuse so the caller doesn't persist an unmatcheable row.
    if (numberId.server !== "c.us") {
      res.status(409).json({
        error: "Phone hidden by WhatsApp privacy (Lid)",
        server: numberId.server,
      });
      return;
    }
    res.json({
      phone: `+${numberId.user}`,
      jid: numberId._serialized,
    });
  } catch (err) {
    console.error("[whatsapp-bridge] /api/lookup error:", err);
    res.status(500).json({ error: "Lookup failed" });
  }
});

export default router;
