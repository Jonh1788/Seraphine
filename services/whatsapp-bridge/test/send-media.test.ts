import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createSendMediaRouter } from "../src/routes/send-media";

type SentCall = {
  chatId: string;
  media: { filename?: string; mimetype?: string; data?: string };
  options: unknown;
};

function makeApp(opts: {
  status?: string;
  sendMessage?: (chatId: string, media: any, options?: any) => Promise<any>;
  calls?: SentCall[];
}) {
  const status = opts.status ?? "ready";
  const calls = opts.calls ?? [];
  const sendMessage =
    opts.sendMessage ??
    (async (chatId: string, media: any, options?: any) => {
      calls.push({ chatId, media, options });
      return { id: { _serialized: "stub-message-id" } };
    });

  const app = express();
  app.use(
    "/api",
    createSendMediaRouter({
      getClient: () => ({ sendMessage }) as any,
      getStatus: () => status,
    }),
  );
  return app;
}

test("rejects when chatId missing", async () => {
  const app = makeApp({});
  const res = await request(app)
    .post("/api/send-media")
    .attach("file", Buffer.from("%PDF-1.4 fake"), {
      filename: "joao.pdf",
      contentType: "application/pdf",
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /chatId/);
});

test("rejects when file missing", async () => {
  const app = makeApp({});
  const res = await request(app)
    .post("/api/send-media")
    .field("chatId", "5511999999999@c.us");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /file/);
});

test("sends file and preserves filename", async () => {
  const calls: SentCall[] = [];
  const app = makeApp({ calls });

  const res = await request(app)
    .post("/api/send-media")
    .field("chatId", "5511999999999@c.us")
    .field("caption", "CV #1 — joao.pdf")
    .attach("file", Buffer.from("%PDF-1.4 fake pdf bytes"), {
      filename: "joao.pdf",
      contentType: "application/pdf",
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.id, "stub-message-id");

  assert.equal(calls.length, 1, "sendMessage called exactly once");
  const call = calls[0];
  assert.equal(call.chatId, "5511999999999@c.us");
  assert.equal(call.media.filename, "joao.pdf");
  assert.deepEqual(call.options, { caption: "CV #1 — joao.pdf" });
});

test("returns 503 when bridge not ready and cleans up tmp file", async () => {
  const calls: SentCall[] = [];
  const app = makeApp({ status: "qr_pending", calls });

  const res = await request(app)
    .post("/api/send-media")
    .field("chatId", "5511999999999@c.us")
    .attach("file", Buffer.from("%PDF-1.4 fake"), {
      filename: "joao.pdf",
      contentType: "application/pdf",
    });

  assert.equal(res.status, 503);
  assert.equal(res.body.error, "bridge not ready");
  assert.equal(calls.length, 0, "sendMessage must not be called");
});

test("sends without caption when caption not provided", async () => {
  const calls: SentCall[] = [];
  const app = makeApp({ calls });

  const res = await request(app)
    .post("/api/send-media")
    .field("chatId", "5511999999999@c.us")
    .attach("file", Buffer.from("%PDF-1.4 fake"), {
      filename: "maria.pdf",
      contentType: "application/pdf",
    });

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[0].media.filename, "maria.pdf");
});

test("returns 500 when sendMessage throws", async () => {
  const app = makeApp({
    sendMessage: async () => {
      throw new Error("whatsapp down");
    },
  });

  const res = await request(app)
    .post("/api/send-media")
    .field("chatId", "5511999999999@c.us")
    .attach("file", Buffer.from("%PDF-1.4 fake"), {
      filename: "joao.pdf",
      contentType: "application/pdf",
    });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, "whatsapp down");
});
