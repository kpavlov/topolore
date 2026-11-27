import { test } from "node:test";
import assert from "node:assert/strict";
import { loadZoom, saveZoom } from "../src/lib/zoom.ts";

test("zoom persists and ignores invalid values or blocked storage", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  assert.equal(loadZoom(), undefined);
  saveZoom(1.75);
  assert.equal(loadZoom(), 1.75);
  saveZoom(Infinity);
  assert.equal(loadZoom(), 1.75);
  values.set("topolore.zoom", "not-a-number");
  assert.equal(loadZoom(), undefined);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  assert.equal(loadZoom(), undefined);
  assert.doesNotThrow(() => saveZoom(2));
  Reflect.deleteProperty(globalThis, "localStorage");
});
