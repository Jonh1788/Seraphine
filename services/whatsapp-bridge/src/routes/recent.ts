import { Router, Request, Response } from "express";
import { getRecent } from "../client";

const router = Router();

// GET /api/recent?limit=20 — last N inbound (and own outbound) messages
// from the in-memory ring buffer. Newest first. Used by the unified
// WhatsApp Manager UI to show recent activity per bridge.
router.get("/recent", (req: Request, res: Response) => {
  const raw = req.query.limit;
  const limit = typeof raw === "string" ? parseInt(raw, 10) : 20;
  res.json({ messages: getRecent(Number.isNaN(limit) ? 20 : limit) });
});

export default router;
