import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Infra } from "./model.ts";

/** A footprint on the ground plane, centred, in world units. `level` counts the plates underneath. */
export interface Placed {
  x: number;
  z: number;
  w: number;
  d: number;
  level: number;
}

export interface Layout {
  nodes: Map<string, Placed>;
  groups: Map<string, Placed>;
  size: number;
}

export const NODE = 40;
const elk = new ELK();

/** Lays the graph out flat with ELK (groups nest, edges run left to right); the scene lifts it into 3D. */
export async function layout(infra: Infra): Promise<Layout> {
  const elkNodes = new Map<string, ElkNode>();
  for (const g of infra.groups)
    elkNodes.set(g.id, {
      id: g.id,
      children: [],
      layoutOptions: { "elk.padding": "[top=46,left=26,bottom=26,right=26]", "elk.nodeSize.minimum": "(120,80)" },
    });
  for (const n of infra.nodes) elkNodes.set(n.id, { id: n.id, width: NODE + 32, height: NODE + 40 });

  const root: ElkNode = {
    id: "__root",
    children: [],
    edges: infra.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "34",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.spacing.componentComponent": "60",
    },
  };
  for (const item of [...infra.groups, ...infra.nodes]) {
    const parent = item.parent ? elkNodes.get(item.parent)! : root;
    parent.children!.push(elkNodes.get(item.id)!);
  }

  const done = await elk.layout(root);
  const result: Layout = { nodes: new Map(), groups: new Map(), size: Math.max(done.width ?? 0, done.height ?? 0) };
  const groupIds = new Set(infra.groups.map((g) => g.id));
  const cx = (done.width ?? 0) / 2;
  const cz = (done.height ?? 0) / 2;
  const visit = (node: ElkNode, ox: number, oy: number, level: number) => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      const w = child.width ?? 0;
      const h = child.height ?? 0;
      if (groupIds.has(child.id)) {
        result.groups.set(child.id, { x: x + w / 2 - cx, z: y + h / 2 - cz, w, d: h, level });
        visit(child, x, y, level + 1);
      } else {
        result.nodes.set(child.id, { x: x + w / 2 - cx, z: y + h / 2 - cz - 6, w: NODE, d: NODE, level });
      }
    }
  };
  visit(done, 0, 0, 0);
  return result;
}
