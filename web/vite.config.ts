import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev (`npm run dev` inside web/) the API is proxied to the backend; in production the backend serves web/dist itself.
const backend = "http://127.0.0.1:8790";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/health": backend, "/sites": backend, "/jobs": backend, "/files": backend } },
  build: { outDir: "dist", sourcemap: false },
});
