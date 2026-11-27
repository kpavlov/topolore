/** Just enough colouring for HCL, JSON and YAML. Returns pieces to render as text, never as HTML. */
const TOKEN =
  /((?<=^|\s)(?:#|\/\/)[^\n]*)|("(?:[^"\\\n]|\\.)*"(?=\s*:)|^[ \t]*(?:- )?[\w.-]+(?=\s*[:=]))|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(\b(?:true|false|null|\d+(?:\.\d+)?)\b)/gm;
const CLASSES = ["comment", "key", "string", "number"];

export function highlightCode(code: string): { text: string; cls?: string }[] {
  const pieces: { text: string; cls?: string }[] = [];
  let at = 0;
  for (const m of code.matchAll(TOKEN)) {
    if (m.index > at) pieces.push({ text: code.slice(at, m.index) });
    pieces.push({ text: m[0], cls: CLASSES[m.slice(1).findIndex((g) => g !== undefined)] });
    at = m.index + m[0].length;
  }
  if (at < code.length) pieces.push({ text: code.slice(at) });
  return pieces;
}
