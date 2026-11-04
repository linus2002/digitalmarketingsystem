// Prints fresh secrets for .env. Run: npm run gen:keys
import crypto from "node:crypto";

console.log(`JWT_SECRET=${crypto.randomBytes(48).toString("base64url")}`);
console.log(`DATA_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`);
console.log(`META_VERIFY_TOKEN=${crypto.randomBytes(18).toString("base64url")}`);
