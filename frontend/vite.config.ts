import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Backend (FastAPI) dev server. Override with VITE_API_TARGET if needed.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // Frontend calls /api/*; backend now serves under /api so no rewrite needed.
      // `ws: true` also forwards the WebSocket upgrade for /api/ws/* (job progress).
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
