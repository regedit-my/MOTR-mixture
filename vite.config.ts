import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        v1: resolve(__dirname, "v1/index.html"),
        v2: resolve(__dirname, "v2/index.html"),
        v2Editor: resolve(__dirname, "v2/editor.html"),
        v3: resolve(__dirname, "v3/index.html"),
        v3Editor: resolve(__dirname, "v3/editor.html"),
      },
    },
  },
});
