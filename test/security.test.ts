import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { redact, REDACTED, summarize } from "../src/security/secretScrubber.ts";
import { sharePayload, writeSnapshot } from "../src/lib/snapshot.ts";
import { ingest } from "../src/parsers/index.ts";
import { decodeInfra, encodeInfra } from "../src/lib/share.ts";

// Built from pieces so scanners do not take the fixtures for real credentials.
const AWS_ID = "AKIA" + "IOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY";
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join(".");
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA0Z3VS5JJcds3", "-----END RSA PRIVATE KEY-----"].join("\n");

const cases: [string, string, string][] = [
  ["AWS access key", `key = "${AWS_ID}"`, AWS_ID],
  ["HCL password", 'resource "aws_db_instance" "a" { password = "hunter2hunter2" }', "hunter2hunter2"],
  ["JSON key", '{"password": "hunter2hunter2"}', "hunter2hunter2"],
  ["AWS secret", `aws_secret_access_key = "${AWS_SECRET}"`, AWS_SECRET],
  ["random string under an innocent name", `value = "${AWS_SECRET}"`, AWS_SECRET],
  ["unquoted YAML", "POSTGRES_PASSWORD: hunter2hunter2", "hunter2hunter2"],
  ["compose list", "- DB_PASSWORD=hunter2hunter2", "hunter2hunter2"],
  ["quoted compose list", '- "DB_PASSWORD=hunter2hunter2"', "hunter2hunter2"],
  ["k8s env pair", "- name: DB_PASSWORD\n  value: hunter2hunter2", "hunter2hunter2"],
  ["ECS env pair", '{"name":"API_TOKEN","value":"hunter2hunter2"}', "hunter2hunter2"],
  ["YAML block", "password: |\n  hunter2hunter2\nnext: 1", "hunter2hunter2"],
  ["private key", `key = <<EOF\n${PEM}\nEOF`, "MIIEowIBAAKCAQEA"],
  ["JWT", `token: ${JWT}`, JWT],
  ["bearer", "Authorization: Bearer abcdefghij1234567890XYZ", "abcdefghij1234567890XYZ"],
  ["postgres URL", "url: postgres://app:hunter2hunter2@db:5432/x", "hunter2hunter2"],
  ["literal default in a placeholder", "POSTGRES_PASSWORD: ${PW:-hunter2hunter2}", "hunter2hunter2"],
  ["redis URL without a user", 'REDIS="redis://:hunter2hunter2@cache:6379"', "hunter2hunter2"],
];

test("secrets are found and removed", () => {
  for (const [name, input, secret] of cases) {
    const result = redact(input);
    assert.ok(result.findings.length >= 1, `${name}: not found`);
    assert.ok(!result.text.includes(secret), `${name}: ${result.text}`);
    assert.ok(result.text.includes(REDACTED), name);
  }
});

test("references, pointers and ordinary values are left alone", () => {
  for (const text of [
    'password = var.db_password', 'password = "${var.db_password}"', 'master_password = random_password.db.result', 'token = module.auth.token',
    'secretName: my-tls-secret', 'secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:db-AbCdEf"',
    'POSTGRES_PASSWORD_FILE: /run/secrets/db_password', 'password = random_string(16)', 'POSTGRES_PASSWORD: ${DB_PASSWORD}',
    'url: postgres://app:${PASSWORD}@db/x', 'image: app@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'resource "aws_secretsmanager_secret" "db" {}', 'kind: Secret', 'token_url = "https://auth.example.com/token"',
  ]) assert.deepEqual(redact(text), { text, findings: [] }, text);
  for (const name of ["platform.hcl", "multicloud.json", "serverless.tf"])
    assert.deepEqual(redact(readFileSync(new URL(`../public/samples/${name}`, import.meta.url), "utf8")).findings, [], name);
});

test("redacted YAML, JSON and HCL still parse", () => {
  const yaml = redact(`a:\n  password: hunter2hunter2\n  list: [token_x]\n  api_key: ${JWT} # note\n  flow: {secret: hunter2hunter2}\nb: |\n  ${PEM.replaceAll("\n", "\n  ")}\n`);
  const data = parse(yaml.text);
  assert.equal(data.a.password, REDACTED);
  assert.equal(data.a.flow.secret, REDACTED);
  assert.equal(data.b.trim(), REDACTED);
  assert.equal(JSON.parse(redact('{"password":"hunter2hunter2","db_password": 123456789}').text).password, REDACTED);
});

const SECRET = `apiVersion: v1
kind: Secret
metadata:
  name: creds
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"x":"aHVudGVyMg=="}}'
data:
  anything: aHVudGVyMg==
stringData:
  config: |
    plain words that are secret
---
apiVersion: v1
kind: ConfigMap
metadata: { name: ok }
data: { color: blue }
`;

test("Kubernetes Secret data is hidden whatever its keys are", () => {
  const { text, findings } = redact(SECRET);
  assert.doesNotMatch(text, /aHVudGVyMg|plain words/);
  assert.match(text, /color: blue/);
  assert.ok(findings.every((f) => f === "Kubernetes Secret"));
  assert.equal(ingest([{ path: "s.yaml", text }]).infra.nodes.length, 2);
});

test("Terraform sensitive values are hidden even under innocent names", () => {
  const state = JSON.stringify({ format_version: "1.0", values: { outputs: { dsn: { sensitive: true, value: "inner-dsn" } }, root_module: { resources: [
    { address: "x_y.z", mode: "managed", type: "x_y", name: "z", values: { blob: "tiny", n: 42 }, sensitive_values: { blob: true } }] } } });
  const { text, findings } = redact(state);
  assert.equal(summarize(findings), "Terraform sensitive value ×2");
  assert.doesNotMatch(text, /tiny|inner-dsn/);
  assert.equal(JSON.parse(text).values.root_module.resources[0].values.n, 42);
});

test("share payloads and snapshots can be redacted, and reload", async () => {
  const sources = [
    { path: "db.tf", text: 'resource "aws_db_instance" "db" { password = "hunter2hunter2" }' },
    { path: "app.tf", text: 'resource "aws_lambda_function" "fn" { db = aws_db_instance.db.id }' },
  ];
  const { infra } = ingest(sources);
  for (const layoutOnly of [false, true]) {
    const unsafe = sharePayload(infra, sources, { redact: false, layoutOnly });
    const safe = sharePayload(infra, sources, { redact: true, layoutOnly });
    assert.equal(unsafe.findings.length, safe.findings.length);
    assert.doesNotMatch(safe.text, /hunter2/);
    const back = ingest([{ path: "Link", text: await decodeInfra(await encodeInfra(safe.text)) }]);
    assert.deepEqual(back.infra.edges.map((e) => e.id), ["aws_lambda_function.fn->aws_db_instance.db"]);
    assert.equal(/hunter2/.test(unsafe.text), !layoutOnly, "layout-only carries no attributes");
  }
  const camera = { view: "iso" as const, position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], zoom: 2 };
  const snapshot = writeSnapshot(infra, sources, camera, true);
  assert.equal(snapshot.findings.length, 1);
  assert.doesNotMatch(snapshot.text, /hunter2/);
  const back = ingest([{ path: "x.topolore.json", text: snapshot.text }]);
  assert.deepEqual(back.camera, camera);
  assert.equal(back.sources.length, 2);
  // With no sources, the attributes in the topology are all there is to scan.
  const bare = writeSnapshot(infra, [], undefined, true);
  assert.equal(bare.findings.length, 1);
  assert.doesNotMatch(bare.text, /hunter2/);
});

test("a single file travels as plain text, so old links keep working", () => {
  const text = 'node "a" { kind = "x" }';
  assert.equal(sharePayload(ingest([{ path: "a.hcl", text }]).infra, [{ path: "a.hcl", text }], { redact: true, layoutOnly: false }).text, text);
});

test("a bundle cannot nest another bundle", () => {
  const inner = JSON.stringify({ version: 1, rawSources: [{ path: "a", text: "x" }] });
  assert.throws(() => ingest([{ path: "l", text: JSON.stringify({ version: 1, rawSources: [{ path: "l", text: inner }] }) }]), /no topology/);
});
