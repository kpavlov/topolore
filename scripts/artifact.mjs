// Inlines the Vite build into one self-contained page: dist/artifact.html.
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("dist/index.html", "utf8");
const read = (path) => readFileSync(`dist/${path.replace(/^\.\//, "")}`, "utf8");
const page = html
  .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, (_, src) => `<script type="module">${read(src).replaceAll("</script", "<\\/script")}</script>`)
  .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/, (_, href) => `<style>${read(href)}</style>`);
if (/src="\.\/assets|href="\.\/assets/.test(page)) throw new Error("An asset was left un-inlined.");
// Claude artifacts take a page fragment: no doctype, html, head or body, and they set charset and viewport themselves.
const fragment = page
  .replace(/<!doctype html>|<\/?(html|head|body)[^>]*>|<meta (charset|name="viewport")[^>]*>/gi, "")
  .replace(/\n\s*\n/g, "\n");
writeFileSync("dist/artifact.html", fragment);
console.log(`dist/artifact.html ${(page.length / 1024).toFixed(0)} KB`);
