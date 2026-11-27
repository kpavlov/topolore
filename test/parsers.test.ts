import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectFormat, ingest, sourceBlock, wanted } from "../src/parsers/index.ts";
import { highlighted } from "../src/lib/model.ts";

const sample = (name: string) => readFileSync(new URL(`../public/samples/${name}`, import.meta.url), "utf8");
const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();

test("the samples still load through ingest", () => {
  for (const name of ["platform.hcl", "multicloud.json", "serverless.tf"])
    assert.ok(ingest([{ path: name, text: sample(name) }]).infra.nodes.length > 3, name);
});

test("references resolve across .tf files, through locals and data sources", () => {
  const loaded = ingest([
    { path: "infra/vpc.tf", text: 'resource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\nvariable "cidr" { default = "10.0.0.0/16" }\nlocals { vpc = aws_vpc.main.id }' },
    { path: "infra/ecs.tf", text: [
      'resource "aws_ecs_service" "api" {',
      '  name = "api-${var.env}"',
      '  vpc = local.vpc',
      '  depends_on = [aws_lb.front]',
      '  count = var.enabled ? 1 : 0',
      '  subnets = [for s in aws_subnet.all : s.id]',
      '  arn = "${lookup(var.arns, "api")}"',
      '  zone = data.aws_route53_zone.z.id',
      '}',
      'resource "aws_subnet" "all" { vpc_id = aws_vpc.main.id }',
      'resource "aws_lb" "front" { tags = { Name = "x" } }',
      'data "aws_route53_zone" "z" { name = aws_route53_record.r[0].name }',
      'resource "aws_route53_record" "r" { count = 2 }',
    ].join("\n") },
  ]);
  const edges = ids(loaded.infra.edges);
  for (const to of ["aws_vpc.main", "aws_lb.front", "aws_subnet.all", "aws_route53_record.r"])
    assert.ok(edges.includes(`aws_ecs_service.api->${to}`), to);
  const api = loaded.infra.nodes.find((n) => n.id === "aws_ecs_service.api")!;
  assert.deepEqual([api.sourceFile, api.lineStart, api.lineEnd], ["infra/ecs.tf", 1, 9]);
  assert.match(sourceBlock(api, loaded.sources)!, /^resource "aws_ecs_service" "api" \{[\s\S]*\n\}$/);
  assert.equal(api.props?.vpc, "local.vpc");
});

test("each directory is its own module: equal addresses do not collide or cross-link", () => {
  const module = 'resource "aws_s3_bucket" "this" {}\nresource "aws_lambda_function" "fn" { bucket = aws_s3_bucket.this.id }';
  const { infra } = ingest([{ path: "a/main.tf", text: module }, { path: "b/main.tf", text: module }]);
  assert.deepEqual(ids(infra.edges), ["a/aws_lambda_function.fn->a/aws_s3_bucket.this", "b/aws_lambda_function.fn->b/aws_s3_bucket.this"]);
});

test("one broken file among many is reported, not fatal", () => {
  const loaded = ingest([{ path: "ok.tf", text: 'resource "aws_vpc" "a" {}' }, { path: "bad.tf", text: 'resource "x" "y" {' }, { path: "package.json", text: '{"name":"x"}' }]);
  assert.equal(loaded.infra.nodes.length, 1);
  assert.match(loaded.warnings.join(), /bad\.tf: /);
  assert.deepEqual(loaded.sources.map((s) => s.path), ["ok.tf"]);
});

test(".tf.json resolves references to and from .tf files", () => {
  const { infra } = ingest([
    { path: "a.tf.json", text: JSON.stringify({ resource: { aws_lambda_function: { fn: { role: "${aws_iam_role.r.arn}", depends_on: ["aws_sqs_queue.q"] } } } }) },
    { path: "b.tf", text: 'resource "aws_iam_role" "r" {}\nresource "aws_sqs_queue" "q" {}' },
  ]);
  assert.deepEqual(ids(infra.edges), ["aws_lambda_function.fn->aws_iam_role.r", "aws_lambda_function.fn->aws_sqs_queue.q"]);
});

test("folder filter skips vendored and lock files", () => {
  for (const path of ["main.tf", "k8s/app.yaml", "x.topolore.json", "main.tf.json"]) assert.ok(wanted(path), path);
  for (const path of [".git/config.json", "node_modules/a/package.json", "x/.terraform/modules/m.tf", ".terraform.lock.hcl", "a.png"]) assert.ok(!wanted(path), path);
});

test("unrecognised or unsupported input fails loudly instead of drawing nothing", () => {
  assert.throws(() => ingest([{ path: "package.json", text: '{"name":"x"}' }]), /cannot tell/);
  assert.throws(() => ingest([{ path: "x", text: '{"@level":"info"}\n{"@level":"info"}' }]), /terraform show -json/);
});

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    depends_on: { api: { condition: service_started } }
    networks: [front]
  api:
    build: ./api
    links: ["cache:redis"]
    environment:
      - DB_PASSWORD=hunter2hunter2
    networks: [front, back]
  db:
    image: registry:5000/library/postgres:16
    environment: { POSTGRES_PASSWORD: s3cretvalue }
    networks: [back]
  cache:
    image: redis:7
`;

test("docker compose: kinds, depends_on, links, networks and redacted environment", () => {
  const { infra, sources } = ingest([{ path: "compose.yaml", text: COMPOSE }]);
  assert.deepEqual(ids(infra.edges), ["api->cache", "api->db", "web->api"]);
  assert.equal(infra.edges.find((e) => e.id === "api->db")?.undirected, true);
  assert.equal(infra.edges.find((e) => e.id === "web->api")?.undirected, undefined, "depends_on wins over a shared network");
  assert.deepEqual(ids(infra.nodes.filter((n) => highlighted(infra, ["category:data"]).has(n.id))), ["cache", "db"]);
  assert.doesNotMatch(JSON.stringify(infra), /hunter2|s3cretvalue/);
  const db = infra.nodes.find((n) => n.id === "db")!;
  assert.match(sourceBlock(db, sources)!, /^\s*db:\n\s+image:[\s\S]*networks: \[back\]$/);
  assert.equal(detectFormat("pasted", COMPOSE), "compose");
});

const K8S = `apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: shop }
spec:
  template:
    metadata: { labels: { app: api, tier: web } }
    spec:
      containers:
        - name: api
          image: api:1
          envFrom: [{ configMapRef: { name: settings } }]
          env: [{ name: KEY, valueFrom: { secretKeyRef: { name: creds, key: k } } }]
      volumes: [{ name: d, persistentVolumeClaim: { claimName: data } }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: other, namespace: elsewhere }
spec: { template: { metadata: { labels: { app: api } }, spec: { containers: [] } } }
---
apiVersion: v1
kind: Service
metadata: { name: api-svc, namespace: shop }
spec: { selector: { app: api } }
---
apiVersion: v1
kind: Service
metadata: { name: headless, namespace: shop }
spec: {}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: edge, namespace: shop }
spec:
  rules: [{ host: shop.test, http: { paths: [{ path: /, backend: { service: { name: api-svc } } }] } }]
---
apiVersion: v1
kind: ConfigMap
metadata: { name: settings, namespace: shop }
data: { A: "1" }
---
apiVersion: v1
kind: Secret
metadata: { name: creds, namespace: shop }
data: { k: c3VwZXJzZWNyZXQ= }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data, namespace: shop }
`;

test("Kubernetes: selectors, ingress backends and references, within a namespace", () => {
  const { infra } = ingest([{ path: "all.yaml", text: K8S }]);
  const from = (id: string) => infra.edges.filter((e) => e.from === id).map((e) => e.to).sort();
  assert.deepEqual(from("shop/service/api-svc"), ["shop/deployment/api"]);
  assert.deepEqual(from("shop/service/headless"), []);
  assert.deepEqual(from("shop/ingress/edge"), ["shop/service/api-svc"]);
  assert.deepEqual(from("shop/deployment/api"), ["shop/configmap/settings", "shop/persistentvolumeclaim/data", "shop/secret/creds"]);
  assert.doesNotMatch(JSON.stringify(infra), /c3VwZXJzZWNyZXQ/);
  const secret = infra.nodes.find((n) => n.id === "shop/secret/creds")!;
  assert.equal(secret.parent, "namespace:shop");
  assert.ok(secret.lineStart! > 30 && secret.lineEnd! > secret.lineStart!);
});

const STATE = {
  format_version: "1.0",
  values: { root_module: {
    resources: [{ address: "aws_vpc.main", mode: "managed", type: "aws_vpc", name: "main", values: { cidr_block: "10.0.0.0/16" } }],
    child_modules: [{ address: "module.app", resources: [
      { address: "module.app.aws_db_instance.db[0]", mode: "managed", type: "aws_db_instance", name: "db", values: { identifier: "orders", password: "p4ssw0rd-zz" }, sensitive_values: { password: true }, depends_on: ["aws_vpc.main"] },
      { address: "module.app.aws_lambda_function.fn", mode: "managed", type: "aws_lambda_function", name: "fn", values: {} },
      { address: "module.app.data.aws_region.x", mode: "data", type: "aws_region", name: "x", values: {} },
    ] }],
  } },
  configuration: { root_module: {
    resources: [{ address: "aws_vpc.main", mode: "managed" }],
    module_calls: { app: { expressions: { vpc: { references: ["aws_vpc.main.id", "aws_vpc.main"] } }, module: { resources: [
      { address: "aws_db_instance.db", mode: "managed", expressions: { subnet: { references: ["var.vpc"] } } },
      { address: "aws_lambda_function.fn", mode: "managed", expressions: { environment: [{ variables: { references: ["aws_db_instance.db[0].address", "aws_db_instance.db[0]"] } }] } },
    ] } } },
  } },
};

test("terraform show -json: child modules, references, depends_on and sensitive values", () => {
  const { infra, sources, diff } = ingest([{ path: "state.json", text: JSON.stringify(STATE) }]);
  assert.equal(diff, undefined);
  assert.equal(infra.nodes.length, 3);
  assert.deepEqual(ids(infra.edges), ["module.app.aws_db_instance.db[0]->aws_vpc.main", "module.app.aws_lambda_function.fn->module.app.aws_db_instance.db[0]"]);
  const db = infra.nodes.find((n) => n.id.endsWith("db[0]"))!;
  assert.equal(db.label, "orders");
  assert.equal(db.kind, "aws.rds");
  assert.equal(db.props?.password, "(sensitive)");
  assert.match(sourceBlock(db, sources)!, /"identifier": "orders"/);
});

test("a plan with changes becomes a diff, and a changed secret shows without its value", () => {
  const res = (address: string, actions: string[], before: object | null, after: object | null, extra = {}) =>
    ({ address, mode: "managed", type: address.split(".")[0], name: address.split(".")[1], change: { actions, before, after, ...extra } });
  const plan = {
    format_version: "1.2",
    resource_changes: [
      res("aws_vpc.main", ["no-op"], { cidr: "a" }, { cidr: "a" }),
      res("aws_db_instance.db", ["update"], { password: "old-secret-1", size: 1 }, { password: "new-secret-2", size: 2 }, { before_sensitive: { password: true }, after_sensitive: { password: true } }),
      res("aws_sqs_queue.new", ["create"], null, { name: "q" }, { after_unknown: { arn: true } }),
      res("aws_sns_topic.old", ["delete"], { name: "t" }, null),
    ],
  };
  const { diff, infra } = ingest([{ path: "plan.json", text: JSON.stringify(plan) }]);
  assert.equal(infra.nodes.length, 3);
  assert.deepEqual(ids(diff!.base.nodes), ["aws_db_instance.db", "aws_sns_topic.old", "aws_vpc.main"]);
  const db = diff!.target.nodes.find((n) => n.id === "aws_db_instance.db")!;
  assert.equal(db.props?.password, "(sensitive, changed)");
  assert.doesNotMatch(JSON.stringify(diff), /secret-/);
  assert.equal(diff!.target.nodes.find((n) => n.id === "aws_sqs_queue.new")!.props?.arn, "(known after apply)");
});
