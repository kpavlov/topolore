import type { InfraNode } from "../lib/model.ts";

export type NodeEvent = "added" | "changed" | "removed";

/** Compare the rendered topology with the next replay state. */
export function nodeEvents(before: InfraNode[], after: InfraNode[]): Map<string, NodeEvent> {
  const old = new Map(before.map((node) => [node.id, node]));
  const next = new Map(after.map((node) => [node.id, node]));
  const events = new Map<string, NodeEvent>();
  for (const node of after) {
    const previous = old.get(node.id);
    if (!previous) events.set(node.id, "added");
    else if (JSON.stringify(previous) !== JSON.stringify(node)) events.set(node.id, "changed");
  }
  for (const node of before) if (!next.has(node.id)) events.set(node.id, "removed");
  return events;
}
