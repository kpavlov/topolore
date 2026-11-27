import { test } from "node:test";
import assert from "node:assert/strict";
import { route, sourceRoute, streamRoute } from "../src/lib/router.ts";

test("sample links replace old source and recording while preserving view options", () => {
  const url = new URL("https://example.com/topolore/?src=old&stream=old&rotate#infra=secret&highlight=api");
  const next = sourceRoute(url, "sample", "azureIncident");
  assert.deepEqual(route(next), { infra: null, src: null, sample: "azureIncident", stream: null });
  assert.equal(next.searchParams.has("rotate"), true);
  assert.equal(new URLSearchParams(next.hash.slice(1)).get("highlight"), "api");
  assert.equal(route(new URL(next.href)).sample, "azureIncident");
});

test("external source and stream URLs round-trip and replace hash aliases", () => {
  const start = new URL("https://example.com/?sample=platform#events=old&src=old");
  const source = sourceRoute(start, "src", "https://other.example/infra.json?version=2");
  const connected = streamRoute(source, "https://other.example/events.jsonl?key=value");
  assert.deepEqual(route(new URL(connected.href)), { infra: null, src: "https://other.example/infra.json?version=2", sample: null, stream: "https://other.example/events.jsonl?key=value" });
  assert.equal(route(streamRoute(connected, "")).stream, null);
});

test("inline share links win over source and sample; hash options win over query", () => {
  const url = new URL("https://example.com/?sample=platform&src=one&stream=one#infra=encoded&stream=two");
  assert.deepEqual(route(url), { infra: "encoded", src: null, sample: null, stream: "two" });
  assert.equal(route(new URL("https://example.com/")).sample, "platform");
});
