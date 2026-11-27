import type { Drawing } from "./svg.ts";

export interface LegendEntry {
  label: string;
  color: string;
}

/**
 * Puts what the WebGL canvas lacks onto a captured frame: node and plate labels (HTML on screen), badges, the legend
 * and a watermark. `frame` is the render at `scale` device pixels per CSS pixel.
 */
export function composePng(frame: HTMLCanvasElement, drawing: Drawing, legend: LegendEntry[], scale: number): Promise<Blob> {
  const ctx = frame.getContext("2d")!;
  const { theme, width, height } = drawing;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const write = (value: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "center") => {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = theme.bg;
    ctx.strokeText(value, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  const sans = (size: number, weight = 500) => `${weight} ${size}px "IBM Plex Sans", system-ui, sans-serif`;
  for (const g of drawing.groups) write(g.label.toUpperCase(), g.at[0], g.at[1], sans(11, 600), theme.muted, "left");
  for (const n of drawing.nodes) {
    ctx.globalAlpha = n.opacity;
    write(n.label, n.at[0], n.at[1] + 12, sans(11), theme.ink);
    if (n.note) write(n.note, n.at[0], n.at[1] + 24, sans(10, 600), n.ring ?? theme.muted);
    if (n.badge) {
      const x = Math.max(...n.top.map((p) => p[0]));
      const y = Math.min(...n.top.map((p) => p[1]));
      ctx.fillStyle = n.badge.color;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = sans(10, 600);
      ctx.textAlign = "center";
      ctx.fillText(n.badge.text, x, y + 3.5);
    }
    ctx.globalAlpha = 1;
  }
  let x = 14;
  for (const entry of legend) {
    ctx.fillStyle = entry.color;
    ctx.beginPath();
    ctx.arc(x + 4, height - 18, 4, 0, Math.PI * 2);
    ctx.fill();
    write(entry.label, x + 12, height - 14, sans(11), theme.muted, "left");
    x += ctx.measureText(entry.label).width + 28;
  }
  write("Generated with Topolore", width - 14, height - 32, sans(11), theme.muted, "right");
  return new Promise((resolve, reject) => frame.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The browser could not make a PNG."))), "image/png"));
}
