/** How a mode (blast radius, diff) paints each node and link. The scene draws it and knows nothing of the modes. */
import type { Infra } from "../lib/model.ts";
import type { BlastRadius } from "./blast-radius.ts";
import type { Change, TopologyDiff } from "./topology-diff.ts";

export interface Mark {
  opacity: number;
  tint?: string;
  badge?: string;
  /** Drawn as a wireframe: no longer there. */
  ghost?: boolean;
  pulse?: boolean;
}

export interface Overlay {
  nodes: Map<string, Mark>;
  edges: Map<string, Mark>;
}

const UPSTREAM = "#f59e0b";
const UPSTREAM_NEAR = "#ef4444";
const DOWNSTREAM = "#06b6d4";
const ROOT = "#ef4444";
const DIMMED = 0.12;

export function blastOverlay(infra: Infra, blast: BlastRadius): Overlay {
  const node = (id: string): Mark => {
    if (id === blast.root) return { opacity: 1, pulse: true, tint: ROOT };
    const up = blast.upstream.get(id);
    if (up) return { opacity: 1, tint: up === 1 ? UPSTREAM_NEAR : UPSTREAM, badge: `+${up}` };
    const down = blast.downstream.get(id);
    return down ? { opacity: 1, tint: DOWNSTREAM, badge: `+${down}` } : { opacity: DIMMED };
  };
  const edge = (id: string): Mark =>
    blast.upstreamEdges.has(id) ? { opacity: 1, tint: UPSTREAM } : blast.downstreamEdges.has(id) ? { opacity: 1, tint: DOWNSTREAM } : { opacity: DIMMED };
  return { nodes: new Map(infra.nodes.map((n) => [n.id, node(n.id)])), edges: new Map(infra.edges.map((e) => [e.id, edge(e.id)])) };
}

const DIFF_MARKS: Record<Exclude<Change, "unchanged">, Mark> = {
  added: { opacity: 1, tint: "#10b981", badge: "+" },
  removed: { opacity: 0.75, tint: "#ef4444", badge: "−", ghost: true },
  modified: { opacity: 1, tint: "#f59e0b", badge: "~" },
};

export function diffOverlay(diff: TopologyDiff, showUnchanged: boolean): Overlay {
  const marks = (changes: Map<string, Change>, badges: boolean) =>
    new Map<string, Mark>(
      [...changes].map(([id, change]) => [
        id,
        change === "unchanged" ? { opacity: showUnchanged ? 0.45 : 0.04 } : { ...DIFF_MARKS[change], badge: badges ? DIFF_MARKS[change].badge : undefined },
      ]),
    );
  return { nodes: marks(diff.nodes, true), edges: marks(diff.edges, false) };
}
