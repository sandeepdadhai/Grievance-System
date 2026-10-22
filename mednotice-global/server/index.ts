import { createApp } from "./app.js";
import { PORT } from "./config.js";
import { seed } from "./seed.js";
import { startNotificationWorker } from "./notifications.js";
import { verifyAuditChain } from "./audit.js";

async function main(): Promise<void> {
  await seed();
  const app = createApp();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[mednotice] API listening on http://0.0.0.0:${PORT}`);
    console.log(`[mednotice] audit chain: ${verifyAuditChain().valid ? "valid" : "BROKEN"}`);
  });
  startNotificationWorker();

  const shutdown = (signal: string) => {
    console.log(`[mednotice] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[mednotice] fatal startup error", err);
  process.exit(1);
});
