import { normalize, type Edge, type Infra, type InfraNode } from "../lib/model.ts";

export type Change = "added" | "removed" | "modified" | "unchanged";

export interface PropChange {
  key: string;
  before?: string;
  after?: string;
}

export interface TopologyDiff {
  /** Everything in the target plus what only the base had, so removals can be drawn. */
  infra: Infra;
  nodes: Map<string, Change>;
  edges: Map<string, Change>;
  /** What changed on each modified node. */
  changes: Map<string, PropChange[]>;
  counts: { added: number; modified: number; removed: number };
}

/** An item as `path → text`, so values compare whatever order their keys are in. */
function flatten(value: unknown, path: string, out: Map<string, unknown>) {
  if (value === undefined) return;
  if (Array.isArray(value) && value.length) value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === "object" && Object.keys(value).length)
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  else out.set(path, value);
}

function compare(before: object, after: object): PropChange[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(before, "", a);
  flatten(after, "", b);
  const display = (map: Map<string, unknown>, key: string) => {
    if (!map.has(key)) return undefined;
    const value = map.get(key);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
    .map((key) => ({ key, before: display(a, key), after: display(b, key) }));
}

// Source positions move when a file is edited, and metrics move by themselves: neither is a change.
const nodeFacts = ({ label, kind, parent, state, message, props }: InfraNode) => ({ label, kind, parent, state, message, ...props });
const edgeFacts = ({ label, protocol, state }: Edge) => ({ label, protocol, state });

export function diffTopology(base: Infra, target: Infra): TopologyDiff {
  const oldNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map(base.edges.map((e) => [e.id, e]));
  const newNodes = new Set(target.nodes.map((n) => n.id));
  const newEdges = new Set(target.edges.map((e) => e.id));

  const edges = new Map<string, Change>();
  const touched = new Map<string, PropChange[]>();
  const names = new Map([...base.nodes, ...target.nodes].map((n) => [n.id, n.label]));
  const touch = (e: Edge, what: (end: "from" | "to") => PropChange) => {
    for (const [id, end] of [[e.from, "to"], [e.to, "from"]] as const) touched.set(id, [...(touched.get(id) ?? []), what(end)]);
  };
  const link = (e: Edge, end: "from" | "to") => `${end === "to" ? "calls" : "called by"} ${names.get(e[end]) ?? e[end]}`;
  for (const e of target.edges) {
    const old = oldEdges.get(e.id);
    const differences = old ? compare(edgeFacts(old), edgeFacts(e)) : [];
    edges.set(e.id, !old ? "added" : differences.length ? "modified" : "unchanged");
    if (!old) touch(e, (end) => ({ key: link(e, end), after: "linked" }));
    else for (const d of differences) touch(e, (end) => ({ ...d, key: `${link(e, end)}: ${d.key}` }));
  }
  const goneEdges = base.edges.filter((e) => !newEdges.has(e.id));
  for (const e of goneEdges) edges.set(e.id, "removed"), touch(e, (end) => ({ key: link(e, end), before: "linked" }));

  const nodes = new Map<string, Change>();
  const changes = new Map<string, PropChange[]>();
  for (const n of target.nodes) {
    const old = oldNodes.get(n.id);
    if (!old) {
      nodes.set(n.id, "added");
      continue;
    }
    const all = [...compare(nodeFacts(old), nodeFacts(n)), ...(touched.get(n.id) ?? [])];
    nodes.set(n.id, all.length ? "modified" : "unchanged");
    if (all.length) changes.set(n.id, all);
  }

  const targetGroups = new Set(target.groups.map((g) => g.id));
  const groups = [...target.groups, ...base.groups.filter((g) => !targetGroups.has(g.id) && !newNodes.has(g.id))];
  const groupIds = new Set(groups.map((g) => g.id));
  const gone = base.nodes.filter((n) => !newNodes.has(n.id) && !groupIds.has(n.id));
  for (const n of gone) nodes.set(n.id, "removed");

  const all = [...target.nodes, ...gone.map((n) => ({ ...n, parent: n.parent && groupIds.has(n.parent) ? n.parent : undefined }))];
  const ids = new Set(all.map((n) => n.id));
  const infra = normalize({
    title: target.title,
    groups,
    nodes: all,
    edges: [...target.edges, ...goneEdges.filter((e) => ids.has(e.from) && ids.has(e.to))],
  });
  const count = (c: Change) => [...nodes.values()].filter((x) => x === c).length;
  return { infra, nodes, edges, changes, counts: { added: count("added"), modified: count("modified"), removed: count("removed") } };
}
