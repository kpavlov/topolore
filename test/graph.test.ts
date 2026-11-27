import { test } from "node:test";
import assert from "node:assert/strict";
import { blastRadius } from "../src/graph/blast-radius.ts";
import { diffTopology } from "../src/graph/topology-diff.ts";
import { blastOverlay, diffOverlay } from "../src/graph/overlay.ts";
import { searchNodes } from "../src/graph/search.ts";
import { toMermaid } from "../src/export/mermaid.ts";
import { toSvg, type Drawing } from "../src/export/svg.ts";
import { toggleFilter } from "../src/lib/legend.ts";
import { highlighted, normalize } from "../src/lib/model.ts";

const graph = (nodes: string[], edges: [string, string][]) =>
  normalize({ nodes: nodes.map((id) => ({ id })), edges: edges.map(([from, to]) => ({ from, to })) });
const entries = (m: Map<string, unknown>) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));

test("blast radius counts the shortest hops each way", () => {
  // web → api → store ← worker ← cron, plus a shortcut web → store, a cycle, and an unrelated node
  const infra = graph(["web", "api", "store", "worker", "cron", "disk", "alone"],
    [["web", "api"], ["api", "store"], ["web", "store"], ["worker", "store"], ["cron", "worker"], ["store", "disk"]]);
  const blast = blastRadius(infra, "store");
  assert.deepEqual(entries(blast.upstream), { api: 1, cron: 2, web: 1, worker: 1 });
  assert.deepEqual(entries(blast.downstream), { disk: 1 });
  assert.deepEqual([...blast.downstreamEdges], ["store->disk"]);
  assert.ok(blast.upstreamEdges.has("web->api") && !blast.upstreamEdges.has("store->disk"));
  assert.equal(blastRadius(infra, "web").upstream.size, 0);
  assert.deepEqual(entries(blastRadius(infra, "web").downstream), { api: 1, disk: 2, store: 1 });

  const overlay = blastOverlay(infra, blast);
  assert.equal(overlay.nodes.get("cron")?.badge, "+2");
  assert.equal(overlay.nodes.get("alone")?.opacity, 0.12);
  assert.equal(overlay.nodes.get("store")?.pulse, true);
});

test("blast radius ends in a cycle and ignores links without direction", () => {
  const infra = graph(["a", "b", "c"], [["a", "b"], ["b", "a"], ["a", "c"]]);
  infra.edges[2].undirected = true;
  const blast = blastRadius(infra, "a");
  assert.deepEqual(entries(blast.upstream), { b: 1 });
  assert.deepEqual(entries(blast.downstream), { b: 1 });
});

test("diff classifies added, removed, modified and unchanged", () => {
  const base = normalize({ groups: [{ id: "g" }], nodes: [
    { id: "same", props: { a: 1, b: { c: 2 } } }, { id: "changed", props: { size: 1 } }, { id: "relinked" }, { id: "gone", parent: "g" },
  ], edges: [{ from: "relinked", to: "gone" }] });
  const target = normalize({ nodes: [
    { id: "same", props: { b: { c: 2 }, a: 1 }, lineStart: 9, metrics: { cpu: 1 } }, { id: "changed", props: { size: 2 } }, { id: "relinked" }, { id: "new" },
  ], edges: [{ from: "new", to: "same" }] });
  const diff = diffTopology(base, target);
  assert.deepEqual(entries(diff.nodes), { changed: "modified", gone: "removed", new: "added", relinked: "modified", same: "modified" });
  assert.deepEqual(diff.counts, { added: 1, removed: 1, modified: 3 });
  assert.deepEqual(diff.changes.get("changed"), [{ key: "size", before: "1", after: "2" }]);
  assert.deepEqual(diff.changes.get("same"), [{ key: "called by new", after: "linked" }]);
  assert.deepEqual(entries(diff.edges), { "new->same": "added", "relinked->gone": "removed" });
  assert.equal(diff.infra.nodes.find((n) => n.id === "gone")?.parent, "g", "a removed node keeps its removed plate");
  assert.equal(diff.infra.edges.length, 2);
  assert.equal(diffOverlay(diff, true).nodes.get("gone")?.ghost, true);
  const unchanged = diffTopology(base, structuredClone(base));
  assert.deepEqual(unchanged.counts, { added: 0, removed: 0, modified: 0 });
  assert.equal(diffOverlay(unchanged, true).nodes.get("same")?.opacity, 0.45);
});

test("diff detects null, empty collections and changes of value type", () => {
  const base = normalize({ nodes: [{ id: "a", props: { nullValue: null, list: [], object: {}, count: 1 } }] });
  const target = normalize({ nodes: [{ id: "a", props: { list: {}, object: [], count: "1" } }] });
  const diff = diffTopology(base, target);
  assert.equal(diff.nodes.get("a"), "modified");
  assert.deepEqual(diff.changes.get("a")?.map((change) => change.key).sort(), ["count", "list", "nullValue", "object"]);
});

const SHOP = normalize({ nodes: [
  { id: "payments-store", kind: "aws.rds", state: "fire", sourceFile: "vpc.tf" },
  { id: "api", label: "Public API", kind: "aws.lambda", props: { terraform: "aws_lambda_function" } },
  { id: "web", kind: "k8s.deployment" },
], edges: [{ from: "api", to: "payments-store", protocol: 'post"gres' }] });

test("search matches name, type, category, status and file, fuzzily", () => {
  const found = (q: string) => searchNodes(SHOP, q).map((n) => n.id);
  assert.equal(found("pay")[0], "payments-store");
  assert.equal(found("pmtstore")[0], "payments-store");
  assert.deepEqual(found("on fire"), ["payments-store"]);
  assert.deepEqual(found("vpc.tf"), ["payments-store"]);
  assert.deepEqual(found("aws_lambda"), ["api"]);
  assert.deepEqual(found("data"), ["payments-store"]);
  assert.deepEqual(found("public healthy"), ["api"]);
  assert.deepEqual(found("zzz"), []);
  assert.equal(found("").length, 3);
});

test("legend filters: a click isolates, Shift combines", () => {
  let terms = toggleFilter(["aws"], "category:data", false);
  assert.deepEqual(terms, ["aws", "category:data"]);
  terms = toggleFilter(terms, "state:fire", true);
  assert.deepEqual(terms, ["aws", "category:data", "state:fire"]);
  assert.deepEqual(toggleFilter(terms, "state:fire", false), ["aws", "state:fire"]);
  assert.deepEqual(toggleFilter(["category:data"], "category:data", false), []);
  assert.deepEqual([...highlighted(SHOP, ["state:fire"])], ["payments-store"]);
  assert.deepEqual([...highlighted(SHOP, ["state:ok", "category:data"])].sort(), ["api", "payments-store", "web"]);
});

test("Mermaid output groups by category and escapes labels", () => {
  const text = toMermaid(SHOP);
  assert.match(text, /^graph TD\n/);
  assert.match(text, /subgraph cat_data\["data"\]\n {4}n0\["payments-store"\]\n {2}end/);
  assert.match(text, /n1 -->\|"post#34;gres"\| n0/);
});

test("SVG is self-contained and escapes labels", () => {
  const drawing: Drawing = {
    width: 100, height: 100, theme: { bg: "#000", ink: "#fff", muted: "#999", line: "#333" }, groups: [], edges: [],
    nodes: [{ side: [[0, 0], [10, 0], [10, 10]], top: [[0, 0], [10, 0], [10, 5]], color: "#f00", opacity: 1, dashed: false, label: '<script>"&\u0001', at: [5, 10] }],
  };
  const svg = toSvg(drawing);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /<script>|\u0001|href=/);
  assert.match(svg, /&#60;script&#62;&#34;&#38;/);
});
