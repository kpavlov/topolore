import { lookOf, type Category } from "../lib/catalog.ts";
import type { Infra } from "../lib/model.ts";

const TITLES: Record<Category, string> = {
  compute: "compute", data: "data", network: "network", messaging: "messaging", security: "security", external: "SaaS", edge: "clients",
};

/** Inside a quoted Mermaid label, these are written as entity codes. */
const escape = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[#"<>|`]/g, (c) => `#${c.charCodeAt(0)};`);

/** A `graph TD` flowchart with one subgraph per category. */
export function toMermaid(infra: Infra): string {
  // Mermaid ids cannot hold most punctuation, and some words are reserved: number the nodes.
  const ids = new Map(infra.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["graph TD"];
  for (const category of Object.keys(TITLES) as Category[]) {
    const members = infra.nodes.filter((n) => lookOf(n.kind).category === category);
    if (!members.length) continue;
    lines.push(`  subgraph cat_${category}["${TITLES[category]}"]`);
    for (const n of members) lines.push(`    ${ids.get(n.id)}["${escape(n.label)}"]`);
    lines.push("  end");
  }
  for (const e of infra.edges) {
    const text = e.protocol && e.protocol !== "network" ? e.protocol : e.label;
    lines.push(`  ${ids.get(e.from)} ${e.undirected ? "---" : "-->"}${text ? `|"${escape(text)}"|` : ""} ${ids.get(e.to)}`);
  }
  return `${lines.join("\n")}\n`;
}
