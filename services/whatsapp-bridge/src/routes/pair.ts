import { Router, Request, Response } from "express";
import { getClient, getStatus } from "../client";

const router = Router();

// Link by phone-number pairing code instead of QR. WhatsApp shows an
// 8-char code the user types under: Linked Devices → Link a Device →
// "Link with phone number instead". More reliable than scanning a
// terminal/IDE QR. Call: GET /api/pair?number=5521984015566 (digits,
// country code, no '+').
router.get("/pair", async (req: Request, res: Response) => {
  const number = String(req.query.number || "").replace(/[^0-9]/g, "");
  if (!number) {
    res.status(400).json({ error: "number required (digits incl. country code, e.g. 5521984015566)" });
    return;
  }
  if (getStatus() === "ready") {
    res.json({ code: null, message: "already authenticated" });
    return;
  }
  try {
    const code = await getClient().requestPairingCode(number);
    res.json({ code, number });
  } catch (err) {
    res.status(500).json({ error: "requestPairingCode failed: " + (err as Error).message });
  }
});

export default router;
