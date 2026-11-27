import type { Infra } from "../lib/model.ts";

export interface BlastRadius {
  root: string;
  /** Who breaks if the root fails: node id → hops away, against the direction of traffic. */
  upstream: Map<string, number>;
  /** What the root relies on: node id → hops away. In a cycle a node can be in both. */
  downstream: Map<string, number>;
  upstreamEdges: Set<string>;
  downstreamEdges: Set<string>;
}

function hops(root: string, next: Map<string, string[]>): Map<string, number> {
  const found = new Map<string, number>();
  let frontier = [root];
  for (let hop = 1; frontier.length; hop++)
    frontier = frontier
      .flatMap((id) => next.get(id) ?? [])
      .filter((id) => {
        if (id === root || found.has(id)) return false;
        found.set(id, hop);
        return true;
      });
  return found;
}

export function blastRadius(infra: Infra, root: string): BlastRadius {
  // A link without a direction says nothing about who depends on whom.
  const edges = infra.edges.filter((e) => !e.undirected);
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const e of edges) add(forward, e.from, e.to), add(backward, e.to, e.from);
  const upstream = hops(root, backward);
  const downstream = hops(root, forward);
  const within = (set: Map<string, number>, id: string) => id === root || set.has(id);
  return {
    root,
    upstream,
    downstream,
    upstreamEdges: new Set(edges.filter((e) => e.from !== root && within(upstream, e.from) && within(upstream, e.to)).map((e) => e.id)),
    downstreamEdges: new Set(edges.filter((e) => e.to !== root && within(downstream, e.from) && within(downstream, e.to)).map((e) => e.id)),
  };
}
