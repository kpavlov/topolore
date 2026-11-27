import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, applyUpdate, capacityLabel } from "../src/lib/model.ts";
import { parseHcl } from "../src/lib/hcl.ts";
import { advanceRecording, recording, recordingState } from "../src/lib/stream.ts";
import { nodeEvents } from "../src/graph/node-events.ts";
import { checkUpdate } from "../src/lib/mcp.ts";
// @ts-expect-error Svelte does not publish types for its client runtime.
import { proxy, snapshot } from "svelte/internal/client";

test("recording timestamps use UTC by default and honor offsets", () => {
  const data = recording([
    '{"at":"2024-07-30T12:00:00","type":"node","id":"a","state":"ok"}',
    '{"at":"2024-07-30T15:30:00+02:00","type":"node","id":"a","state":"down"}',
    '{"type":"node","id":"a","state":"ok"}',
  ].join("\n"));
  assert.equal(data.start, Date.parse("2024-07-30T12:00:00Z"));
  assert.deepEqual(data.events.map(([at]) => at), [0, 5400, 5400]);
  assert.throws(() => recording('{"at":"bad","type":"node"}'), /Line 1/);
  assert.throws(() => recording('{"t":2,"type":"node"}\n{"t":1,"type":"node"}'), /chronological/);
});

test("playback spaces simultaneous and nearby events without slowing large gaps", () => {
  const { events } = recording('{"t":0,"type":"node","id":"a","state":"ok"}\n{"t":0,"type":"node","id":"a","state":"down"}\n{"t":1,"type":"node","id":"a","state":"ok"}\n{"t":100,"type":"node","id":"a","state":"fire"}');
  let step = advanceRecording(events, 0, -1, 0, 0.1, 10);
  assert.equal(step.index, 0);
  assert.equal(step.wait, 0.8);
  step = advanceRecording(events, step.position, step.index, step.wait, 0.4, 10);
  assert.equal(step.index, 0);
  step = advanceRecording(events, step.position, step.index, step.wait, 0.4, 10);
  assert.equal(step.index, 1);
  assert.ok(Math.abs(step.wait - 0.7) < 1e-9);
  step = advanceRecording(events, step.position, step.index, step.wait, 0.81, 10);
  assert.equal(step.index, 2);
  assert.equal(step.wait, 0);
  step = advanceRecording(events, step.position, step.index, step.wait, 1, 10);
  assert.equal(step.position, 11);
  assert.equal(step.index, 2);
  const base = normalize({ nodes: [{ id: "a" }] });
  assert.equal(recordingState(base, events, 0, 0).nodes[0].state, "ok");
  assert.equal(recordingState(base, events, 0, 1).nodes[0].state, "down");
});

test("seeking reconstructs additions, traffic changes and removals from the baseline", () => {
  const base = normalize({ nodes: [{ id: "a", kind: "generic" }, { id: "b", kind: "generic" }], edges: [{ from: "a", to: "b", rps: 5 }] });
  const data = recording([
    '{"t":0,"type":"node","id":"c","kind":"generic"}',
    '{"t":1,"type":"edge","from":"a","to":"c","rps":50}',
    '{"t":2,"type":"remove","id":"a->b"}',
    '{"t":3,"type":"remove","id":"c"}',
  ].join("\n"));
  const late = recordingState(base, data.events, 3);
  assert.equal(late.edges.length, 0);
  const early = recordingState(base, data.events, 1);
  assert.equal(early.edges.find((e) => e.id === "a->c")?.rps, 50);
  assert.ok(early.edges.some((e) => e.id === "a->b"));
  assert.equal(base.nodes.length, 2);
});

test("reactive topologies can be snapshotted and replayed", () => {
  const infra = proxy(normalize({ nodes: [{ id: "a", kind: "generic" }], edges: [] }));
  assert.throws(() => structuredClone(infra), { name: "DataCloneError" });
  const base = snapshot(infra);
  const data = recording('{"t":1,"type":"node","id":"a","state":"down"}');
  assert.equal(recordingState(base, data.events, 1).nodes[0].state, "down");
  assert.equal(recordingState(base, data.events, 0).nodes[0].state, "ok");
});

test("replay transitions distinguish added, changed and removed nodes", () => {
  const before = normalize({ nodes: [{ id: "same" }, { id: "changed" }, { id: "removed" }] });
  const after = normalize({ nodes: [{ id: "same" }, { id: "changed", state: "degraded" }, { id: "added" }] });
  assert.deepEqual(Object.fromEntries(nodeEvents(before.nodes, after.nodes)), { changed: "changed", added: "added", removed: "removed" });
  assert.deepEqual(Object.fromEntries(nodeEvents(after.nodes, before.nodes)), { changed: "changed", removed: "added", added: "removed" });
});

test("bundled recordings apply to their starting topologies", () => {
  for (const name of ["azure-incident", "github-actions-incident"]) {
    const file = (ext: string) => readFileSync(new URL(`../public/samples/${name}.${ext}`, import.meta.url), "utf8");
    const infra = normalize(JSON.parse(file("json")));
    for (const [, update] of recording(file("jsonl")).events) {
      assert.equal(checkUpdate(infra, update), null);
      applyUpdate(infra, update);
    }
    if (name === "azure-incident") {
      assert.equal(infra.nodes.find((n) => n.id === "services")?.state, "ok");
      assert.ok(!infra.nodes.some((n) => n.id === "device"));
    } else {
      assert.ok(!infra.nodes.some((n) => n.id === "config" || n.id === "recovery"));
      assert.equal(infra.nodes.find((n) => n.id === "runner-pool")?.state, "ok");
    }
  }
});

test("GitHub Actions incident distinguishes resumed allocations from full recovery", () => {
  const file = (ext: string) => readFileSync(new URL(`../public/samples/github-actions-incident.${ext}`, import.meta.url), "utf8");
  const base = normalize(JSON.parse(file("json")));
  const { events, start } = recording(file("jsonl"));
  const at = (time: string) => recordingState(base, events, (Date.parse(`2026-05-06T${time}Z`) - start!) / 1000);
  const resumed = at("08:51:00");
  assert.ok(!resumed.nodes.some((node) => node.id === "config"));
  assert.ok(resumed.nodes.some((node) => node.id === "recovery"));
  assert.equal(resumed.nodes.find((node) => node.id === "runner-pool")?.state, "degraded");
  assert.equal(at("09:15:00").nodes.find((node) => node.id === "runner-pool")?.state, "ok");
});

test("sample index points to existing topology and recording files", () => {
  const path = new URL("../public/samples/", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", path), "utf8")) as { id: string; file: string; events?: string; group: string }[];
  assert.equal(new Set(index.map((sample) => sample.id)).size, index.length);
  assert.equal(index.filter((sample) => sample.group === "Postmortems").length, 2);
  for (const sample of index) for (const file of [sample.file, sample.events].filter((file): file is string => !!file))
    assert.ok(readFileSync(new URL(file, path)).length, file);
});

test("retail recording scales capacity and restores it on rewind", () => {
  const file = (name: string) => readFileSync(new URL(`../public/samples/${name}`, import.meta.url), "utf8");
  const base = parseHcl(file("platform.hcl"));
  const { events } = recording(file("platform.jsonl"));
  const check = structuredClone(base);
  for (const [, update] of events) {
    assert.equal(checkUpdate(check, update), null);
    applyUpdate(check, update);
  }
  const label = (at: number, id: string) => capacityLabel(recordingState(base, events, at).nodes.find((node) => node.id === id)!);
  assert.equal(label(27, "web"), "30 pods");
  assert.match(label(27, "use1-nodepool"), /^10 instances/);
  assert.equal(label(0, "web"), "12 pods");
});

test("Azure incident keeps residual failures and the device until its reported removal", () => {
  const file = (ext: string) => readFileSync(new URL(`../public/samples/azure-incident.${ext}`, import.meta.url), "utf8");
  const base = normalize(JSON.parse(file("json")));
  const { events, start } = recording(file("jsonl"));
  const at = (time: string) => recordingState(base, events, (Date.parse(`2024-07-30T${time}Z`) - start!) / 1000);
  const residual = at("13:58:00");
  assert.equal(residual.edges.find((edge) => edge.id === "ddos->device")?.state, "slow");
  assert.equal(residual.nodes.find((node) => node.id === "services")?.state, "degraded");
  assert.equal(at("17:50:00").nodes.find((node) => node.id === "device")?.state, "degraded");
  assert.ok(!at("19:32:00").nodes.some((node) => node.id === "device"));
  assert.equal(at("19:43:00").nodes.find((node) => node.id === "services")?.state, "ok");
});
