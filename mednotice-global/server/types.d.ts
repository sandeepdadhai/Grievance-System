import type { Role } from "./models.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: Role;
        country: string | null;
        organisation: string | null;
      };
      sessionId?: string;
    }
  }
}

export {};
