import { Router, Request, Response } from "express";
import { getClient, getStatus, getUptime } from "../client";

const router = Router();

router.get("/status", (_req: Request, res: Response) => {
  const status = getStatus();
  const client = getClient();
  const info = status === "ready" ? client?.info : null;

  res.json({
    status,
    phone: info?.wid?.user ?? null,
    name: info?.pushname ?? null,
    uptime_s: getUptime(),
  });
});

export default router;
