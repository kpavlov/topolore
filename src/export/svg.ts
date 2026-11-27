/** The scene as flat shapes in screen coordinates, and that drawing as a self-contained SVG. */
export type Point = [number, number];

export interface Drawing {
  width: number;
  height: number;
  theme: { bg: string; ink: string; muted: string; line: string };
  /** Plates, lowest first. */
  groups: { points: Point[]; fill: string; label: string; at: Point }[];
  edges: { points: Point[]; color: string; opacity: number; dashed: boolean }[];
  /** Farthest first, so nearer ones paint over them. */
  nodes: {
    side: Point[]; top: Point[]; color: string; opacity: number; dashed: boolean;
    ring?: string; badge?: { text: string; color: string };
    label: string; note?: string; at: Point;
  }[];
}

const escape = (text: string) =>
  text
    // XML 1.0 has no way to write most control characters, even escaped.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const path = (points: Point[]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

export function toSvg(drawing: Drawing): string {
  const { theme, groups, edges, nodes } = drawing;
  // The whole topology, even what is panned or zoomed out of view.
  const all = [...groups.flatMap((g) => g.points), ...edges.flatMap((e) => e.points), ...nodes.flatMap((n) => [...n.side, ...n.top, [n.at[0], n.at[1] + 30] as Point])];
  if (!all.length) all.push([0, 0], [drawing.width, drawing.height]);
  const bound = (axis: 0 | 1, pick: (a: number, b: number) => number) => all.reduce((m, p) => pick(m, p[axis]), all[0][axis]);
  const pad = 60;
  const x = bound(0, Math.min) - pad;
  const y = bound(1, Math.min) - pad;
  const w = bound(0, Math.max) + pad - x;
  const h = bound(1, Math.max) + pad - y;
  const text = (at: Point, value: string, size: number, color: string, extra = "") =>
    `<text x="${at[0].toFixed(1)}" y="${at[1].toFixed(1)}" font-size="${size}" fill="${color}" paint-order="stroke" stroke="${theme.bg}" stroke-width="3"${extra}>${escape(value)}</text>`;

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" font-family="IBM Plex Sans, system-ui, sans-serif">`,
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${theme.bg}"/>`,
  ];
  for (const g of groups) out.push(`<polygon points="${path(g.points)}" fill="${g.fill}" stroke="${theme.line}"/>`);
  for (const g of groups) out.push(text(g.at, g.label.toUpperCase(), 11, theme.muted, ' font-weight="600"'));
  for (const e of edges) {
    const [a, b] = [e.points.at(-3) ?? e.points[0], e.points.at(-2) ?? e.points.at(-1)!];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const corner = (turn: number, length: number): Point => [b[0] + Math.cos(angle + turn) * length, b[1] + Math.sin(angle + turn) * length];
    out.push(
      `<g opacity="${e.opacity}"><polyline points="${path(e.points)}" fill="none" stroke="${e.color}" stroke-width="2.2"${e.dashed ? ' stroke-dasharray="6 5"' : ""}/>` +
        `<polygon points="${path([corner(0, 5), corner(2.5, 6), corner(-2.5, 6)])}" fill="${e.color}"/></g>`,
    );
  }
  for (const n of nodes) {
    const outline = `stroke="${n.ring ?? (n.dashed ? n.color : theme.line)}" stroke-width="${n.ring ? 2.5 : 1}"${n.dashed ? ' stroke-dasharray="4 3"' : ""}`;
    const fill = n.dashed ? 'fill="none"' : `fill="${n.color}"`;
    out.push(
      `<g opacity="${n.opacity}"><polygon points="${path(n.side)}" ${fill} ${outline}/>` +
        (n.dashed ? "" : `<polygon points="${path(n.side)}" fill="#000000" opacity="0.18"/>`) +
        `<polygon points="${path(n.top)}" ${fill} ${outline}/>`,
    );
    out.push(text([n.at[0], n.at[1] + 12], n.label, 11, theme.ink, ' text-anchor="middle" font-weight="500"'));
    if (n.note) out.push(text([n.at[0], n.at[1] + 24], n.note, 10, n.ring ?? theme.muted, ' text-anchor="middle"'));
    if (n.badge) {
      const [bx, by] = [Math.max(...n.top.map((p) => p[0])), Math.min(...n.top.map((p) => p[1]))];
      out.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="9" fill="${n.badge.color}"/>`);
      out.push(`<text x="${bx.toFixed(1)}" y="${(by + 3.5).toFixed(1)}" font-size="10" font-weight="600" fill="#ffffff" text-anchor="middle">${escape(n.badge.text)}</text>`);
    }
    out.push("</g>");
  }
  out.push("</svg>");
  return out.join("\n");
}
