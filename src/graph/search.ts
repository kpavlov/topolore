import { lookOf } from "../lib/catalog.ts";
import type { Infra, InfraNode, NodeState } from "../lib/model.ts";

const SPOKEN: Record<NodeState, string> = { ok: "healthy", degraded: "degraded", down: "down", fire: "on fire", unknown: "unknown" };

/** How well `term` matches `text`: exact, prefix, substring, then letters in order and close together. */
function score(term: string, text: string): number {
  if (text === term) return 100;
  const at = text.indexOf(term);
  if (at >= 0) return at === 0 ? 80 : 60;
  if (term.length < 2) return 0;
  for (let start = text.indexOf(term[0]); start >= 0; start = text.indexOf(term[0], start + 1)) {
    let end = start;
    for (let i = 1; i < term.length && end >= 0; i++) end = text.indexOf(term[i], end + 1);
    const span = end - start + 1;
    if (end >= 0 && span <= term.length * 3) return 40 - Math.min(30, span - term.length);
  }
  return 0;
}

/** Nodes matching a query by name, id, type, category, status or source file, best first. */
export function searchNodes(infra: Infra, query: string, limit = 50): InfraNode[] {
  const text = query.trim().toLowerCase();
  if (!text) return infra.nodes.slice(0, limit);
  const ranked = infra.nodes.flatMap((n) => {
    const state = n.state ?? "ok";
    // Earlier fields count for more.
    const fields = [n.label, n.id, n.kind, String(n.props?.terraform ?? ""), lookOf(n.kind).category, state, SPOKEN[state] ?? "", n.sourceFile ?? ""]
      .map((f) => f.toLowerCase());
    const best = (term: string) => Math.max(0, ...fields.map((f, i) => (f ? score(term, f) * (1 - i * 0.05) : 0)));
    // The whole query first ("on fire"), else every word must match something.
    const words = text.split(/\s+/).map(best);
    const total = best(text) || (words.every(Boolean) ? words.reduce((a, b) => a + b, 0) / words.length : 0);
    return total ? [{ n, total }] : [];
  });
  return ranked.sort((a, b) => b.total - a.total || a.n.label.localeCompare(b.n.label)).slice(0, limit).map((r) => r.n);
}
