import fs from "node:fs";
import path from "node:path";
import express from "express";
import { JURISDICTIONS, ROOT } from "./config.js";
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

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(sameOriginOnly);
  app.use(attachUser);

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "mednotice-global",
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

  const clientDist = path.join(ROOT, "client", "dist");
  if (fs.existsSync(path.join(clientDist, "index.html"))) {
    app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use("/api", notFound);
  app.use(errorHandler);
  return app;
}
