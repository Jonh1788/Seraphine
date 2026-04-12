import express from "express";
import { loadConfig } from "./config";
import { initClient } from "./client";
import statusRoute from "./routes/status";
import qrRoute from "./routes/qr";
import chatsRoute from "./routes/chats";
import messagesRoute from "./routes/messages";
import sendRoute from "./routes/send";
import searchRoute from "./routes/search";
import contactsRoute from "./routes/contacts";

const config = loadConfig();
const app = express();

app.use(express.json());

// Mount all API routes
app.use("/api", statusRoute);
app.use("/api", qrRoute);
app.use("/api", chatsRoute);
app.use("/api", messagesRoute);
app.use("/api", sendRoute);
app.use("/api", searchRoute);
app.use("/api", contactsRoute);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Initialize WhatsApp client
const client = initClient(config);

console.log(`[whatsapp-bridge] starting on :${config.port}`);
console.log("[whatsapp-bridge] loading session from .wwebjs_auth/...");

client.initialize().catch((err) => {
  console.error("[whatsapp-bridge] failed to initialize client:", err);
});

app.listen(config.port, () => {
  console.log(`[whatsapp-bridge] HTTP server listening on :${config.port}`);
});
