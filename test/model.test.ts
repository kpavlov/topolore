import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHcl } from "../src/lib/hcl.ts";
import { applyUpdate, capacityLabel, normalize } from "../src/lib/model.ts";
import { iconSvg, lookOf, terraformKind } from "../src/lib/catalog.ts";
import { checkUpdate, defineTools } from "../src/lib/mcp.ts";

const sample = (name: string) => readFileSync(new URL(`../public/samples/${name}`, import.meta.url), "utf8");

test("HCL blocks nest groups and turn calls into edges", () => {
  const infra = parseHcl(sample("platform.hcl"));
  assert.equal(infra.title, "Nimbus Retail · global platform");
  assert.equal(infra.nodes.find((n) => n.id === "catalog")?.parent, "use1-commerce");
  assert.equal(infra.groups.find((g) => g.id === "use1-eks")?.parent, "use1-vpc");
  assert.ok(infra.edges.some((e) => e.id === "cdn->edge-worker"));
  assert.equal(infra.edges.find((e) => e.id === "catalog->catalog-db")?.rps, 1400);
});

test("Terraform references, nested blocks and interpolations become edges", () => {
  const ids = parseHcl(sample("serverless.tf")).edges.map((e) => e.id);
  assert.ok(ids.includes("aws_cloudfront_distribution.site->aws_s3_bucket.site"));
  assert.ok(ids.includes("aws_lambda_function.orders->aws_sqs_queue.ship"));
  assert.equal(terraformKind("aws_lambda_function"), "aws.lambda");
  assert.equal(terraformKind("kubernetes_stateful_set_v1"), "k8s.statefulset");
  assert.equal(terraformKind("google_spanner_instance"), "gcp.spanner-instance");
});

test("updates change state in place and report topology changes", () => {
  const infra = normalize(JSON.parse(sample("multicloud.json")));
  assert.equal(applyUpdate(infra, { type: "node", id: "checkout", state: "fire", message: "OOM" }), false);
  assert.equal(infra.nodes.find((n) => n.id === "checkout")?.state, "fire");
  assert.equal(applyUpdate(infra, { type: "edge", from: "checkout", to: "payments", state: "broken" }), false);
  assert.equal(infra.edges.find((e) => e.id === "checkout->payments")?.state, "broken");
  assert.equal(applyUpdate(infra, { type: "node", id: "nobody" }), false, "an unknown node without a kind is ignored");
  assert.equal(applyUpdate(infra, { type: "node", id: "cache", kind: "gcp.memorystore", parent: "gcp" }), true);
  assert.equal(applyUpdate(infra, { type: "remove", id: "checkout" }), true);
  assert.ok(!infra.edges.some((e) => e.from === "checkout" || e.to === "checkout"));
});

test("capacity labels show replicas, instance type and autoscaling changes", () => {
  const infra = parseHcl(sample("platform.hcl"));
  const web = infra.nodes.find((n) => n.id === "web")!;
  const pool = infra.nodes.find((n) => n.id === "use1-nodepool")!;
  assert.equal(capacityLabel(web), "12 pods");
  assert.equal(capacityLabel(pool), "6 instances · m6i.large · ASG shop-prod-workers · min 3 · max 12");
  applyUpdate(infra, { type: "node", id: "web", metrics: { replicas: 30 } });
  applyUpdate(infra, { type: "node", id: "use1-nodepool", metrics: { instances: 10 } });
  assert.equal(capacityLabel(web), "30 pods");
  assert.match(capacityLabel(pool), /^10 instances · m6i.large/);
});

test("bad files fail with a readable message", () => {
  assert.throws(() => normalize({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] }), /"b", which is not a node/);
  assert.throws(() => parseHcl('node "a" { kind = "x" '), /./);
});

test("topology reference links survive ingestion and reject unsafe URLs", async () => {
  const { ingest } = await import("../src/parsers/index.ts");
  const links = [{ label: "Postmortem", url: "https://example.com/review" }];
  const loaded = ingest([{ path: "incident.json", text: JSON.stringify({ title: "Incident", links, nodes: [{ id: "api" }] }) }]);
  assert.deepEqual(loaded.infra.links, links);
  assert.throws(() => normalize({ links: [{ label: "Bad", url: "javascript:alert(1)" }] }), /HTTP or HTTPS/);
  assert.throws(() => normalize({ links: "https://example.com" }), /must be a list/);
});

test("kinds map to provider icons", () => {
  assert.equal(lookOf("aws.rds").icon, "aws-rds");
  assert.equal(lookOf("k8s.deployment").badge, "deploy");
  assert.equal(lookOf("gcp.run").icon, "google-cloud-run");
  assert.equal(lookOf("saas.stripe").icon, "stripe");
  assert.equal(lookOf("azure.cosmos").badge, "Cosmos");
});

test("external kinds have recognizable icons without overriding provider icons", () => {
  for (const [kind, icon] of [["customers", "external-people"], ["user", "external-person"], ["client.mobile", "external-mobile"],
    ["browser", "external-browser"], ["internet", "external-globe"], ["partner", "external-integration"]]) {
    const look = lookOf(kind);
    assert.equal(look.icon, icon);
    assert.equal(look.category, "edge");
    assert.equal(look.shape, kind === "customers" || kind === "client.mobile" ? "slab" : "sphere");
    assert.match(iconSvg(icon)!, /<svg/);
  }
  assert.equal(lookOf("aws.rds").icon, "aws-rds");
});

test("infra text round-trips through a URL value", async () => {
  const { decodeInfra, encodeInfra, infraParam } = await import("../src/lib/share.ts");
  const text = sample("platform.hcl");
  const value = await encodeInfra(text);
  assert.match(value, /^[\w-]+$/);
  assert.ok(value.length < text.length / 2);
  assert.equal(await decodeInfra(value), text);
  assert.equal(await decodeInfra(Buffer.from('node "a" { kind = "x" }').toString("base64url")), 'node "a" { kind = "x" }');
  assert.equal(infraParam(new URL(`https://x/#infra=${value}`)), value);
  assert.equal(infraParam(new URL(`https://x/?infra=${value}`)), value);
});

test("flow speed comes from the edge or its latency", async () => {
  const { flowSpeed } = await import("../src/lib/model.ts");
  assert.equal(flowSpeed({}), "medium");
  assert.equal(flowSpeed({ latencyMs: 20 }), "fast");
  assert.equal(flowSpeed({ latencyMs: 120 }), "medium");
  assert.equal(flowSpeed({ latencyMs: 900 }), "slow");
  assert.equal(flowSpeed({ latencyMs: 900, speed: "fast" }), "fast");
  const edges = parseHcl(sample("platform.hcl")).edges;
  assert.equal(edges.find((e) => e.id === "recs->features")?.speed, "slow");
  assert.equal(flowSpeed(edges.find((e) => e.id === "payments->stripe")!), "slow");
});

test("without speed or latency, placement in the infrastructure decides", async () => {
  const { flowSpeed } = await import("../src/lib/model.ts");
  const infra = parseHcl(sample("platform.hcl"));
  const speed = (id: string) => flowSpeed(infra.edges.find((e) => e.id === id)!, infra);
  assert.equal(speed("catalog->catalog-db"), "fast", "same VPC");
  assert.equal(speed("dns->use1-alb"), "medium", "same cloud, outside the VPC");
  assert.equal(speed("web->sentry"), "slow", "to a SaaS API");
  assert.equal(speed("shoppers->cdn"), "slow", "from the internet");
});

test("a file without groups flows at medium speed", async () => {
  const { flowSpeed } = await import("../src/lib/model.ts");
  const infra = parseHcl('node "a" { kind = "x"  calls = ["b"] }\nnode "b" { kind = "y" }');
  assert.equal(flowSpeed(infra.edges[0], infra), "medium");
});

test("highlight terms match ids, labels, kinds, groups and issues", async () => {
  const { highlighted, splitTerms } = await import("../src/lib/model.ts");
  const infra = parseHcl(sample("platform.hcl"));
  const ids = (text: string) => [...highlighted(infra, splitTerms(text))].sort();
  assert.deepEqual(ids("payments, mobile BFF"), ["bff", "payments"]);
  assert.deepEqual(ids("aws.aurora"), ["euw1-replica", "orders-db"]);
  assert.ok(ids("k8s").includes("web") && !ids("k8s").includes("orders-db"));
  assert.deepEqual(ids("namespace: observability"), ["grafana", "otel", "prometheus"]);
  assert.deepEqual(ids("issues"), []);
  infra.nodes.find((n) => n.id === "orders")!.state = "fire";
  infra.edges.find((e) => e.id === "checkout->payments")!.state = "broken";
  assert.deepEqual(ids("issues"), ["checkout", "orders", "payments"]);
  assert.deepEqual(ids(" , "), []);
});

test("agent updates that would do nothing or break the scene are rejected", () => {
  const infra = normalize(JSON.parse(sample("multicloud.json")));
  const rejected = [
    null, "x", {}, { type: "nope" }, { type: "node" },
    { type: "node", id: "nobody", state: "fire" },
    { type: "node", id: "checkout", state: "burning" },
    { type: "node", id: "checkout", parent: "payments" },
    { type: "node", id: "gcp", kind: "gcp.run" },
    { type: "edge", state: "slow" },
    { type: "edge", from: "checkout", to: "nobody" },
    { type: "edge", id: "checkout->payments", state: "down" },
    { type: "group", id: "gcp", parent: "gcp" },
    { type: "remove", id: "nobody" },
    { type: "remove", id: "gcp" }, // still holds items
    { type: "snapshot", nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] },
  ];
  for (const u of rejected) assert.equal(typeof checkUpdate(infra, u), "string", JSON.stringify(u));
  for (const u of [
    { type: "node", id: "checkout", state: "fire" },
    { type: "node", id: "cache", kind: "gcp.memorystore", parent: "gcp" },
    { type: "edge", from: "checkout", to: "payments", state: "broken" },
    { type: "remove", id: "checkout" },
  ]) assert.equal(checkUpdate(infra, u), null, JSON.stringify(u));
});

test("agent tools report failures and respect readonly", async () => {
  const infra = normalize(JSON.parse(sample("multicloud.json")));
  const loads: string[] = [];
  const app = {
    readonly: false,
    state: () => ({ infra, selected: null, highlight: [], view: "iso" as const, simulating: false, status: { state: "idle" as const }, error: "", log: [] }),
    apply: (u: Parameters<typeof applyUpdate>[1]) => void applyUpdate(infra, u),
    load: async (text: string) => (loads.push(text), "bad file"),
    setHighlight() {}, select() {}, setView() {}, setSimulation() {},
  };
  const call = (name: string, args: Record<string, unknown>) => defineTools(app).find((t) => t.name === name)!.execute(args);

  const batch = await call("apply_updates", { updates: [
    { type: "node", id: "cache", kind: "gcp.memorystore", parent: "gcp" },
    null,
    { type: "edge", from: "checkout", to: "cache" },
  ] });
  assert.equal(batch.isError, true);
  assert.deepEqual(JSON.parse(batch.content[0].text).map((r: { ok: boolean }) => r.ok), [true, false, true]);
  assert.ok(infra.edges.some((e) => e.id === "checkout->cache"));

  assert.equal((await call("load_infra", { text: "  ", format: "hcl" })).isError, true);
  assert.equal((await call("load_infra", { text: "x", format: "yaml" })).isError, true);
  assert.deepEqual(loads, []);
  assert.equal((await call("load_infra", { text: "node", format: "hcl" })).isError, true);
  assert.equal((await call("set_view", { select: "nobody" })).isError, true);

  assert.deepEqual(defineTools(app).map((t) => t.name), ["get_topology", "apply_updates", "load_infra", "set_view", "set_simulation"]);
  assert.deepEqual(defineTools({ ...app, readonly: true }).map((t) => t.name), ["get_topology", "set_view"]);
});

test("wrong types and group cycles are refused before they can break the app", () => {
  const infra = normalize(JSON.parse(sample("multicloud.json")));
  for (const u of [
    { type: "node", id: "checkout", label: null },
    { type: "node", id: "checkout", kind: null },
    { type: "snapshot", nodes: [{ id: "a", label: 5 }], edges: [] },
    { type: "snapshot", nodes: [{ id: 7 }], edges: [] },
  ]) assert.equal(typeof checkUpdate(infra, u), "string", JSON.stringify(u));
  assert.equal(checkUpdate(infra, { type: "node", id: "checkout", parent: null }), null, "null parent moves to the top level");
  assert.throws(() => normalize({ nodes: [{ id: "a", label: 5 }] }), /"label" of "a" must be text/);
  assert.throws(() => normalize({ nodes: [{ id: "a", kind: 5 }] }), /"kind" of "a" must be text/);
  assert.throws(() => normalize({ groups: [{ id: "g", parent: "h" }, { id: "h", parent: "g" }] }), /inside itself/);
});
