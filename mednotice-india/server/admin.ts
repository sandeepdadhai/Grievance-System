import { createApp } from "./app.js";
import { adminConsoleGate } from "./admin-access.js";
import { ADMIN_DIST, ADMIN_HOST, ADMIN_PORT } from "./config.js";
import { verifyAuditChain } from "./audit.js";

/**
 * Staff console process: its own origin, its own port, its own access rules.
 * It serves the console bundle and the same JSON API, sharing the database,
 * storage and outbox with the patient service. The notification worker and the
 * SLA scheduler deliberately stay in the patient process so they never run twice.
 */
async function main(): Promise<void> {
  const app = createApp({ staticDir: ADMIN_DIST, indexFile: "admin.html", gate: adminConsoleGate });
  const server = app.listen(ADMIN_PORT, ADMIN_HOST, () => {
    console.log(`[mednotice-admin] staff console listening on http://${ADMIN_HOST}:${ADMIN_PORT}`);
    console.log(`[mednotice-admin] audit chain: ${verifyAuditChain().valid ? "valid" : "BROKEN"}`);
    if (ADMIN_HOST === "0.0.0.0" || ADMIN_HOST === "::") {
      console.warn("[mednotice-admin] bound to all interfaces — set ADMIN_ALLOWED_IPS or ADMIN_BASIC_* to restrict access");
    }
  });

  const shutdown = (signal: string) => {
    console.log(`[mednotice-admin] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[mednotice-admin] fatal startup error", err);
  process.exit(1);
});
