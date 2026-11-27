export type NodeState = "ok" | "degraded" | "down" | "fire" | "unknown";
export type EdgeState = "ok" | "slow" | "broken" | "idle";
export type FlowSpeed = "slow" | "medium" | "fast";

/** A container drawn as a plate: cloud, region, VPC, cluster, namespace… */
export interface Group {
  id: string;
  label: string;
  kind?: string;
  parent?: string;
}

/** Something that runs or stores: a service, a database, a queue, a load balancer. */
export interface InfraNode {
  id: string;
  label: string;
  kind: string;
  parent?: string;
  state?: NodeState;
  message?: string;
  metrics?: Record<string, number | string>;
  props?: Record<string, unknown>;
}

/** Traffic from one node to another, in the direction requests flow. */
export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
  protocol?: string;
  state?: EdgeState;
  rps?: number;
  latencyMs?: number;
  /** How fast the flow animates; without it, worked out from `latencyMs`. */
  speed?: FlowSpeed;
  errorRate?: number;
  message?: string;
}

export interface Infra {
  title?: string;
  groups: Group[];
  nodes: InfraNode[];
  edges: Edge[];
}

/** One message from the update stream. Unknown ids that carry a `kind` add a node or an edge. */
export type Update =
  | ({ type: "node"; id: string } & Partial<Omit<InfraNode, "id">>)
  | ({ type: "edge"; id?: string; from?: string; to?: string } & Partial<Omit<Edge, "id" | "from" | "to">>)
  | ({ type: "group"; id: string } & Partial<Omit<Group, "id">>)
  | { type: "remove"; id: string }
  | ({ type: "snapshot" } & Partial<Infra>);

/**
 * How fast a link's flow moves. An explicit `speed` wins; then measured `latencyMs` (under 50 ms fast, under 250 ms
 * medium, else slow); then where the ends sit, see {@link placementSpeed}; with nothing to go on, medium.
 */
export function flowSpeed(e: Pick<Edge, "speed" | "latencyMs" | "from" | "to">, infra?: Infra): FlowSpeed {
  if (e.speed) return e.speed;
  if (e.latencyMs !== undefined) return e.latencyMs < 50 ? "fast" : e.latencyMs < 250 ? "medium" : "slow";
  return infra ? placementSpeed(infra, e.from, e.to) : "medium";
}

/**
 * Speed from the infrastructure itself: both ends inside the same network (a shared group below the top level, such
 * as a VPC or cluster) is fast; the same cloud or region but different networks is medium; across clouds, or to
 * anything outside every group (the internet, SaaS APIs), is slow. Two ungrouped ends give nothing to judge by: medium.
 */
export function placementSpeed(infra: Infra, from: string, to: string): FlowSpeed {
  const parentOf = new Map<string, string | undefined>([...infra.groups, ...infra.nodes].map((x) => [x.id, x.parent]));
  const chain = (id: string) => {
    const groups: string[] = [];
    for (let g = parentOf.get(id); g && !groups.includes(g); g = parentOf.get(g)) groups.push(g);
    return groups;
  };
  const below = chain(from);
  const above = new Set(chain(to));
  if (!below.length && !above.size) return "medium"; // no groups to judge by
  const shared = below.find((g) => above.has(g));
  if (!shared) return "slow";
  return parentOf.get(shared) ? "fast" : "medium";
}

export const edgeId = (from: string, to: string) => `${from}->${to}`;

/** Checks a parsed file and fills in defaults; throws with a message a person can act on. */
export function normalize(raw: unknown): Infra {
  const data = raw as Partial<Infra>;
  if (!data || typeof data !== "object") throw new Error("The file must hold an object with nodes, groups and edges.");
  const groups = (data.groups ?? []).map((g) => ({ ...g, label: g.label ?? g.id }));
  const nodes = (data.nodes ?? []).map((n) => ({ ...n, label: n.label ?? n.id, kind: n.kind ?? "generic", state: n.state ?? "ok" }));
  const ids = new Set([...groups.map((g) => g.id), ...nodes.map((n) => n.id)]);
  if (ids.size !== groups.length + nodes.length) throw new Error("Every node and group needs its own id.");
  for (const item of [...groups, ...nodes]) {
    if (!item.id) throw new Error(`A ${"kind" in item ? "node" : "group"} has no id.`);
    if (item.parent && !groups.some((g) => g.id === item.parent))
      throw new Error(`"${item.id}" sits in "${item.parent}", which is not a group.`);
  }
  const edges = (data.edges ?? []).map((e) => {
    for (const end of [e.from, e.to])
      if (!nodes.some((n) => n.id === end)) throw new Error(`Edge ${e.from} → ${e.to} names "${end}", which is not a node.`);
    return { ...e, id: e.id ?? edgeId(e.from, e.to), state: e.state ?? "ok" };
  });
  return { title: data.title, groups, nodes, edges };
}

/** Applies one update in place. Returns true when the topology changed and the layout must be redone. */
export function applyUpdate(infra: Infra, update: Update): boolean {
  switch (update.type) {
    case "node": {
      const { type, ...fields } = update;
      const node = infra.nodes.find((n) => n.id === update.id);
      if (node) {
        const moved = fields.parent !== undefined && fields.parent !== node.parent;
        Object.assign(node, fields, { metrics: { ...node.metrics, ...fields.metrics } });
        return moved;
      }
      if (!fields.kind) return false;
      infra.nodes.push({ label: update.id, state: "ok", ...fields, id: update.id, kind: fields.kind });
      return true;
    }
    case "edge": {
      const { type, ...fields } = update;
      const id = update.id ?? (update.from && update.to ? edgeId(update.from, update.to) : undefined);
      const edge = infra.edges.find((e) => e.id === id);
      if (edge) {
        Object.assign(edge, fields, { id: edge.id, from: edge.from, to: edge.to });
        return false;
      }
      if (!id || !update.from || !update.to) return false;
      if (![update.from, update.to].every((end) => infra.nodes.some((n) => n.id === end))) return false;
      infra.edges.push({ state: "ok", ...fields, id, from: update.from, to: update.to });
      return true;
    }
    case "group": {
      const { type, ...fields } = update;
      const group = infra.groups.find((g) => g.id === update.id);
      if (group) Object.assign(group, fields);
      else infra.groups.push({ label: update.id, ...fields, id: update.id });
      return true;
    }
    case "remove": {
      const before = infra.nodes.length + infra.edges.length + infra.groups.length;
      infra.edges = infra.edges.filter((e) => e.id !== update.id && e.from !== update.id && e.to !== update.id);
      infra.nodes = infra.nodes.filter((n) => n.id !== update.id);
      infra.groups = infra.groups.filter((g) => g.id !== update.id);
      return before !== infra.nodes.length + infra.edges.length + infra.groups.length;
    }
    case "snapshot": {
      const next = normalize({ ...infra, ...update });
      Object.assign(infra, next);
      return true;
    }
  }
}

/**
 * Nodes a highlight names. Each term, case-insensitive, matches a node's id or label, a kind or kind prefix (`aws`,
 * `aws.rds`, `k8s.deployment`), or a group's id or label (every node inside it). `issues` matches nodes that are not ok
 * and both ends of slow or broken links.
 */
export function highlighted(infra: Infra, terms: string[]): Set<string> {
  const groups = new Map(infra.groups.map((g) => [g.id, g]));
  const inGroup = (parent: string | undefined, term: string) => {
    for (let g = parent && groups.get(parent); g; g = g.parent ? groups.get(g.parent) : undefined)
      if (g.id.toLowerCase() === term || g.label.toLowerCase() === term) return true;
    return false;
  };
  const ids = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    if (term === "issues") {
      for (const n of infra.nodes) if ((n.state ?? "ok") !== "ok") ids.add(n.id);
      for (const e of infra.edges) if (e.state === "slow" || e.state === "broken") ids.add(e.from).add(e.to);
      continue;
    }
    for (const n of infra.nodes) {
      const kind = n.kind.toLowerCase();
      if (n.id.toLowerCase() === term || n.label.toLowerCase() === term || kind === term || kind.startsWith(`${term}.`) || inGroup(n.parent, term))
        ids.add(n.id);
    }
  }
  return ids;
}

/** `a, b,c` → `["a", "b", "c"]`. */
export const splitTerms = (text: string | null | undefined) => (text ?? "").split(",").map((t) => t.trim()).filter(Boolean);
