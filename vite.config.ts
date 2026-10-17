import { resolve } from "node:path";
import { defineConfig } from "vite";

// v1/ и v2/ (+ v2/editor.html) — отдельные страницы (роуты) одного проекта,
// со своим собственным HTML-входом каждая. Собираются и раздаются из корня.
// base — относительный, чтобы dist/ открывался из любой подпапки
// (в т.ч. GitHub Pages вида username.github.io/repo/), без привязки к имени репозитория.
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        v1: resolve(__dirname, "v1/index.html"),
        v2: resolve(__dirname, "v2/index.html"),
        v2Editor: resolve(__dirname, "v2/editor.html"),
      },
    },
  },
});
