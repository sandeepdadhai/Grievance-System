import type { Role } from "./models.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        /** Stored role key — a built-in role or an administrator-defined custom role. */
        role: string;
        roleName: string;
        /** Capability family used for existing RBAC checks. */
        baseRole: Role;
        permissions: string[];
        country: string | null;
        organisation: string | null;
        /** Facility binding — narrows every case query to this facility. */
        facilityId: string | null;
        facilityName: string | null;
      };
      sessionId?: string;
    }
  }
}

export {};
