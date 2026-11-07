import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 43123,
    strictPort: true,
    proxy: { "/v1": "http://127.0.0.1:4781" },
  },
  preview: { host: "0.0.0.0", port: 43123, strictPort: true },
  build: { outDir: path.join(root, "dist"), emptyOutDir: true },
});
