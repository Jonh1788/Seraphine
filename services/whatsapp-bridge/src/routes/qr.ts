import { Router, Request, Response } from "express";
import QRCode from "qrcode";
import { getStatus, getCurrentQr } from "../client";

const router = Router();

router.get("/qr", async (_req: Request, res: Response) => {
  const status = getStatus();

  if (status !== "qr_pending") {
    res.json({ qr: null, message: "already authenticated" });
    return;
  }

  const { qr, expiresInS } = getCurrentQr();

  if (!qr) {
    res.json({ qr: null, message: "QR expired, waiting for new one" });
    return;
  }

  try {
    const dataUrl = await QRCode.toDataURL(qr, { width: 300 });
    res.json({ qr: dataUrl, expires_in_s: expiresInS });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR image" });
  }
});

export default router;
