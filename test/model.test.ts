import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHcl } from "../src/lib/hcl.ts";
import { applyUpdate, normalize } from "../src/lib/model.ts";
import { lookOf, terraformKind } from "../src/lib/catalog.ts";

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

test("bad files fail with a readable message", () => {
  assert.throws(() => normalize({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] }), /"b", which is not a node/);
  assert.throws(() => parseHcl('node "a" { kind = "x" '), /./);
});

test("kinds map to provider icons", () => {
  assert.equal(lookOf("aws.rds").icon, "aws-rds");
  assert.equal(lookOf("k8s.deployment").badge, "deploy");
  assert.equal(lookOf("gcp.run").icon, "google-cloud-run");
  assert.equal(lookOf("saas.stripe").icon, "stripe");
  assert.equal(lookOf("azure.cosmos").badge, "Cosmos");
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
