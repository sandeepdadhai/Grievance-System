import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth.js";
import { audit } from "../audit.js";
import { asyncHandler, HttpError, meta, parseBody } from "../http.js";
import { getThemeSettings, isThemeId, setThemeSettings } from "../theme.js";

/**
 * Public theme endpoint. It is deliberately unauthenticated: the patient
 * portal has to paint itself before anyone signs in, and a palette id is not
 * sensitive. Both bundles call it on load.
 */
export const publicThemeRouter = Router();

publicThemeRouter.get("/", (_req, res) => {
  res.json({ theme: getThemeSettings() });
});

/**
 * Only a super administrator may repaint the platform — the console has no
 * narrower appearance permission because a theme applies to every user.
 */
export const themeAdminRouter = Router();

themeAdminRouter.use(requireAuth, requireRole("SUPER_ADMIN"));

const themePatchSchema = z
  .object({
    patient: z.string().trim().min(1).max(40).optional(),
    admin: z.string().trim().min(1).max(40).optional(),
  })
  .refine((body) => Boolean(body.patient ?? body.admin), "Choose at least one theme to update");

themeAdminRouter.patch(
  "/",
  asyncHandler((req, res) => {
    const body = parseBody(themePatchSchema, req.body);
    if (body.patient !== undefined && !isThemeId(body.patient)) {
      throw new HttpError(400, "Unknown patient portal theme");
    }
    if (body.admin !== undefined && !isThemeId(body.admin)) {
      throw new HttpError(400, "Unknown staff console theme");
    }

    const previous = getThemeSettings();
    const theme = setThemeSettings({
      patient: body.patient,
      admin: body.admin,
      actor: req.user!.email,
    });

    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "THEME_UPDATED",
      entityType: "settings",
      entityId: "theme",
      ...meta(req),
      details: {
        previous: { patient: previous.patient, admin: previous.admin },
        next: { patient: theme.patient, admin: theme.admin },
      },
    });

    res.json({ theme });
  }),
);
