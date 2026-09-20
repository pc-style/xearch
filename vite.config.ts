import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    react({
      compiler: { target: "19" },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    // The exe.dev proxy forwards the public hostname through as Host; vite
    // rejects hostnames it does not know, which shows up as a blank page.
    allowedHosts: [".exe.xyz"],
  },
});
