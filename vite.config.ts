import { defineConfig } from "vite";

// Served at https://spuder.github.io/shadow-garage/ — Vite needs the repo name as the base path
// so built asset URLs (JS/CSS) resolve correctly under that subpath instead of the domain root.
export default defineConfig({
  base: "/shadow-garage/",
});
