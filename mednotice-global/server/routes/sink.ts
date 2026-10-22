import { Router } from "express";
import { all, nowIso, run } from "../db.js";
import { createRateLimiter, meta } from "../http.js";

export const sinkRouter = Router();

sinkRouter.post(
  "/webhook",
  createRateLimiter({ bucket: "sink", windowMs: 60_000, max: 120 }),
  (req, res) => {
    run(
      "INSERT INTO webhook_events (received_at, source, payload_json) VALUES (?, ?, ?)",
      nowIso(),
      `http:${meta(req).ip ?? "unknown"}`,
      JSON.stringify(req.body ?? {}).slice(0, 100_000),
    );
    res.status(202).json({ received: true });
  },
);

sinkRouter.get("/webhook", (_req, res) => {
  res.json({ events: all("SELECT * FROM webhook_events ORDER BY id DESC LIMIT 20") });
});
