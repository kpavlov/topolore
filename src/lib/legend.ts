/** The legend, which doubles as the filter: each entry's term is one `highlighted()` understands. */
export interface LegendItem {
  term: string;
  label: string;
  /** CSS custom property that colours the dot. */
  color: string;
}

export const STATE_LEGEND: LegendItem[] = [
  { term: "state:fire", label: "on fire", color: "--fire" },
  { term: "state:down", label: "down / broken", color: "--crit" },
  { term: "state:degraded", label: "degraded / slow", color: "--warn" },
  { term: "state:ok", label: "healthy", color: "--ok" },
];

export const CATEGORY_LEGEND: LegendItem[] = (
  [["compute", "compute"], ["data", "data"], ["network", "network"], ["messaging", "messaging"], ["security", "security"], ["external", "SaaS"]] as const
).map(([category, label]) => ({ term: `category:${category}`, label, color: `--cat-${category}` }));

export const isLegendTerm = (term: string) => /^(state|category):/i.test(term);

/** A click isolates an entry; with a modifier it joins or leaves the existing filters. */
export function toggleFilter(terms: string[], term: string, add: boolean): string[] {
  const other = terms.filter((t) => !isLegendTerm(t));
  const active = terms.filter(isLegendTerm);
  const has = active.includes(term);
  if (add) return [...other, ...(has ? active.filter((t) => t !== term) : [...active, term])];
  return [...other, ...(has && active.length === 1 ? [] : [term])];
}
