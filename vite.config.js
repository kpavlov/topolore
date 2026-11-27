import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// `pnpm dev` only, never a build: a WebMCP runtime, and the script that lets a local relay (`make mcp`) see the page's tools.
const webmcpRelay = {
  name: "webmcp-relay",
  apply: "serve",
  transformIndexHtml: () =>
    ["@mcp-b/global@6.2.0/dist/index.iife.js", "@mcp-b/webmcp-local-relay@6.2.0/dist/browser/embed.js"].map((path) => ({
      tag: "script",
      attrs: { src: `https://cdn.jsdelivr.net/npm/${path}` },
      injectTo: "head",
    })),
};

export default defineConfig({ base: "./", plugins: [svelte(), webmcpRelay], build: { chunkSizeWarningLimit: 3000 } });
