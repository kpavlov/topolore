import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolatePlate, layout } from "../src/lib/layout.ts";
import { normalize } from "../src/lib/model.ts";

test("plates grow and shrink smoothly between topology layouts", async () => {
  const infra = (count: number) => normalize({ groups: [{ id: "pool", label: "Pool" }], nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, parent: "pool" })) });
  const small = (await layout(infra(1))).groups.get("pool")!;
  const large = (await layout(infra(4))).groups.get("pool")!;
  assert.ok(large.w * large.d > small.w * small.d);
  assert.deepEqual(interpolatePlate(small, large, 0), { x: small.x, z: small.z, w: small.w, d: small.d });
  assert.deepEqual(interpolatePlate(large, small, 1), { x: small.x, z: small.z, w: small.w, d: small.d });
  const middle = interpolatePlate(small, large, 0.5);
  assert.equal(middle.w, (small.w + large.w) / 2);
  assert.equal(middle.d, (small.d + large.d) / 2);
});
