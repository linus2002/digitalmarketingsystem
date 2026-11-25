import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :4000 and Vite proxies /api to it, so the session cookie stays same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    // Fail instead of quietly moving to another port: CLIENT_ORIGIN in .env must match this address.
    strictPort: true,
    host: "127.0.0.1",
    proxy: { "/api": { target: "http://127.0.0.1:4000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false },
});
