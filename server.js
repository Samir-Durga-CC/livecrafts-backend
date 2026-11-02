/**
 * Entry point for hosts that start a plain `node server.js` (Hostinger's Node.js apps, any process manager).
 * The backend is TypeScript run through tsx, exactly like `npm start` - this file only registers tsx first.
 * Settings come from the host's environment variables; locally, `npm start` reads .env instead.
 *
 * No top-level await here: Hostinger's runner (LiteSpeed lsnode) loads this file with require(), which refuses an
 * ES module that awaits at the top level. import() returns a promise instead, and the backend starts from it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

// The chat UI is served from ./web/dist relative to the working directory, which the runner does not promise.
process.chdir(path.dirname(fileURLToPath(import.meta.url)));
register();
process.env.LC_START_SERVER = "1";
import("./src/server.ts").catch((e) => { console.error(e); process.exit(1); });
