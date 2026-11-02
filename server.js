/**
 * Entry point for hosts that start a plain `node server.js` (Hostinger's Node.js apps, any process manager).
 * The backend is TypeScript run through tsx, exactly like `npm start` - this file only registers tsx first.
 * Settings come from the host's environment variables; locally, `npm start` reads .env instead.
 */
import { register } from "tsx/esm/api";

register();
process.env.LC_START_SERVER = "1";
await import("./src/server.ts");
