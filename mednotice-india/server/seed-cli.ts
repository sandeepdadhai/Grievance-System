import { seed } from "./seed.js";
import { verifyAuditChain } from "./audit.js";

await seed();
console.log("[seed] audit chain:", verifyAuditChain());
