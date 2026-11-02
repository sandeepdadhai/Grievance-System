import fs from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";
import { JURISDICTIONS, PATIENT_DIST } from "./config.js";
import { attachUser } from "./auth.js";
import { errorHandler, notFound, sameOriginOnly, securityHeaders } from "./http.js";
import { verifyAuditChain } from "./audit.js";
import { publicRouter } from "./routes/public.js";
import { authRouter } from "./routes/auth.js";
import { casesRouter } from "./routes/cases.js";
import { documentsRouter } from "./routes/documents.js";
import { adminRouter } from "./routes/admin.js";
import { rolesRouter } from "./routes/roles.js";
import { communityAdminRouter, communityRouter } from "./routes/community.js";
import { directoryRouter } from "./routes/directory.js";
import { dispatchRouter } from "./routes/dispatch.js";
import { communicationsRouter } from "./routes/communications.js";
import { chatRouter } from "./routes/chat.js";
import { sinkRouter } from "./routes/sink.js";

export type AppOptions = {
  /**
   * Directory of a built single-page bundle to serve at the origin root.
   * Defaults to the patient bundle; pass null to serve the API only.
   */
  staticDir?: string | null;
  /**
   * Shell file inside staticDir used for client-side routes. The console build
   * emits admin.html, so its origin serves that as the SPA entry.
   */
  indexFile?: string;
  /**
   * Extra middleware placed after the shared middleware and before every route.
   * The staff console uses it for its network allowlist and Basic challenge.
   */
  gate?: RequestHandler;
};

/** Serve a built SPA and its client-side routes, leaving /api untouched. */
function mountSpa(app: express.Express, staticDir: string, indexFile: string): void {
  const shell = path.join(staticDir, indexFile);
  if (!fs.existsSync(shell)) {
    console.warn(`[mednotice] no built SPA at ${shell} — serving the API only`);
    return;
  }
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(shell);
  });
}

/**
 * One JSON API, two front ends. `createApp()` serves the patient application
 * (the default); `createApp({ staticDir: ADMIN_DIST, gate })` serves the staff
 * console from its own origin with the same routes and the same database.
 */
export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(sameOriginOnly);
  app.use(attachUser);
  if (options.gate) app.use(options.gate);

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "mednotice-india",
      time: new Date().toISOString(),
      jurisdictions: JURISDICTIONS.length,
      auditChain: verifyAuditChain(),
      encryptionAtRest: "AES-256-GCM",
      transport: "TLS terminated at edge",
    });
  });

  app.use("/api/public", publicRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/cases", casesRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/community", communityRouter);
  app.use("/api/admin/roles", rolesRouter);
  app.use("/api/admin/community", communityAdminRouter);
  app.use("/api/admin/directory", directoryRouter);
  app.use("/api/admin/dispatch", dispatchRouter);
  app.use("/api/admin/communications", communicationsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/_sink", sinkRouter);

  const staticDir = options.staticDir === undefined ? PATIENT_DIST : options.staticDir;
  if (staticDir) mountSpa(app, staticDir, options.indexFile ?? "index.html");

  app.use("/api", notFound);
  app.use(errorHandler);
  return app;
}
