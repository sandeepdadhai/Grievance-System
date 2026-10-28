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
        /** Mobile number on file, always masked, plus whether an OTP proved it. */
        phone: string | null;
        phoneVerified: boolean;
        sms: { connected: boolean; simulated: boolean; provider: string };
        /** Aadhaar identity state; only the masked form ever leaves the server. */
        aadhaar: { verified: boolean; masked: string | null; verifiedAt: string | null; required: boolean };
      };
      sessionId?: string;
    }
  }
}

export {};
